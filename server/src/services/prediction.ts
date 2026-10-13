/**
 * PredictionService（P1，improvement-plan §3.1/§3.2）：
 * - 目标区分：strike_relative（事件：到期指数价相对固定执行价）/ return_positive（方向研究）；
 * - 事件阈值 = log(strike / indexRef)；概率由分位数 CDF 内插；
 *   阈值落在未验证的分布尾部 → unavailable（tail_unvalidated），不得截成 0/100%；
 *   三分支互斥：pUp=P(高于平价区间上界)、pTie=P(平价区间)、pDown=1−pUp−pTie（同一结算规则）；
 * - 事件特征含实际 remainingSeconds；模型选择按 symbol/marketType/priceType/targetType/
 *   featureVersion（含基础周期）/baseInterval/validatedDurationRange/标签结束时间与发布时间
 *   双时点门控（禁止跨币种、禁止回放当时尚未发布的模型）；
 * - 分位点默认网格 [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95]（research-py/app/modeling.py 训练默认，
 *   单调修正后由 research-py 保证），超出网格覆盖范围的阈值 → null（tail_unvalidated），
 *   平价精度未知时 pTie 不假设为 0。
 */
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '../db.js'
import { predictionModels } from '../models.js'
import { predict as pyPredict } from '../researchpy.js'
import type { PyPredictResponse } from '../researchpy.js'
import { baseIntervalFor, featureVersionFor, featuresAt } from '../research/features.js'
import { kv, log } from '../logger.js'
import type { PredictionStats, PredictionStatsTrack } from 'biance-vision-brooks'

export type TargetType = 'strike_relative' | 'return_positive'

export type PredictionUnavailableCode =
  | 'model_not_published'
  | 'horizon_unvalidated'
  | 'target_mismatch'
  | 'stale_market'
  | 'tail_unvalidated'
  | 'feature_missing'
  | 'inference_failed'
  | 'remaining_out_of_range'

export interface PredictRequest {
  symbol: string
  marketType: 'spot' | 'usdm_perp'
  horizon: string
  asOf: number
  targetType: TargetType
  /** 事件：执行价（strike_relative 必填）；参考价（指数）由调用方传入 */
  strikePrice?: number
  indexRefPrice?: number
  /** 实际剩余时间（秒）：训练与推理同特征，不得复用完整期限 */
  remainingSeconds?: number
  /** 基础周期收盘序列（由冻结快照提供，保持因果） */
  closes: number[]
}

export interface PredictOutcome {
  available: true
  /** 已知结算精度：P(高于平价区间上界)；精度未知：P(高于执行价)（仅研究展示，EV 禁用） */
  probabilityUp: number
  /** P(|结算价−执行价| < 半个结算精度)，仅当结算精度已知时非空 */
  probabilityTie: number | null
  quantiles: Record<string, number>
  modelVersion: string
  featureVersion: string
  baseInterval: string
  targetType: TargetType
  thresholdLog: number
  /** 推理实际使用的特征向量（随预测记录冻结，可复现） */
  features: Record<string, number>
}

export interface PredictUnavailable {
  available: false
  code: PredictionUnavailableCode
  detail: string
}

/** 事件结算精度（App 真实规则未知时为 null → 平价概率不可算，EV 不可用） */
const EVENT_SETTLEMENT_PRECISION = Number(process.env.EVENT_SETTLEMENT_PRECISION ?? '') || null

/** 历史研究的已验证时长范围（模型族内剩余期限容差窗口，秒）；训练时写入注册表 */
export function durationRangeForHorizon(horizon: string): { minSec: number; maxSec: number } {
  const sec: Record<string, number> = { '10m': 600, '30m': 1800, '1h': 3600, '1d': 86400, '1w': 604800 }
  const full = sec[horizon] ?? 600
  // 20% 容差：模型必须验证 [0.8×T, 1.2×T] 的时长范围
  return { minSec: Math.round(full * 0.8), maxSec: Math.round(full * 1.2) }
}

/** 分位数 CDF 内插求 P(R > threshold)；阈值越出网格首尾覆盖（默认 [0.05, 0.95]）→ null（尾部未验证） */
export function probAboveFromQuantileGrid(quantiles: Record<string, number>, threshold: number): number | null {
  const pts = Object.entries(quantiles)
    .map(([k, v]) => ({ q: Number(k), v }))
    .filter((p) => Number.isFinite(p.q) && Number.isFinite(p.v))
    .sort((a, b) => a.q - b.q)
  if (pts.length < 3) return null
  if (threshold < pts[0].v || threshold > pts[pts.length - 1].v) return null // tail_unvalidated
  if (threshold === pts[pts.length - 1].v) return 1 - pts[pts.length - 1].q
  for (let i = 1; i < pts.length; i++) {
    if (threshold <= pts[i].v) {
      const span = pts[i].v - pts[i - 1].v
      const frac = span > 0 ? (threshold - pts[i - 1].v) / span : 0
      const f = pts[i - 1].q + frac * (pts[i].q - pts[i - 1].q)
      return Math.min(1, Math.max(0, 1 - f))
    }
  }
  return null
}

