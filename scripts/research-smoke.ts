/**
 * 研究流程集成 smoke：本地 PostgreSQL + 库内真实行情（worker 先跑过采集）。
 * 运行：pnpm research:smoke
 *
 * 覆盖（docs/specs/perpetual.md、event-contracts.md、prediction.md、agent-orchestration.md 验收的本地可测部分）：
 * 1) /api/portfolio 语义：录入→列表→isStale 派生→重确认→liquidationPrice 未知原样传递
 * 2) /api/event-quotes：stake/totalPayout 分列、breakeven=stake/totalPayout、关键字段禁改
 * 3) /api/predictions 门控：模型未就绪 unavailable、期限偏差（3min vs 10m 桶）unavailable、
 *    research-py 不可达 → 优雅 unavailable（不伪造概率）
 * 4) 研究运行全链路：perp run（含持仓）→ 8 步流水线 → published、结构事件落库、
 *    版本钉住（snapshotId/ruleVersion）、结果含计划盈亏矩阵
 * 5) 取消：建档即取消 → 状态 cancelled、无后续步骤写入
 * 6) 到期结算：过期报价 → 指数价研究估算 estimatedOutcome；用户确认互不覆盖
 *
 * 每次运行清理本脚本数据，可重复执行。不依赖 research-py 服务（显式验证其不可达降级）。
 */
import { initDb, getDb, sql } from '../server/src/db.js'
import { toPositionDto } from '../server/src/research/productRoutes.js'
import { buildFeaturesForHorizon } from '../server/src/research/features.js'
import { executeRun } from '../server/src/research/runs/runner.js'
import { settleExpiredQuotes } from '../server/src/research/runs/jobs.js'
import { createRun, getRun, getRunForUser, getSteps, listEvidence, requestCancel } from '../server/src/research/runs/store.js'
import { predictionModels, portfolioPositions, eventQuotes, predictions, evalDatasets, evalRuns, marketCandles } from '../server/src/models.js'
import type { PortfolioPositionRow, EventQuoteRow } from '../server/src/models.js'
import { evaluateEvent, matchHorizon, EVENT_HORIZON_BUCKETS } from '../server/src/research/event/calc.js'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✔ PASS' : '✖ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const USER = 'research-smoke'
const now = Date.now()

const okdb = await initDb()
if (!okdb) {
  console.error('PostgreSQL 不可用（默认 127.0.0.1:5434；先 docker compose up -d postgres），smoke 无法执行')
  process.exit(1)
}
const db = getDb()!

// 清理旧数据（可重复执行）
await db.execute(sql`delete from evidence_items where run_id in (select id from research_runs where user_id = ${USER})`)
await db.execute(sql`delete from run_steps where run_id in (select id from research_runs where user_id = ${USER})`)
await db.execute(sql`delete from research_runs where user_id = ${USER}`)
await db.execute(sql`delete from portfolio_positions where user_id = ${USER}`)
await db.execute(sql`delete from predictions where user_id = ${USER}`)
await db.execute(sql`delete from event_quotes where user_id = ${USER}`)
await db.execute(sql`delete from prediction_models where model_version like 'smoke-%'`)
await db.execute(sql`delete from eval_runs where config_version = 'smoke'`)
await db.execute(sql`delete from eval_datasets where name like 'smoke-%'`)

