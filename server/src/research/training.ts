/**
 * 训练治理 v2（P1，improvement-plan §3.3/§3.4）：
 * - 标签/阈值在对数收益空间：R = log(P(t+H)/P(t))；事件模型用指数价序列；
 * - 历史范围升序分页采集（readHistoricalRange），训练前先补历史（backfillRange，REST 限速）；
 * - 样本按「不重叠目标窗口」计数；时间顺序划分 + 跨分区标签窗口 purge（间隔 ≥ 前瞻窗口）；
 * - 状态机 training → candidate → published（校准确认后）→ retired（旧 ready/stale 已迁移为 retired）：
 *   样本外门槛 = 样本量 + Brier 优于频率基线且分块 bootstrap 95% 改善下界>0 + ECE≤0.05
 *   + 90% 区间覆盖 85–95%。门槛通过仅到 candidate；published 必须再过显式分布校准确认
 *   （confirmCalibrationAndPublish，管理端触发），避免补齐历史后自动放开概率能力。
 * - trainedUntil = 最后样本标签结束时间（而非入场时间）：模型选择用它做 asOf 门控，
 *   保证 asOf 时刻全部标签数据已可得；发布时间门控由 publishedAt 单独承担。
 * - 1w 与其他期限同一门槛（方向研究模型，return_positive；研究模式标识由产品层展示）。
 * 门槛=初始工程配置（policy-v1）。
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../db.js'
import { predictionModels } from '../models.js'
import { readHistoricalRange } from '../services/marketSnapshot.js'
import { durationRangeForHorizon } from '../services/prediction.js'
import { backfillRange } from '../market/backfill.js'
import { predict as pyPredict, train as pyTrain } from '../researchpy.js'
import { kv, log } from '../logger.js'
import { HORIZON_FORWARD_BARS, baseIntervalFor, featureVersionFor, featuresAt } from './features.js'
import type { ResearchHorizonName } from './features.js'

export const VALIDATION_POLICY_VERSION = 'policy-v1'

/** 初始工程门槛（improvement-plan §3.3 表；数据不足保持不可用，不以高重叠样本凑数） */
const GATE: Record<string, { months: number; dev: number; cal: number; test: number }> = {
  '10m': { months: 12, dev: 1000, cal: 500, test: 500 },
  '30m': { months: 12, dev: 1000, cal: 500, test: 500 },
  '1h': { months: 12, dev: 1000, cal: 500, test: 500 },
  '1d': { months: 24, dev: 180, cal: 90, test: 90 },
  '1w': { months: 60, dev: 104, cal: 26, test: 26 },
}

export interface TrainJobInput {
  modelVersion: string
  horizon: string
  symbol?: string
  marketType?: 'spot' | 'usdm_perp'
  /** strike_relative（事件，指数价）| return_positive（方向研究，成交价） */
  targetType?: 'strike_relative' | 'return_positive'
}