/**
 * 三分支互斥概率（纯函数，隔离可测）：已知结算精度时
 *   pUp  = P(R > log((strike+半步长)/index))（严格高于平价区间上界，不含平价）
 *   pTie = P(下阈值 < R ≤ 上阈值)（单调分布下 = P(R>下阈值) − P(R>上阈值)）
 *   pDown = 1 − pUp − pTie（由调用方组合）
 * pUp 若取执行价中心阈值，会把平价区间上半计入「涨」而 pDown 又把下半计入「跌」，
 * 平价被双重计入会制造虚假正 EV——必须从同一结算规则生成互斥分支。
 * 任一阈值越出分位覆盖 → null（tail_unvalidated，不得截断）。
 */
export function mutuallyExclusiveThreeWay(
  quantiles: Record<string, number>,
  strikePrice: number,
  indexRefPrice: number,
  precision: number,
): { probabilityUp: number; probabilityTie: number } | null {
  const halfTick = precision / 2
  const aboveUpper = probAboveFromQuantileGrid(quantiles, Math.log((strikePrice + halfTick) / indexRefPrice))
  const aboveLower = probAboveFromQuantileGrid(quantiles, Math.log((strikePrice - halfTick) / indexRefPrice))
  if (aboveUpper === null || aboveLower === null) return null
  return {
    probabilityUp: aboveUpper,
    probabilityTie: Math.max(0, Math.min(1 - aboveUpper, aboveLower - aboveUpper)),
  }
}