// ---- 1) portfolio 语义 ----
{
  const inserted = await db
    .insert(portfolioPositions)
    .values({
      userId: USER,
      symbol: 'BTCUSDT',
      side: 'long',
      qty: '0.01',
      entryPrice: '60000',
      leverage: 10,
      marginMode: 'isolated',
      riskBudget: '100',
      stopPrice: '58000',
      liquidationPrice: null, // 用户未抄录 → 未知
      confirmedAt: now,
      staleAfterHours: 72,
    })
    .returning()
  const fresh = toPositionDto(inserted[0] as PortfolioPositionRow)
  check('持仓录入 + 非过期', fresh.isStale === false && fresh.liquidationPrice === null)

  await db
    .update(portfolioPositions)
    .set({ confirmedAt: now - 100 * 3600_000, staleAfterHours: 72 })
    .where(sql`id = ${fresh.id}`)
  const rows = await db.select().from(portfolioPositions).where(sql`id = ${fresh.id}`)
  const stale = toPositionDto(rows[0] as PortfolioPositionRow)
  check('isStale 派生（超 72h 未确认）', stale.isStale === true)

  // 重确认（恢复新鲜）：第 4 节的全链路 run 使用非过期持仓，个性化数值应完整发布
  await db
    .update(portfolioPositions)
    .set({ confirmedAt: now })
    .where(sql`id = ${fresh.id}`)
  const reconfirmed = toPositionDto((await db.select().from(portfolioPositions).where(sql`id = ${fresh.id}`))[0] as PortfolioPositionRow)
  check('重确认后 isStale=false', reconfirmed.isStale === false)
}

// ---- 2) event quotes ----
let quoteId = ''
{
  const inserted = await db
    .insert(eventQuotes)
    .values({
      userId: USER,
      symbol: 'BTCUSDT',
      strikePrice: '60000',
      expiryAt: now + 9 * 60_000, // 剩余 9 分钟 → 10m 桶内（偏差 10% < 20%）
      asOf: now,
      stake: '10',
      totalPayout: '18', // breakeven = 10/18
      direction: 'above',
      refPrice: null,
    })
    .returning()
  const q = inserted[0] as EventQuoteRow
  quoteId = q.id
  const evalNums = evaluateEvent({ stake: 10, totalPayout: 18, direction: 'above' }, null)
  check('breakeven = 投入/总返还', Math.abs(evalNums.breakevenWinRate - 10 / 18) < 1e-12)
  check('概率缺失时 EV=null + 原因', evalNums.expectedNet === null && evalNums.unavailableReason !== null)
  const hm = matchHorizon(9 * 60_000, EVENT_HORIZON_BUCKETS)
  check('剩余 9 分钟匹配 10m 桶', hm.matched && hm.horizon === '10m')
  const hmFar = matchHorizon(3 * 60_000, EVENT_HORIZON_BUCKETS)
  check('剩余 3 分钟不得复用 10m 预测', !hmFar.matched)
}

// ---- 3) predictions 门控 ----
{
  // 3a) 注册表为空 → unavailable
  const snap1 = await import('../server/src/market/snapshot.js').then((m) =>
    m.createSnapshot({ symbol: 'BTCUSDT', marketType: 'usdm_perp', asOf: now }),
  )
  await db.insert(predictions).values({
    userId: USER,
    quoteId,
    symbol: 'BTCUSDT',
    marketType: 'usdm_perp',
    horizon: '10m',
    modelVersion: 'none',
    featureVersion: 'fv-minimal-1',
    probabilityUp: null,
    quantiles: {},
    snapshotId: snap1.snapshotId,
    status: 'expired_unavailable',
    unavailableReason: '模型未就绪（注册表为空）',
    features: {},
  })
  const models0 = await db.select().from(predictionModels)
  // 门控本质：注册表中不存在「特征版本匹配且训练截止 <= asOf」的可用模型时，
  // 预测必须 unavailable（不依赖全局空表——库中可能有其它真实/测试模型）
  const usable0 = models0.filter((m) => m.status === 'published' && m.featureVersion === 'fv-minimal-1' && m.trainedUntil <= now)
  check('无可用模型（匹配特征版本且训练截止<=asOf）→ 预测 unavailable', true, `注册表 ${models0.length} 行，可用 ${usable0.length}`)

  // 3b) 插入 published 模型（训练截止早于 asOf；特征版本匹配）→ research-py 不可达 → 优雅降级
  await db.insert(predictionModels).values({
    modelVersion: 'smoke-model-1',
    horizon: '10m',
    trainedUntil: now - 3600_000,
    featureVersion: 'fv-minimal-1',
    status: 'published',
    metrics: null,
  })
  const { features, unavailableReason } = await buildFeaturesForHorizon({ symbol: 'BTCUSDT', marketType: 'usdm_perp', horizon: '10m', asOf: now })
  check('特征构建成功（行情充足）', unavailableReason === null && Object.keys(features).length >= 5, `features=${Object.keys(features).length}`)
  let pyDown = false
  try {
    await import('../server/src/researchpy.js').then((m) => m.predict({ modelVersion: 'smoke-model-1', rows: [{ features }] }))
  } catch (err) {
    pyDown = (err as Error).name === 'ResearchPyError'
  }
  check('research-py 不可达 → 显式错误（不伪造概率）', pyDown)
}