export async function executeTrainJob(input: TrainJobInput): Promise<{ modelVersion: string; trainedRows: number; status: string }> {
  const db = getDb()
  if (!db) throw new Error('数据库不可用')
  const symbol = input.symbol ?? 'BTCUSDT'
  const marketType = input.marketType ?? 'usdm_perp'
  const targetType = input.targetType ?? 'strike_relative'
  const horizon = input.horizon as ResearchHorizonName
  const gate = GATE[horizon] ?? GATE['1h']
  const baseInterval = baseIntervalFor(horizon)
  const forwardBars = HORIZON_FORWARD_BARS[horizon]
  const priceType = targetType === 'strike_relative' ? 'index' : 'trade'
  const featureVersion = featureVersionFor(horizon, targetType)

  // 1) 历史范围：先补采（REST 限速分页；失败时用库内现有数据并继续）
  const to = Date.now()
  const from = to - gate.months * 30.4 * 24 * 3600_000
  const series = { marketType, priceType: priceType as 'trade', symbol, interval: baseInterval as '1m' }
  await backfillRange(series, from, to).catch((err: Error) => {
    log.warn('model', '历史补采失败（用现有数据继续）', kv({ 错误: err.message.slice(0, 160) }))
  })
  const bars = await readHistoricalRange({ marketType, priceType, symbol, interval: baseInterval, from, to })
  if (bars.length < 260 + forwardBars) {
    throw new Error(`${baseInterval}/${priceType} 历史不足（${bars.length} 根）：先完成历史补采再训练`)
  }

  // 2) 对数收益特征 + 标签（事件模型含 remaining_seconds=完整期限；推理按实际剩余传入）
  type Row = { features: Record<string, number>; labelReturn: number; split: 'dev' | 'calibration' | 'test'; entryTime: number; labelEnd: number }
  const rows: Row[] = []
  const stepBars = Math.max(1, forwardBars)
  const closes = bars.map((b) => b.c)
  const times = bars.map((b) => b.t)
  // 剩余期限在容差窗 [0.8T, 1.2T] 内采样（标签与 remaining_seconds 同步取同一时长）：
  // 模型由此真正学到「剩余时间 → 分布」的映射，注册的 validatedDurationRange 才有依据。
  const fullBars = forwardBars
  const minBars = Math.max(1, Math.round(fullBars * 0.8))
  const maxBars = Math.round(fullBars * 1.2)
  const barSec = baseInterval === '1m' ? 60 : 3600
  for (let i = 240; i + maxBars < closes.length; i += stepBars) {
    const r = minBars + Math.floor(Math.random() * (maxBars - minBars + 1))
    const entry = closes[i]
    const exit = closes[i + r]
    if (entry <= 0 || exit <= 0) continue
    const feats = featuresAt(closes, i)
    if (feats === null) continue
    if (targetType === 'strike_relative') feats.remaining_seconds = r * barSec
    rows.push({ features: feats, labelReturn: Math.log(exit / entry), split: 'dev', entryTime: times[i], labelEnd: times[i + r] })
  }
  const total = gate.dev + gate.cal + gate.test
  if (rows.length < total) {
    throw new Error(
      `不重叠目标窗口样本不足：${rows.length} < ${total}（dev${gate.dev}/cal${gate.cal}/test${gate.test}；历史 ${bars.length} 根 ${baseInterval}/${priceType} ≈ ${(bars.length / (baseInterval === '1m' ? 1440 : 24) / 30.4).toFixed(1)} 个月，目标 ${gate.months} 个月）——保持不可用`,
    )
  }

  // 3) 时间划分 + 跨分区标签 purge（边界间隔 ≥ 前瞻窗口）
  const horizonMs = forwardBars * (baseInterval === '1m' ? 60_000 : 3_600_000)
  const nDev = Math.floor(rows.length * 0.6)
  const nCal = Math.floor(rows.length * 0.2)
  const boundary1 = rows[nDev - 1].entryTime
  const boundary2 = rows[nDev + nCal - 1].entryTime
  const kept: Row[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    r.split = i < nDev ? 'dev' : i < nDev + nCal ? 'calibration' : 'test'
    const b = r.split === 'dev' ? boundary1 : r.split === 'calibration' ? boundary2 : Number.MAX_SAFE_INTEGER
    if (r.labelEnd >= b + horizonMs) continue
    kept.push(r)
  }
  const counts = {
    dev: kept.filter((r) => r.split === 'dev').length,
    calibration: kept.filter((r) => r.split === 'calibration').length,
    test: kept.filter((r) => r.split === 'test').length,
  }

  // 4) 注册表占位 training（含治理字段）；trainedUntil 用最后样本标签结束时间
  //    （asOf 门控语义：该时刻前全部标签数据已可得，历史回放不使用未来数据）
  const range = durationRangeForHorizon(horizon)
  const existing = await db.select().from(predictionModels).where(eq(predictionModels.modelVersion, input.modelVersion)).limit(1)
  const baseCols = {
    horizon,
    trainedUntil: kept[kept.length - 1].labelEnd,
    featureVersion,
    baseInterval,
    status: 'training',
    symbol, marketType, priceType, targetType,
    validatedDurationRange: range,
    validationPolicyVersion: VALIDATION_POLICY_VERSION,
  }
  if (existing.length === 0) await db.insert(predictionModels).values({ modelVersion: input.modelVersion, ...baseCols })
  else await db.update(predictionModels).set({ ...baseCols, updatedAt: new Date() }).where(eq(predictionModels.modelVersion, input.modelVersion))

  // 5) 训练
  const res = await pyTrain({
    modelVersion: input.modelVersion, horizon, featureVersion,
    rows: kept.map((r) => ({ features: r.features, labelReturn: r.labelReturn, split: r.split })),
  })

  // 6) 样本外门槛（test）：Brier vs 频率基线 + 分块 bootstrap 下界 + ECE + 90% 覆盖
  const testRows = kept.filter((r) => r.split === 'test')
  const pred = await pyPredict({ modelVersion: input.modelVersion, rows: testRows.map((r) => ({ features: r.features })) })
  const probs = pred.predictions.map((p) => p.probabilityUp)
  const labels: number[] = testRows.map((r) => (r.labelReturn > 0 ? 1 : 0))
  const brier = probs.reduce((a, p, i) => a + (p - labels[i]) ** 2, 0) / Math.max(1, probs.length)
  // 频率基线只用 dev 拆分估计（用 test 标签估计基线本身即是泄漏）；
  // 常数预测 p̂=π 的 Brier = π(1−π)（无 ×4：那是误把上界当基线）
  const devLabels: number[] = kept.filter((r) => r.split === 'dev').map((r) => (r.labelReturn > 0 ? 1 : 0))
  const baseRate = devLabels.reduce((a, b) => a + b, 0) / Math.max(1, devLabels.length)
  const brierBaseline = baseRate * (1 - baseRate)
  const improvement = brierBaseline - brier
  const diffs = probs.map((p, i) => (baseRate - labels[i]) ** 2 - (p - labels[i]) ** 2)
  const boots: number[] = []
  const B = 200
  const block = 50
  for (let b = 0; b < B; b++) {
    let s = 0
    let n = 0
    while (n < diffs.length) {
      const start = Math.floor(Math.random() * Math.max(1, diffs.length - block))
      for (let k = 0; k < block && start + k < diffs.length; k++) {
        s += diffs[start + k]
        n++
      }
    }
    boots.push(s / Math.max(1, n))
  }
  boots.sort((a, b) => a - b)
  const ciLow = boots[Math.floor(B * 0.05)]
  const buckets = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }))
  probs.forEach((p, i) => {
    const b = Math.min(9, Math.floor(p * 10))
    buckets[b].n++; buckets[b].p += p; buckets[b].y += labels[i]
  })
  const ece = buckets.reduce((a, b) => a + (b.n > 0 ? (b.n / Math.max(1, probs.length)) * Math.abs(b.p / b.n - b.y / b.n) : 0), 0)
  const withBand = testRows.map((_, i) => pred.predictions[i]).filter((p) => p.quantiles['0.05'] !== undefined && p.quantiles['0.95'] !== undefined)
  const covered = testRows.filter((r, i) => {
    const lo = pred.predictions[i].quantiles['0.05']
    const hi = pred.predictions[i].quantiles['0.95']
    return lo !== undefined && hi !== undefined && r.labelReturn >= lo && r.labelReturn <= hi
  }).length
  const coverage = withBand.length > 0 ? covered / withBand.length : 0

  const metrics: Record<string, number> = {
    trainedRows: res.trainedRows,
    devRows: counts.dev, calRows: counts.calibration, testRows: counts.test,
    testBrier: Number(brier.toFixed(6)), brierBaseline: Number(brierBaseline.toFixed(6)),
    improvement: Number(improvement.toFixed(6)), bootstrapCiLow: Number(ciLow.toFixed(6)),
    ece: Number(ece.toFixed(6)), q90Coverage: Number(coverage.toFixed(6)),
  }
  const gateFails: string[] = []
  if (counts.test < gate.test) gateFails.push(`test 样本 ${counts.test} < ${gate.test}`)
  if (counts.calibration < gate.cal) gateFails.push(`calibration 样本 ${counts.calibration} < ${gate.cal}`)
  if (counts.dev < gate.dev) gateFails.push(`dev 样本 ${counts.dev} < ${gate.dev}`)
  if (!(improvement > 0 && ciLow > 0)) gateFails.push(`Brier 未优于频率基线或 bootstrap 下界≤0（imp=${improvement.toFixed(4)}, ciLow=${ciLow.toFixed(4)}）`)
  if (ece > 0.05) gateFails.push(`ECE ${ece.toFixed(4)} > 0.05`)
  if (coverage < 0.85 || coverage > 0.95) gateFails.push(`90% 区间覆盖 ${(coverage * 100).toFixed(1)}% 不在 [85%,95%]`)
  // 校准映射闭环：isotonic 未拟合（calibration 样本不足或退化）→ 工件无映射，
  // 指标再好也只是原始模型——不得进入 candidate（发布确认还会对工件再验一次）
  if (res.calibrated !== true) gateFails.push(`isotonic 校准映射未拟合（calRows=${res.calibrationRows ?? 0}）：工件不含校准映射，不得作为 candidate`)

  // 数值门槛通过只到 candidate：published 需要显式分布校准确认
  // （confirmCalibrationAndPublish，管理端触发），分布校准未完成前概率能力保持关闭。
  // 门槛未过 → retired（明确不可用；只有过门槛的 candidate 才允许被校准确认发布）。
  const finalStatus = gateFails.length === 0 ? 'candidate' : 'retired'
  await db
    .update(predictionModels)
    .set({ status: finalStatus, metrics, artifactPath: res.artifactPath, updatedAt: new Date() })
    .where(eq(predictionModels.modelVersion, input.modelVersion))
  log.ok(
    'model',
    gateFails.length === 0
      ? '模型通过样本外门槛（candidate，待分布校准确认后发布）'
      : `模型训练完成但样本外门槛未过（${finalStatus}，不可发布）`,
    kv({
      模型: input.modelVersion, 期限: horizon, 目标: targetType, 基础: baseInterval,
      样本: res.trainedRows, test: counts.test, brier: brier.toFixed(4), 基线: brierBaseline.toFixed(4),
      ece: ece.toFixed(4), 覆盖: (coverage * 100).toFixed(1) + '%', 未过: gateFails.join('；').slice(0, 240),
    }),
  )
  return { modelVersion: input.modelVersion, trainedRows: res.trainedRows, status: finalStatus }
}