export async function predictForTarget(req: PredictRequest): Promise<PredictOutcome | PredictUnavailable> {
  const db = getDb()
  if (!db) return { available: false, code: 'stale_market', detail: '数据库不可用' }

  // 特征（含事件剩余时间）：缺少必需特征显式不可用，不静默补零
  const i = req.closes.length - 1
  const base = featuresAt(req.closes, i)
  if (base === null || req.closes.length < 240) {
    return { available: false, code: 'feature_missing', detail: `特征窗口数据不足（${req.closes.length} 根 < 240）` }
  }
  const features: Record<string, number> = { ...base }
  if (req.targetType === 'strike_relative') {
    if (req.remainingSeconds === undefined) {
      return { available: false, code: 'horizon_unvalidated', detail: '事件预测缺少实际剩余时间（不得复用完整期限）' }
    }
    features.remaining_seconds = req.remainingSeconds
  }
  // 特征版本按目标类型 + 基础周期编码（事件含 remaining_seconds，与方向研究不同特征空间；
  // 周期进版本门控：同名 ret_60 在 1m 与 1h 上分别是 60 分钟与 60 小时，禁止错配）
  const featureVersion = featureVersionFor(req.horizon, req.targetType)
  const baseInterval = baseIntervalFor(req.horizon)
  const priceType = req.targetType === 'strike_relative' ? 'index' : 'trade'

  // 模型门控：特征/目标/币种/周期匹配 + 双时点（标签结束时间与发布时间均不晚于 asOf）
  const models = await db
    .select()
    .from(predictionModels)
    .where(and(eq(predictionModels.horizon, req.horizon), eq(predictionModels.status, 'published')))
    .orderBy(desc(predictionModels.trainedUntil))
  const model = models.find(
    (m) =>
      m.symbol === req.symbol &&
      m.marketType === req.marketType &&
      m.priceType === priceType &&
      m.targetType === req.targetType &&
      m.featureVersion === featureVersion &&
      (m.baseInterval ?? null) === baseInterval &&
      // trainedUntil = 最后样本标签结束时间：保证 asOf 时全部标签数据已可得
      m.trainedUntil <= req.asOf &&
      // 发布时间门控：历史回放不得使用当时尚不存在的模型
      m.publishedAt !== null &&
      m.publishedAt.getTime() <= req.asOf,
  )
  if (!model) {
    return { available: false, code: 'model_not_published', detail: `期限 ${req.horizon}/${req.targetType}/${featureVersion}/${baseInterval} 无已发布模型（按 ${req.symbol} 训练，禁止跨币种）` }
  }
  if (req.remainingSeconds !== undefined && model.validatedDurationRange !== null) {
    const r = model.validatedDurationRange
    if (req.remainingSeconds < r.minSec || req.remainingSeconds > r.maxSec) {
      return { available: false, code: 'remaining_out_of_range', detail: `剩余 ${req.remainingSeconds}s 超出模型验证范围 [${r.minSec}s,${r.maxSec}s]（不得复用完整期限预测）` }
    }
  }

  // 阈值（对数收益空间）：事件 = log(strike/indexRef)；方向研究 = 0
  let thresholdLog = 0
  if (req.targetType === 'strike_relative') {
    if (req.strikePrice === undefined || req.indexRefPrice === undefined || req.indexRefPrice <= 0) {
      return { available: false, code: 'stale_market', detail: '缺少执行价或实时指数参考价' }
    }
    thresholdLog = Math.log(req.strikePrice / req.indexRefPrice)
  }

  let out: PyPredictResponse
  try {
    out = await pyPredict({ modelVersion: model.modelVersion, rows: [{ features }] })
  } catch (err) {
    return { available: false, code: 'inference_failed', detail: (err as Error).message.slice(0, 200) }
  }
  // 概率内插一律用校准后分位网格（isotonic level 重映射）：EV/三分支/方向概率
  // 都经过映射；旧工件无 calibratedQuantiles 时回退原始网格（发布门控已拒绝此类工件，
  // 回退仅覆盖发布于映射门控之前的存量模型）
  const q = out.predictions[0].calibratedQuantiles && Object.keys(out.predictions[0].calibratedQuantiles).length >= 3
    ? out.predictions[0].calibratedQuantiles
    : out.predictions[0].quantiles

  // 概率输出：精度已知 → 互斥三分支（mutuallyExclusiveThreeWay，见其文档）；
  // 精度未知 → 执行价中心阈值（仅研究展示），pTie=null → 调用方 EV 禁用
  let probabilityUp: number
  let probabilityTie: number | null = null
  const precisionKnown = req.targetType === 'strike_relative' && EVENT_SETTLEMENT_PRECISION !== null && req.indexRefPrice !== undefined && req.strikePrice !== undefined
  if (precisionKnown) {
    const three = mutuallyExclusiveThreeWay(q, req.strikePrice!, req.indexRefPrice!, EVENT_SETTLEMENT_PRECISION!)
    if (three === null) {
      return { available: false, code: 'tail_unvalidated', detail: '平价区间阈值落在已验证分位覆盖之外，不得截断为 0/100%' }
    }
    probabilityUp = three.probabilityUp
    probabilityTie = three.probabilityTie
  } else {
    const pUp = probAboveFromQuantileGrid(q, thresholdLog)
    if (pUp === null) {
      return { available: false, code: 'tail_unvalidated', detail: `阈值 log=${thresholdLog.toFixed(6)} 落在已验证分位覆盖之外，不得截断为 0/100%` }
    }
    probabilityUp = pUp
  }

  log.ok('predict', '预测产出', kv({ 模型: model.modelVersion, 目标: req.targetType, 阈值: thresholdLog.toFixed(6), pUp: probabilityUp.toFixed(4), pTie: probabilityTie?.toFixed(4) ?? 'n/a' }))
  return {
    available: true,
    probabilityUp,
    probabilityTie,
    quantiles: Object.fromEntries(Object.entries(q).map(([k, v]) => [k, Number(Number(v).toFixed(8))])),
    modelVersion: model.modelVersion,
    featureVersion,
    baseInterval,
    targetType: req.targetType,
    thresholdLog,
    features,
  }
}

/** 事件结算精度是否已知（决定 pTie/EV 可用性） */
export function settlementPrecisionKnown(): boolean {
  return EVENT_SETTLEMENT_PRECISION !== null
}

/**
 * 预测命中率统计（纯函数，GET /api/predictions/stats）：
 * - estimated（研究估算）与 user_confirmed（用户确认）两轨分列，互不合并；
 * - 预测方向 = probabilityUp>=0.5 ? 'above' : 'below'；probabilityUp 为 null 的行跳过；
 * - outcome==='tie' 恒不算命中（方向预测在平价分支既不算对也不算错，不计入命中率分子）；
 * - count=0 时 hitRate=null。
 */
export function summarizePredictionStats(
  rows: {
    probabilityUp: number | null
    estimatedOutcome: 'above' | 'below' | 'tie' | null
    userConfirmedOutcome: 'above' | 'below' | 'tie' | null
  }[],
): PredictionStats {
  const track = (outcomeOf: (r: (typeof rows)[number]) => 'above' | 'below' | 'tie' | null): PredictionStatsTrack => {
    let count = 0
    let hits = 0
    for (const r of rows) {
      const outcome = outcomeOf(r)
      if (outcome === null || r.probabilityUp === null) continue
      count += 1
      const predicted = r.probabilityUp >= 0.5 ? 'above' : 'below'
      if (outcome !== 'tie' && outcome === predicted) hits += 1
    }
    return { count, hits, hitRate: count === 0 ? null : hits / count }
  }
  return {
    estimated: track((r) => r.estimatedOutcome),
    userConfirmed: track((r) => r.userConfirmedOutcome),
  }
}