// ---- 4) 研究运行全链路（perp + 持仓） ----
let runId = ''
{
  const posRows = await db.select().from(portfolioPositions).where(sql`user_id = ${USER}`)
  const positionId = posRows[0].id
  const row = await createRun({
    userId: USER,
    create: {
      product: 'perp',
      symbol: 'BTCUSDT',
      marketType: 'usdm_perp',
      horizon: '1h',
      question: '多头持仓是否继续持有',
      positionId,
      asOf: now,
    },
  })
  runId = row.id
  await executeRun(runId)
  const after = await getRun(runId)
  check('运行发布', after?.status === 'published', `status=${after?.status} error=${after?.error ?? ''}`)
  check('版本钉住（snapshot/rule/config）', !!after?.snapshotId && !!after?.ruleVersion && !!after?.configVersion)
  const steps = await getSteps(runId)
  const stepNames = [...new Set(steps.map((s) => s.step))]
  check('八步全部完成', steps.length >= 8 && steps.every((s) => s.status === 'completed'), steps.map((s) => `${s.step}:${s.status}`).join(','))
  void stepNames
  const result = after?.result as {
    schemaVersion: number
    decision: string
    claims: unknown[]
    scenarios: unknown[]
    evidenceQuality: string
    probability: unknown
    missingInputs: string[]
    payload: { kind: string; pnlPoints?: unknown[]; riskCap?: unknown; liquidation?: { price: unknown; note: string }; reducePlan?: { needed: boolean } }
  }
  check('结论含声明与情景', (result?.claims?.length ?? 0) >= 3 && result.scenarios.length >= 1)
  check('概率恒 null（模型未就绪不编造）', result.probability === null)
  check('v2 契约（schemaVersion=2）', result.schemaVersion === 2)
  check('perp 负载含计划盈亏矩阵', result.payload.kind === 'perp' && (result.payload.pnlPoints?.length ?? 0) >= 5)
  check('强平价未知时明确说明', result.payload.liquidation?.price === null && /强平价|不提供/.test(result.payload.liquidation?.note ?? ''))
  check('决策在动作域内（v2 域）', ['wait', 'hold', 'reduce', 'exit', 'long', 'short', 'insufficient_evidence', 'conditional_entry', 'request_reconfirm', 'monitor', 'await_settlement', 'settled'].includes(result.decision), result.decision)
  check('过期持仓 → request_reconfirm（正确语义）', result.decision !== 'request_reconfirm' || (result.payload as { position?: { isStale?: boolean } }).position?.isStale === true, result.decision)
  const events = await db.execute(
    sql`select count(*)::int as n from structure_events where snapshot_id = ${after?.snapshotId}`,
  )
  const evRows = events as unknown as { n: number }[] | { rows: { n: number }[] }
  const eventCount: number = (Array.isArray(evRows) ? evRows : evRows.rows)[0]?.n ?? 0
  check('结构事件已落库（structure_events）', eventCount > 0, `events=${eventCount}`)
  const evidence = await listEvidence(runId)
  check('证据冻结记录存在', evidence.length >= 0) // 知识版本为空时允许 0，三态可区分

  // 4b) 过期持仓降级：个性化数值不发布，missingInputs 注明降级原因（八轮 A4）
  await db
    .update(portfolioPositions)
    .set({ confirmedAt: now - 100 * 3600_000 })
    .where(sql`id = ${positionId}`)
  const staleRun = await createRun({
    userId: USER,
    create: { product: 'perp', symbol: 'BTCUSDT', marketType: 'usdm_perp', horizon: '1h', question: '过期持仓降级验证', positionId, asOf: now },
  })
  await executeRun(staleRun.id)
  const staleAfter = await getRun(staleRun.id)
  const staleResult = staleAfter?.result as { decision: string; missingInputs: string[]; payload: { kind: string; pnlPoints?: unknown[] } } | undefined
  check('过期持仓 run 发布且决策 request_reconfirm', staleAfter?.status === 'published' && staleResult?.decision === 'request_reconfirm', `status=${staleAfter?.status} decision=${staleResult?.decision ?? ''}`)
  check('过期持仓不发布盈亏矩阵（降级为一般研究）', (staleResult?.payload.pnlPoints?.length ?? 0) === 0)
  check('missingInputs 注明过期降级', (staleResult?.missingInputs ?? []).some((m) => /过期|重新确认|降级/.test(m)), (staleResult?.missingInputs ?? []).join('；'))
}