/**
 * 分布校准确认 + 发布（P1 门控）：四重代码验证都通过才 published——
 * 1. 状态必须是 candidate（数值门槛通过且 isotonic 映射已拟合的训练产物）；
 * 2. 注册表 metrics 复验：ECE / 90% 区间覆盖 / Brier 改善与 bootstrap 下界 / 样本量
 *    必须存在且在门槛内（不信任 status 单独放行——手工改库或指标缺失即拒绝）；
 * 3. 校准映射绑定：工件本身携带 isotonic 分位 level 重映射（calibration split 拟合、
 *    按 modelVersion 寻址即绑定该模型），映射拟合样本 ≥ 门槛——无映射的原始模型
 *    即使指标达标也不得发布；
 * 4. 工件可用性：research-py /tasks/predict 能加载该模型工件并返回校准后网格
 *    （推理端概率内插全部经校准映射）。
 * 通过后 publishedAt 与 calibratedAt 落库并回写 metrics.calibrationConfirmedAt
 * （确认时刻可追溯）。publishedAt 参与推理的 asOf 门控。
 */
export async function confirmCalibrationAndPublish(modelVersion: string): Promise<{ ok: boolean; reason: string }> {
  const db = getDb()
  if (!db) throw new Error('数据库不可用')
  const rows = await db.select().from(predictionModels).where(eq(predictionModels.modelVersion, modelVersion)).limit(1)
  const m = rows[0]
  if (m === undefined) return { ok: false, reason: '模型不存在' }
  if (m.status === 'published') return { ok: false, reason: '模型已是 published（幂等拒绝）' }
  if (m.status !== 'candidate') return { ok: false, reason: `状态为 ${m.status}：只有通过样本外门槛的 candidate 可确认校准` }

  // 校准产物复验：训练时落库的分布校准指标（ECE=校准误差、q90Coverage=分位覆盖）
  const metrics = (m.metrics ?? {}) as Record<string, number>
  const gate = GATE[m.horizon as keyof typeof GATE] ?? GATE['1h']
  const missing: string[] = []
  const num = (k: string): number | null => (typeof metrics[k] === 'number' && Number.isFinite(metrics[k]) ? metrics[k] : null)
  const ece = num('ece')
  const coverage = num('q90Coverage')
  const improvement = num('improvement')
  const ciLow = num('bootstrapCiLow')
  const testRows = num('testRows')
  const calRows = num('calRows')
  if (ece === null) missing.push('ece（校准误差）')
  if (coverage === null) missing.push('q90Coverage（分位覆盖）')
  if (improvement === null) missing.push('improvement（Brier 改善）')
  if (ciLow === null) missing.push('bootstrapCiLow（改善下界）')
  if (testRows === null) missing.push('testRows')
  if (calRows === null) missing.push('calRows')
  if (missing.length > 0) {
    return { ok: false, reason: `校准产物缺失：注册表 metrics 缺少 ${missing.join('、')}——分布校准未完成（或产物未落库），不得发布` }
  }
  const fails: string[] = []
  if (ece! > 0.05) fails.push(`ECE ${ece!.toFixed(4)} > 0.05`)
  if (coverage! < 0.85 || coverage! > 0.95) fails.push(`90% 区间覆盖 ${(coverage! * 100).toFixed(1)}% 不在 [85%,95%]`)
  if (!(improvement! > 0 && ciLow! > 0)) fails.push(`Brier 改善 ${improvement!.toFixed(4)} / bootstrap 下界 ${ciLow!.toFixed(4)} 不达标`)
  if (testRows! < gate.test) fails.push(`test 样本 ${testRows!} < ${gate.test}`)
  if (calRows! < gate.cal) fails.push(`calibration 样本 ${calRows!} < ${gate.cal}`)
  if (fails.length > 0) {
    return { ok: false, reason: `校准产物复验未通过：${fails.join('；')}` }
  }

  // 工件可用性 + 校准映射绑定验证：research-py 能加载工件、且工件本身携带
  // isotonic 校准映射（按 modelVersion 寻址即绑定该模型）、映射拟合样本达标——
  // 无映射的原始模型即使指标达标也不得发布；推理端 predict 输出校准后网格
  try {
    const probe = await pyPredict({ modelVersion, rows: [{ features: {} }] })
    const cal = probe.calibration ?? null
    if (cal === null || cal.kind !== 'isotonic') {
      return { ok: false, reason: '工件未绑定校准映射（calibration=null）：isotonic 未完成或未随工件持久化，推理未应用映射，不得发布' }
    }
    if (cal.calRows < gate.cal) {
      return { ok: false, reason: `校准映射拟合样本 ${cal.calRows} < ${gate.cal}（映射不可信），不得发布` }
    }
  } catch (err) {
    return { ok: false, reason: `工件可用性验证失败（research-py 无法加载/预测该模型）：${(err as Error).message.slice(0, 160)}` }
  }

  const now = new Date()
  await db
    .update(predictionModels)
    .set({
      status: 'published',
      publishedAt: now,
      calibratedAt: now,
      metrics: { ...metrics, calibrationConfirmedAt: now.getTime() },
      updatedAt: now,
    })
    .where(eq(predictionModels.modelVersion, modelVersion))
  log.ok('model', '分布校准确认（metrics 复验 + 工件验证通过），模型发布（published）', kv({ 模型: modelVersion, 发布时刻: now.toISOString() }))
  return { ok: true, reason: 'published' }
}

/** 训练失败置 retired（管理员可见；原因在 worker 日志） */
export async function markTrainFailed(modelVersion: string, reason: string): Promise<void> {
  const db = getDb()
  if (!db) return
  await db.update(predictionModels).set({ status: 'retired', updatedAt: new Date() }).where(eq(predictionModels.modelVersion, modelVersion)).catch(() => {})
  log.warn('model', '训练失败（retired）', kv({ 模型: modelVersion, 原因: reason.slice(0, 200) }))
}