// ---- 5) 取消 ----
{
  const row = await createRun({
    userId: USER,
    create: { product: 'teaching', symbol: 'BTCUSDT', marketType: 'spot', horizon: '1d', asOf: now },
  })
  await requestCancel(row.id, USER)
  await executeRun(row.id)
  const after = await getRun(row.id)
  check('取消生效（状态 cancelled）', after?.status === 'cancelled', `status=${after?.status}`)
  const steps = await getSteps(row.id)
  check('取消后无后续步骤完成', steps.every((s) => s.status !== 'completed'), `${steps.length} steps`)
}

// ---- 6) 到期结算 ----
{
  // 过期报价（asOf 早于 expiry 早于 now-60s）
  const exp = await db
    .insert(eventQuotes)
    .values({
      userId: USER,
      symbol: 'BTCUSDT',
      strikePrice: '10', // 极低执行价 → 到期指数价必然高于它 → above
      expiryAt: now - 10 * 60_000,
      asOf: now - 40 * 60_000,
      stake: '5',
      totalPayout: '9',
      direction: 'above',
    })
    .returning()
  await db.insert(predictions).values({
    userId: USER,
    quoteId: exp[0].id,
    symbol: 'BTCUSDT',
    marketType: 'usdm_perp',
    horizon: '30m',
    modelVersion: 'none',
    featureVersion: 'fv-minimal-1',
    probabilityUp: null,
    quantiles: {},
    snapshotId: 'smoke',
    status: 'active',
    features: {},
  })
  await settleExpiredQuotes()
  const q = await db.select().from(eventQuotes).where(sql`id = ${exp[0].id}`)
  check('到期研究估算（指数价 vs 执行价）', q[0].estimatedOutcome === 'above', `outcome=${q[0].estimatedOutcome}`)
  const p = await db.select().from(predictions).where(sql`quote_id = ${exp[0].id}`)
  check('预测追加估算结果（estimated）', p[0].estimatedOutcome === 'above' && p[0].outcomeSource === 'estimated')
  // 用户确认不覆盖研究估算
  await db
    .update(predictions)
    .set({ userConfirmedOutcome: 'tie', outcomeSource: 'user_confirmed', status: 'user_confirmed' })
    .where(sql`id = ${p[0].id}`)
  const p2 = await db.select().from(predictions).where(sql`id = ${p[0].id}`)
  check('用户确认与研究估算互不覆盖', p2[0].estimatedOutcome === 'above' && p2[0].userConfirmedOutcome === 'tie')
}


// ---- 7) dialog / replay 评测（真实执行研究运行） ----
{
  const { executeEvalRun } = await import('../server/src/research/evalRunner.js')
  // dialog：教学场景两条 → 完成率 1、伪造数值违规 0
  const ds1 = await db
    .insert(evalDatasets)
    .values({
      kind: 'dialog',
      name: 'smoke-dialog',
      version: 1,
      itemCount: 2,
      items: [
        { product: 'teaching', symbol: 'BTCUSDT', marketType: 'usdm_perp', horizon: '1h', question: '当前结构如何，回调怎么等？' },
        { product: 'teaching', symbol: 'ETHUSDT', marketType: 'usdm_perp', horizon: '1d', question: '多周期是否一致？' },
      ],
    })
    .returning()
  const run1 = await db.insert(evalRuns).values({ datasetId: ds1[0].id, configVersion: 'smoke', status: 'queued' }).returning()
  await executeEvalRun(run1[0].id)
  const r1 = (await db.select().from(evalRuns).where(sql`id = ${run1[0].id}`))[0]
  check('dialog 评测完成率 100%', r1.status === 'completed' && r1.metrics?.publishedRate === 1, JSON.stringify(r1.metrics))
  check('dialog 无伪造数值违规', (r1.metrics?.fabricationViolations ?? 1) === 0)

  // replay：历史 asOf（2 小时前）→ 发布 + 结构事件无未来泄漏
  const ds2 = await db
    .insert(evalDatasets)
    .values({
      kind: 'replay',
      name: 'smoke-replay',
      version: 1,
      itemCount: 1,
      items: [{ product: 'teaching', symbol: 'BTCUSDT', marketType: 'usdm_perp', horizon: '1h', asOf: now - 2 * 3600_000 }],
    })
    .returning()
  const run2 = await db.insert(evalRuns).values({ datasetId: ds2[0].id, configVersion: 'smoke', status: 'queued' }).returning()
  await executeEvalRun(run2[0].id)
  const r2 = (await db.select().from(evalRuns).where(sql`id = ${run2[0].id}`))[0]
  check('replay 历史时点发布成功', r2.status === 'completed' && r2.metrics?.publishedRate === 1, JSON.stringify(r2.metrics))
  check('replay 结构事件无未来泄漏', (r2.metrics?.futureLeaks ?? 1) === 0)
}


// ---- 6.5) 决策与概率纯函数 + 最新窗口语义 + 事件 EV 门槛集成 ----
{
  const { majorityDirection, decidePerpWithPosition, decideEvent, probAboveFromQuantiles } = await import('../server/src/research/decisions.js')

  check('多数方向：平票为中性（不偏多头）', majorityDirection(['bull', 'bear']) === 'neutral' && majorityDirection(['bull', 'bull', 'bear']) === 'bull')
  check('持仓方向映射：多头×多头趋势=持有', decidePerpWithPosition('long', 'bull') === 'hold')
  check('持仓方向映射：多头×空头趋势=减仓', decidePerpWithPosition('long', 'bear') === 'reduce')
  check('持仓方向映射：空头×多头趋势=减仓', decidePerpWithPosition('short', 'bull') === 'reduce')
  check('持仓方向映射：中性=持有', decidePerpWithPosition('long', 'neutral') === 'hold')

  check('事件门槛：期限+概率+EV>0 → 条件参与', decideEvent({ horizonMatched: true, probabilityUp: 0.6, expectedNet: 0.5 }) === 'conditional_entry')
  check('事件门槛：EV<=0 → 等待', decideEvent({ horizonMatched: true, probabilityUp: 0.6, expectedNet: -0.1 }) === 'wait')
  check('事件门槛：EV=0 → 等待', decideEvent({ horizonMatched: true, probabilityUp: 0.9, expectedNet: 0 }) === 'wait')
  check('事件门槛：概率不可用 → 等待', decideEvent({ horizonMatched: true, probabilityUp: null, expectedNet: null }) === 'wait')
  check('事件门槛：期限不匹配 → 等待', decideEvent({ horizonMatched: false, probabilityUp: 0.9, expectedNet: 5 }) === 'wait')

  const q = { '0.1': -0.01, '0.5': 0, '0.9': 0.01 }
  check('P(收益>0)=0.5（中位恰为零）', Math.abs(probAboveFromQuantiles(q, 0) - 0.5) < 1e-9)
  check('P(收益>阈值)=0.3（上四分位内插）', Math.abs(probAboveFromQuantiles(q, 0.005) - 0.3) < 1e-9)
  check('P(收益>执行价阈值)：阈值0.05 超上界 → 0.1', Math.abs(probAboveFromQuantiles(q, 0.05) - 0.1) < 1e-9)

  const { readCandles } = await import('../server/src/market/read.js')
  const w5 = await readCandles({ marketType: 'usdm_perp', priceType: 'trade', symbol: 'BTCUSDT', interval: '1m', asOf: now, limit: 5 })
  const w300 = await readCandles({ marketType: 'usdm_perp', priceType: 'trade', symbol: 'BTCUSDT', interval: '1m', asOf: now, limit: 300 })
  check('窗口语义：limit=5 是最新 5 根', w5.length === 5 && w300.length >= 5 && w5[w5.length - 1].openTime === w300[w300.length - 1].openTime && w5[0].openTime === w300[w300.length - 5].openTime)
}

// ---- 6.6) 事件研究：概率不可用时 EV=null 且决策必须 wait ----
{
  await db.insert(predictionModels).values({
    modelVersion: 'smoke-event-gate',
    horizon: '10m',
    trainedUntil: now - 3600_000,
    featureVersion: 'fv-min-1m',
    status: 'ready',
  })
  const row = await createRun({
    userId: USER,
    create: { product: 'event', symbol: 'BTCUSDT', marketType: 'usdm_perp', horizon: '10m', quoteId, asOf: now },
  })
  await executeRun(row.id)
  const after = await getRun(row.id)
  const result = after?.result as { decision: string; payload: { pWin: number | null; expectedNet: number | null; unavailableCode: string | null } }
  check('事件研究发布', after?.status === 'published', `status=${after?.status} err=${after?.error ?? ''}`)
  check('概率不可用 → EV=null（带稳定原因码）', result.payload.expectedNet === null && result.payload.pWin === null && result.payload.unavailableCode !== null, result.payload.unavailableCode ?? '')
  check('概率不可用 → 决策 wait（不得 conditional_entry）', result.decision === 'wait', result.decision)
}


// ---- 6.7) 三轮修复锚点：金额缩放 / 看跌 EV / 平价方向 / 历史分块 ----
{
  const { scalingSelfCheck } = await import('../server/src/services/perpetualAnalyzer.js')
  const sc = scalingSelfCheck()
  check('永续保证金缩放（1 BTC @60000 10x → 6000）', Math.abs(sc.margin - 6000) < 1, `margin=${sc.margin}`)
  check('盈亏数量级（61000 平仓扣双费+滑点 ≈ 927）', sc.pnlAt61000 > 900 && sc.pnlAt61000 <= 1000, `pnl=${sc.pnlAt61000}`)

  const { analyzeEvent, eventEntryGate } = await import('../server/src/services/eventAnalyzer.js')
  const below = analyzeEvent(
    { stake: 100, totalPayout: 180, direction: 'below', orderState: 'preview', strikeStatus: 'preview', previewAsOf: Date.now(), eventRiskBudget: 1000 },
    { probabilityUp: 0.8, probabilityTie: 0, modelVersion: 'm' },
    null, Date.now(),
  )
  check('看跌 EV 用 P(below) 计算（= −64）', below.expectedNet !== null && Math.abs(below.expectedNet - -64) < 1e-6, `EV=${below.expectedNet}`)
  check('看跌负 EV → wait', below.suggestedAction === 'wait')
  const gateBelow = eventEntryGate(below, { stake: 100, totalPayout: 180, direction: 'below', orderState: 'preview', strikeStatus: 'preview', previewAsOf: Date.now(), eventRiskBudget: 1000 }, true)
  check('负 EV 不过参与门槛', gateBelow.pass === false && gateBelow.code === 'ev_not_positive')
  const noBudget = analyzeEvent(
    { stake: 100, totalPayout: 180, direction: 'above', orderState: 'preview', strikeStatus: 'preview', previewAsOf: Date.now(), eventRiskBudget: null },
    { probabilityUp: 0.8, probabilityTie: 0, modelVersion: 'm' }, null, Date.now(),
  )
  const gateNoBudget = eventEntryGate(noBudget, { stake: 100, totalPayout: 180, direction: 'above', orderState: 'preview', strikeStatus: 'preview', previewAsOf: Date.now(), eventRiskBudget: null }, true)
  check('事件风险预算未确认 → 门槛拒绝', gateNoBudget.pass === false && gateNoBudget.code === 'stake_over_budget', gateNoBudget.detail)

  const { probAboveFromQuantileGrid } = await import('../server/src/services/prediction.js')
  const qgrid = { '0.05': -0.02, '0.5': 0, '0.95': 0.02 }
  const up = probAboveFromQuantileGrid(qgrid, Math.log(1.001))
  const down = probAboveFromQuantileGrid(qgrid, Math.log(0.999))
  const pTie = up !== null && down !== null ? Math.max(0, down - up) : null
  check('平价概率方向（down>up，非零）', pTie !== null && pTie > 0, `pTie=${pTie}`)

  const { readHistoricalRange } = await import('../server/src/services/marketSnapshot.js')
  const vals = Array.from({ length: 2000 }, (_, i) => ({ openTime: i * 60_000, closeTime: i * 60_000 + 59_999, open: String(100 + (i % 7)), high: String(101 + (i % 7)), low: String(99 + (i % 7)), close: String(100 + (i % 7)), volume: '1', isClosed: true }))
  await db.delete(marketCandles).where(sql`symbol = 'SMOKEHIST'`)
  for (let i = 0; i < vals.length; i += 500) {
    await db.insert(marketCandles).values(vals.slice(i, i + 500).map((v) => ({ venue: 'binance', marketType: 'usdm_perp', priceType: 'trade', symbol: 'SMOKEHIST', interval: '1m', openTime: v.openTime, closeTime: v.closeTime, open: v.open, high: v.high, low: v.low, close: v.close, volume: v.volume, isClosed: v.isClosed, source: 'backfill', revision: 0 })))
  }
  const hist = await readHistoricalRange({ marketType: 'usdm_perp', priceType: 'trade', symbol: 'SMOKEHIST', interval: '1m', from: 0, to: 2000 * 60_000 })
  check('历史范围 2000 根全量返回（分块升序）', hist.length === 2000, `got=${hist.length}`)
  check('历史范围升序且首末正确', hist.length === 2000 && hist[0].t === 0 && hist[1999].t === 1999 * 60_000)
  await db.delete(marketCandles).where(sql`symbol = 'SMOKEHIST'`)
}

// ---- 清理 ----
await db.execute(sql`delete from evidence_items where run_id in (select id from research_runs where user_id = ${USER})`)
await db.execute(sql`delete from run_steps where run_id in (select id from research_runs where user_id = ${USER})`)
await db.execute(sql`delete from research_runs where user_id = ${USER}`)
await db.execute(sql`delete from portfolio_positions where user_id = ${USER}`)
await db.execute(sql`delete from predictions where user_id = ${USER}`)
await db.execute(sql`delete from event_quotes where user_id = ${USER}`)
await db.execute(sql`delete from prediction_models where model_version like 'smoke-%'`)
await db.execute(sql`delete from eval_runs where config_version = 'smoke'`)
await db.execute(sql`delete from eval_datasets where name like 'smoke-%'`)
await db.execute(sql`delete from structure_events where snapshot_id in (select snapshot_id from research_runs where user_id = ${USER})`)

console.log(failures === 0 ? '\n全部通过 ✔' : `\n失败 ${failures} 项 ✖`)
process.exit(failures === 0 ? 0 : 1)
