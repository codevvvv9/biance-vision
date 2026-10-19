/**
 * P1 修复回归校验：对照审查报告的复现用例，逐项锚定修复后的行为。
 * 运行：pnpm research:p1-check
 * 覆盖：
 *  - 永续退出判断（invalidation.direction 与持仓同向才 exit）
 *  - 增量风险按当前价（入场 60000/当前 66000/止损 65000 → 到止损 ≈ −1000−费）
 *  - 资金费率缺失不再填默认值
 *  - 三分支互斥概率（0.49/0.02/0.49 分布 → EV = 0，不得出现虚假 +2）
 *  - 特征版本周期门控（1d 事件 = fv-evt-r-1h，训练与推理同源）
 */

import { decidePerp } from '../server/src/services/decisionPolicy.js'
import { analyzePerp, DEFAULT_PERP_FEES } from '../server/src/services/perpetualAnalyzer.js'
import { mutuallyExclusiveThreeWay, probAboveFromQuantileGrid, summarizePredictionStats } from '../server/src/services/prediction.js'
import { validateResearch } from '../server/src/services/validator.js'
import { analyzeEvent } from '../server/src/services/eventAnalyzer.js'
import { featuresAt, MIN_BARS } from '../server/src/research/features.js'
import { missingPositionFields, parseReplayAsOf } from '../server/src/research/runs/conversation.js'
import { resolveLlmClient } from '../server/src/research/llm.js'
import { PositionInputSchema } from '../shared/src/contract/portfolio.js'
import { baseIntervalFor, featureVersionFor } from '../server/src/research/features.js'
import { classifyIntent } from '../server/src/research/runs/conversation.js'
import { resolveRolePrompt, hasBlockingQualityIssue } from '../server/src/research/runs/stages.js'
import { hashFrozenConfig } from '../server/src/research/runs/store.js'
import { runPipeline } from '../server/src/research/orchestrator/pipeline.js'
import { LeaseLostError } from '../server/src/research/orchestrator/types.js'
import type { RunContext, RunStore, StageName } from '../server/src/research/orchestrator/types.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✅ PASS  ${msg}`)
  } else {
    failed++
    console.error(`  ❌ FAIL  ${msg}`)
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

const baseStructure = {
  execDirection: 'bull' as const,
  backgroundDirection: 'bull' as const,
  conflict: false,
  conflictDetail: null,
  confirmedSetup: null,
  recentInvalidations: [],
}
const holdInput = {
  structure: baseStructure,
  position: { side: 'long' as const, isStale: false, stopPrice: 58000, lastPrice: 60000 },
  reducePlan: null,
  riskCap: { ok: true, maxQty: 1 },
  evidenceSufficient: true,
  marketQualityOk: true,
}

console.log('\n[P1-1] 永续退出：invalidation.direction = 失效的原信号方向')
{
  // 多头持仓 + 多头结构失效（inv.direction='bull'）→ exit（修复前会 hold）
  const a = decidePerp({
    ...holdInput,
    structure: { ...baseStructure, recentInvalidations: [{ direction: 'bull', barsAgo: 5 }] },
  })
  assert(a.action === 'exit', '多头持仓遇多头结构失效 → exit（原逻辑读反会 hold）')

  // 多头持仓 + 空头结构失效（inv.direction='bear'）→ 不是本仓退出条件（走后续分支）
  const b = decidePerp({
    ...holdInput,
    structure: { ...baseStructure, recentInvalidations: [{ direction: 'bear', barsAgo: 5 }] },
  })
  assert(b.action === 'hold', '多头持仓遇空头结构失效 → 与本仓无关，结构支持时 hold（原逻辑会误 exit）')

  // 空头持仓 + 空头结构失效 → exit（对称）
  const c = decidePerp({
    ...holdInput,
    position: { side: 'short', isStale: false, stopPrice: 62000, lastPrice: 60000 },
    structure: {
      ...baseStructure,
      execDirection: 'bear',
      backgroundDirection: 'bear',
      recentInvalidations: [{ direction: 'bear', barsAgo: 3 }],
    },
  })
  assert(c.action === 'exit', '空头持仓遇空头结构失效 → exit（对称成立）')

  // 过旧失效（>30 根）不触发
  const d = decidePerp({
    ...holdInput,
    structure: { ...baseStructure, recentInvalidations: [{ direction: 'bull', barsAgo: 31 }] },
  })
  assert(d.action === 'hold', '31 根前的失效不构成新近退出条件')
}

console.log('\n[P1-2] 增量风险 = 当前价基准；资金费率缺失不填默认值')
{
  // 审查复现：入场 60000、当前 66000、止损 65000、数量 1
  const a = analyzePerp(
    { side: 'long', qty: 1, entryPrice: 60000, leverage: 10, marginMode: 'isolated', stopPrice: 65000, riskBudget: 5000, liquidationPrice: null },
    [65000], 66000, 100, [], DEFAULT_PERP_FEES, 0.001,
  )
  assert(a.incremental !== null && near(a.incremental.toStopPnl, -1000 - 65000 * 0.0007, 1e-3), `从当前 66000 持有到止损 65000 ≈ −1000−平仓费（实际 ${a.incremental?.toStopPnl}；修复前按入场价输出 +5000）`)
  assert(a.incremental !== null && near(a.incremental.toStopPct, (65000 / 66000 - 1) * 100, 1e-3), 'toStopPct 相对当前价（−1.515%），不是相对入场价')

  // 整笔视角仍在：矩阵 65000 点的 tradeNetPnl = +5000 − 双边费用
  const t = a.pnlPoints[0]
  assert(t !== undefined && near(t.tradeNetPnl, 5000 - 60000 * 0.0005 - 65000 * 0.0007, 1e-3), '整笔净盈亏保持入场价基准（+5000−双边费）')
  assert(t !== undefined && near(t.incrementalPnl, -1000 - 65000 * 0.0007, 1e-3), '矩阵增量列 = 从当前价到该价的净变化（−1000−费）')

  // 资金费率缺失：情景为空 + 明示缺失，不出现 0.0001 假数据
  assert(a.fundingScenarios.length === 0 && a.fundingNote.includes('缺失'), '费率数据为空 → 情景为空并标注缺失（修复前填 0.0001 标成均值）')
  const b = analyzePerp(
    { side: 'long', qty: 1, entryPrice: 60000, leverage: 10, marginMode: 'isolated', stopPrice: 58000, riskBudget: 500, liquidationPrice: null },
    [58000], 60000, 100, [0.0001, 0.0002], DEFAULT_PERP_FEES, 0.001,
  )
  assert(b.fundingScenarios.length === 3 && near(b.fundingScenarios[0].ratePer8h, 0.00015), '有数据时均值情景 = 实际均值 0.00015')

  // 减仓判断按增量基准：多头浮盈中（当前 66000 > 止损 65000）→ 到止损锁定盈利，无需减仓
  assert(a.reducePlan.needed === false, '止损在盈利侧（当前 66000/止损 65000）→ 增量到止损为锁定盈利，不触发减仓（修复前按 |入场−止损|=5000 误判超预算）')
  // 反例：深度浮亏（当前 61000、止损 58000、qty 1）→ 增量损失 3000+费 > 预算 1000 → 减仓
  const c = analyzePerp(
    { side: 'long', qty: 1, entryPrice: 60000, leverage: 10, marginMode: 'isolated', stopPrice: 58000, riskBudget: 1000, liquidationPrice: null },
    [58000], 61000, 100, [], DEFAULT_PERP_FEES, 0.001,
  )
  assert(c.reducePlan.needed === true && c.reducePlan.keepQty !== null && c.reducePlan.keepQty! < 1, `浮亏中增量到止损 3000+费 > 预算 1000 → 减仓（keep=${c.reducePlan.keepQty}）`)
}

console.log('\n[P1-3] 三分支互斥概率：平价不被双重计入')
{
  // 审查复现：真实分布 上涨 0.49 / 平价 0.02 / 下跌 0.49；投入 100、总返还 200 → EV 必须 = 0
  // 构造分位网格：P(R>上阈值)=0.49、P(R>下阈值)=0.51（对数空间，strike=100、精度=2 → 阈值 ±1%）
  const upper = Math.log(101 / 100)
  const lower = Math.log(99 / 100)
  const q: Record<string, number> = {}
  for (let k = 1; k <= 99; k++) {
    const p = k / 100
    // 分位 p 处的值：p=0.49 → lower，p=0.51 → upper，其余线性（保持单调）
    q[String(k / 100)] = lower + ((p - 0.49) / 0.02) * (upper - lower)
  }
  const three = mutuallyExclusiveThreeWay(q, 100, 100, 2)
  assert(three !== null, '三分支可从分位网格生成')
  if (three !== null) {
    assert(near(three.probabilityUp, 0.49, 1e-9), `pUp = P(高于平价上界) = 0.49（实际 ${three.probabilityUp}；修复前中心阈值给 0.50）`)
    assert(near(three.probabilityTie, 0.02, 1e-9), `pTie = 平价区间 = 0.02（实际 ${three.probabilityTie}）`)
    const pDown = 1 - three.probabilityUp - three.probabilityTie
    assert(near(pDown, 0.49, 1e-9), 'pDown = 0.49（三分支和为 1）')
    // 全链路 EV：analyzeEvent 用同一组概率
    const analysis = analyzeEvent(
      { stake: 100, totalPayout: 200, direction: 'above', orderState: 'preview', strikeStatus: 'preview', previewAsOf: Date.now(), eventRiskBudget: 100 },
      { probabilityUp: three.probabilityUp, probabilityTie: three.probabilityTie, modelVersion: 'test' },
      null,
      Date.now(),
    )
    assert(analysis.expectedNet !== null && near(analysis.expectedNet, 0, 1e-6), `EV = 0（实际 ${analysis.expectedNet}；修复前输出 +2 并通过参与门槛）`)
    assert(analysis.suggestedAction !== 'conditional_entry', 'EV=0 不给参与建议')
    // below 方向同样 EV=0（互斥保证对称）
    const below = analyzeEvent(
      { stake: 100, totalPayout: 200, direction: 'below', orderState: 'preview', strikeStatus: 'preview', previewAsOf: Date.now(), eventRiskBudget: 100 },
      { probabilityUp: three.probabilityUp, probabilityTie: three.probabilityTie, modelVersion: 'test' },
      null,
      Date.now(),
    )
    assert(below.expectedNet !== null && near(below.expectedNet!, 0, 1e-6), 'below 方向 EV 同样 = 0（无方向性偏差）')
  }
  // 尾部：阈值越界 → null（不得截断）
  assert(mutuallyExclusiveThreeWay({ '0.5': 0.001 }, 100, 100, 2) === null, '分位覆盖不足 → null（tail_unvalidated）')
  assert(probAboveFromQuantileGrid({ '0.1': -1, '0.9': 1 }, 5) === null, '阈值超出 .01~.99 覆盖 → null')
}

console.log('\n[P1-4] 周期门控：featureVersion 编码基础周期（训练/推理同源）')
{
  assert(featureVersionFor('1d', 'strike_relative') === 'fv-evt-r-1h', '1d 事件特征版本 = fv-evt-r-1h（含周期）')
  assert(featureVersionFor('10m', 'strike_relative') === 'fv-evt-r-1m', '10m 事件特征版本 = fv-evt-r-1m')
  assert(featureVersionFor('1w', 'return_positive') === 'fv-dir-x-1h', '1w 方向研究特征版本 = fv-dir-x-1h')
  assert(baseIntervalFor('1d') === '1h' && baseIntervalFor('10m') === '1m', '基础周期映射：1d→1h、10m→1m')
  assert(featureVersionFor('1d', 'strike_relative') !== featureVersionFor('10m', 'strike_relative'), '不同周期的同名目标特征版本不同（1h 训练的模型吃不到 1m 特征）')
}

console.log('\n[五轮 P1] ROE 单位一致 / 租约丢失不写状态 / 发布恢复幂等补发')
{
  // ROE：1 BTC @60000、10x、66000 平仓 → 净 5923.8 / 保证金 6000 = 0.9873
  // （修复前分母仍是 1e8 刻度 BigInt → Number ≈ 6e11 → ROE 舍入成 0）
  const a = analyzePerp(
    { side: 'long', qty: 1, entryPrice: 60000, leverage: 10, marginMode: 'isolated', stopPrice: 58000, riskBudget: 500, liquidationPrice: null },
    [66000], 60000, 100, [], DEFAULT_PERP_FEES, 0.001,
  )
  const pt = a.pnlPoints[0]
  assert(pt !== undefined && near(pt.roe, 5923.8 / 6000, 1e-4), `ROE = 净盈亏/保证金 = ${pt?.roe.toFixed(4)}（应 0.9873；修复前输出 0）`)

  // —— 租约丢失：completeStage 抛 LeaseLostError 后不得再写 stepFailed/fail ——
  const writes: string[] = []
  const leaseStore: RunStore = {
    async transition() { writes.push('transition') },
    async stepStarted() { writes.push('stepStarted') },
    async stepCompleted() { writes.push('stepCompleted') },
    async completeStage() { throw new LeaseLostError('run-x', 'w-old') },
    async stepFailed() { writes.push('stepFailed') },
    async publish() { writes.push('publish') },
    async fail() { writes.push('fail') },
    async isCancelled() { return false },
  }
  const mkCtx = (): RunContext =>
    ({
      runId: 'run-x', userId: 'u', product: 'teaching', symbol: 'BTCUSDT', marketType: 'usdm_perp', horizon: '1h',
      question: null, positionId: null, quoteId: null, asOf: Date.now(), snapshotId: null, configVersion: null,
      knowledgeVersion: null, ruleVersion: null, modelVersion: null, frozenConfig: null, qualityIssues: [],
      snapshotPack: null, plan: null, structures: null, retrieval: null, productPayload: null, claims: [],
      counterClaims: [], decision: null, result: null, validationFeedback: null,
      usage: { llmCalls: 0, tokens: 0, searchCalls: 0, toolCalls: 0, costUsd: 0 }, runStartedAt: Date.now(),
    }) as unknown as RunContext
  const quietBus = { emit() { /* 隔离测试不推送 */ } }
  let leaseThrown = false
  try {
    // 九阶段齐全（P1-2 起含 synthesis；只缺阶段集合会触发行首完整性检查）；
    // plan 一执行完 completeStage 即丢租约
    const allStages = ['plan', 'snapshot', 'structures', 'retrieve', 'product_analysis', 'countercase', 'synthesis', 'validate', 'publish'].map(
      (name) => ({ name: name as StageName, async run() {} }),
    )
    await runPipeline(mkCtx(), allStages, leaseStore, quietBus, { leaseOwner: 'w-old' })
  } catch (e) {
    leaseThrown = e instanceof LeaseLostError
  }
  assert(leaseThrown, 'completeStage 丢租约 → LeaseLostError 上抛（本 worker 退出）')
  assert(!writes.includes('stepFailed') && !writes.includes('fail'), '丢租约后不再写 stepFailed/fail（不得把接管者的 run 改成失败）')

  // —— 发布恢复：全部阶段 completed（stages 空）+ result 从 checkpoint 恢复 → 幂等补发布 ——
  const pubWrites: string[] = []
  const pubStore: RunStore = {
    async transition() {},
    async stepStarted() {},
    async stepCompleted() {},
    async completeStage() { pubWrites.push('completeStage') },
    async stepFailed() { pubWrites.push('stepFailed') },
    async publish() { pubWrites.push('publish') },
    async fail() { pubWrites.push('fail') },
    async isCancelled() { return false },
  }
  const ctx2 = mkCtx()
  ctx2.result = { schemaVersion: 2 } as unknown as RunContext['result']
  await runPipeline(ctx2, [], pubStore, quietBus, { leaseOwner: 'w-new' })
  assert(pubWrites.includes('publish') && !pubWrites.includes('fail'), 'publish 阶段后崩溃的恢复：stages 为空 + checkpoint result → 幂等补发布（修复前抛「pipeline 缺少阶段实现」）')
}

console.log('\n[P1-6] neutral setup 不得映射为开仓方向')
{
  // 无持仓 + 已确认但无方向的 setup：修复前会被 setup.direction==='bear'?'short':'long' 误映射为开多
  const n = decidePerp({
    ...holdInput,
    position: null,
    structure: { ...baseStructure, confirmedSetup: { ruleId: 'h2', direction: 'neutral' } },
  })
  assert(n.action === 'wait' && n.side === null, 'neutral setup → wait，不输出 conditional_entry（修复前误映射 long）')
  const bull = decidePerp({
    ...holdInput,
    position: null,
    structure: { ...baseStructure, confirmedSetup: { ruleId: 'h2', direction: 'bull' } },
  })
  assert(bull.action === 'conditional_entry' && bull.side === 'long', 'bull setup + 风险计划完整 → conditional_entry（long）不受影响')
}

console.log('\n[八轮-A5] exit 动作必须带触发/解除条件（条件研究，不是即时指令）')
{
  const x = decidePerp({
    ...holdInput,
    structure: { ...baseStructure, recentInvalidations: [{ direction: 'bull', barsAgo: 5 }] },
  })
  assert(x.action === 'exit' && x.conditions.length === 2, 'exit 输出两条条件（触发 + 解除）')
  assert(x.conditions.some((c) => c.includes('触发条件')) && x.conditions.some((c) => c.includes('解除条件')), 'exit 条件含「触发条件」与「解除条件」')
}

console.log('\n[八轮-A2] 资金费率过期（funding_stale）→ 情景不可用，不静默沿用旧数据')
{
  const a = analyzePerp(
    { side: 'long', qty: 1, entryPrice: 60000, leverage: 10, marginMode: 'isolated', stopPrice: 58000, riskBudget: 500, liquidationPrice: null },
    [58000], 60000, 100, [0.0001, 0.0002], DEFAULT_PERP_FEES, 0.001,
    { fundingStale: true, fundingStaleNote: '最新费率距决策 12h' },
  )
  assert(a.fundingStale === true && a.fundingScenarios.length === 0 && a.fundingNote.includes('funding_stale'), 'fundingStale → 情景为空且注明 funding_stale（即便有旧费率数据）')
  const b = analyzePerp(
    { side: 'long', qty: 1, entryPrice: 60000, leverage: 10, marginMode: 'isolated', stopPrice: 58000, riskBudget: 500, liquidationPrice: null },
    [58000], 60000, 100, [0.0001, 0.0002], DEFAULT_PERP_FEES, 0.001,
  )
  assert(b.fundingStale === false && b.fundingScenarios.length === 3, '未过期时情景正常输出（对照）')
}

console.log('\n[八轮-A1] 费率两腿：限价/回踩入场用 maker 档')
{
  const a = analyzePerp(
    { side: 'long', qty: 1, entryPrice: 60000, leverage: 10, marginMode: 'isolated', stopPrice: 58000, riskBudget: 500, liquidationPrice: null },
    [66000], 60000, 100, [], DEFAULT_PERP_FEES, 0.001,
    { entryStyle: 'limit' },
  )
  // 限价入场费 60000×0.0002 = 12（市价档为 30）；平仓腿仍市价 66000×0.0007 = 46.2
  assert(near(a.feeLegs.entryRate, 0.0002) && near(a.feeLegs.exitRate, 0.0007) && a.feeLegs.note.includes('maker'), 'feeLegs 注明入场 maker 0.0002 / 平仓 0.0007')
  assert(a.pnlPoints[0] !== undefined && near(a.pnlPoints[0].tradeNetPnl, 6000 - 12 - 46.2, 1e-3), `限价入场净盈亏 5941.8（实际 ${a.pnlPoints[0]?.tradeNetPnl}）`)
}

console.log('\n[八轮-A3] 仓位上限多约束取最小并输出 bindingConstraint')
{
  const a = analyzePerp(
    { side: 'long', qty: 0.1, entryPrice: 60000, leverage: 10, marginMode: 'isolated', stopPrice: 59000, riskBudget: 100, liquidationPrice: null },
    [59000], 60000, 100, [], DEFAULT_PERP_FEES, 0.001,
    { minNotional: 10000 },
  )
  assert(!a.riskCap.ok && a.riskCap.bindingConstraint === 'min_notional', 'minNotional 约束触发 → riskCap 拒绝且 bindingConstraint=min_notional')
  const b = analyzePerp(
    { side: 'long', qty: 0.1, entryPrice: 60000, leverage: 10, marginMode: 'isolated', stopPrice: 59000, riskBudget: 100, liquidationPrice: null },
    [59000], 60000, 100, [], DEFAULT_PERP_FEES, 0.001,
  )
  assert(b.riskCap.ok && b.riskCap.bindingConstraint === 'risk_budget', '默认约束触发 → bindingConstraint=risk_budget')
}

console.log('\n[八轮-B1/B2] 校验器：perp 方向逻辑 + 版本一致性')
{
  const base = { claims: [], counterClaims: [], knownEvidenceIds: new Set<string>(), modelVersion: 'm1', frozenConfigHash: 'h1', runtimeConfigHash: 'h1' }
  const badLong = validateResearch({ ...base, perp: { positionLogic: { side: 'long', entryPrice: 60000, stopPrice: 61000 } } })
  assert(!badLong.ok && badLong.issues.some((i) => i.code === 'direction_logic'), '多头止损高于入场 → direction_logic 拒绝')
  const badShort = validateResearch({ ...base, perp: { positionLogic: { side: 'short', entryPrice: 60000, targetPrice: 61000 } } })
  assert(!badShort.ok && badShort.issues.some((i) => i.code === 'direction_logic'), '空头目标高于入场 → direction_logic 拒绝')
  const goodLong = validateResearch({ ...base, perp: { positionLogic: { side: 'long', entryPrice: 60000, stopPrice: 59000, targetPrice: 62000 } } })
  assert(goodLong.ok, '方向逻辑一致（止损 59000 < 入场 60000 < 目标 62000）→ 通过')
  const drift = validateResearch({ ...base, runtimeConfigHash: 'h2' })
  assert(!drift.ok && drift.issues.some((i) => i.code === 'version_mismatch'), '运行配置哈希 ≠ 冻结哈希 → version_mismatch 拒绝发布')
  const numTol = validateResearch({ ...base, perp: { breakevenOrPnl: { computed: 6000.0005, reported: 6000, label: '保证金', tolerance: 1e-3 } } })
  assert(numTol.ok, 'breakevenOrPnl 支持调用方容差（1e-3 内通过）')
  const numBad = validateResearch({ ...base, perp: { breakevenOrPnl: { computed: 6001, reported: 6000, label: '保证金', tolerance: 1e-3 } } })
  assert(!numBad.ok && numBad.issues.some((i) => i.code === 'numeric_mismatch'), '超出容差 → numeric_mismatch')
}

console.log('\n[八轮-C2] 预测命中率统计：estimated 与 user_confirmed 分列')
{
  const stats = summarizePredictionStats([
    { probabilityUp: 0.7, estimatedOutcome: 'above', userConfirmedOutcome: 'below' },
    { probabilityUp: 0.3, estimatedOutcome: 'below', userConfirmedOutcome: 'below' },
    { probabilityUp: 0.6, estimatedOutcome: 'tie', userConfirmedOutcome: null },
    { probabilityUp: null, estimatedOutcome: 'above', userConfirmedOutcome: 'above' },
  ])
  assert(stats.estimated.count === 3 && stats.estimated.hits === 2 && stats.estimated.hitRate !== null && near(stats.estimated.hitRate, 2 / 3), 'estimated 轨：3 条有效（tie 计入分母不算命中；null 概率跳过）命中 2')
  assert(stats.userConfirmed.count === 2 && stats.userConfirmed.hits === 1 && near(stats.userConfirmed.hitRate ?? -1, 0.5), 'user_confirmed 轨：2 条有效命中 1（与 estimated 互不合并）')
  const empty = summarizePredictionStats([])
  assert(empty.estimated.count === 0 && empty.estimated.hitRate === null && empty.userConfirmed.hitRate === null, '空集 hitRate=null 而非 0')
}

console.log('\n[九轮-1] 已有持仓保护止损：浮盈上移越过入场价合法，结合当前价判断')
{
  const base = { claims: [], counterClaims: [], knownEvidenceIds: new Set<string>(), modelVersion: 'm1', frozenConfigHash: 'h1', runtimeConfigHash: 'h1' }
  // 评审复现用例：多头入场 60000、止损上移 65000（保护止损）、当前价 66000 —— 修复前被「止损未低于入场」误拒
  const protLong = validateResearch({ ...base, perp: { positionLogic: { side: 'long', entryPrice: 60000, stopPrice: 65000, isExistingPosition: true, lastPrice: 66000 } } })
  assert(protLong.ok, '多头持仓浮盈保护止损（stop 65000 > 入场 60000，< 当前价 66000）→ 通过（修复前误拒）')
  const protShort = validateResearch({ ...base, perp: { positionLogic: { side: 'short', entryPrice: 60000, stopPrice: 58000, isExistingPosition: true, lastPrice: 57000 } } })
  assert(protShort.ok, '空头持仓浮盈保护止损（stop 58000 < 入场 60000，> 当前价 57000）→ 通过（修复前误拒）')
  const overLong = validateResearch({ ...base, perp: { positionLogic: { side: 'long', entryPrice: 60000, stopPrice: 67000, isExistingPosition: true, lastPrice: 66000 } } })
  // 语义更新（本轮验收）：已穿越当前价的止损=已触发，不再拒绝整run——
  // 由 DecisionPolicy 止损触发分支输出 exit 条件研究（见「止损触发」用例组）
  assert(overLong.ok, '多头持仓止损 67000 已被当前价 66000 穿越 → 校验放行（决策层给 exit 建议，不再拒绝）')
  const overShort = validateResearch({ ...base, perp: { positionLogic: { side: 'short', entryPrice: 60000, stopPrice: 56000, isExistingPosition: true, lastPrice: 57000 } } })
  assert(overShort.ok, '空头持仓止损 56000 已被当前价 57000 穿越 → 校验放行（决策层给 exit 建议，不再拒绝）')
  // 新仓语义保持：止损必须在入场亏损侧（不结合当前价豁免）
  const newBad = validateResearch({ ...base, perp: { positionLogic: { side: 'long', entryPrice: 60000, stopPrice: 61000, isExistingPosition: false } } })
  assert(!newBad.ok && newBad.issues.some((i) => i.code === 'direction_logic'), '新仓多头止损 61000 高于入场 60000 → 仍拒绝（新仓规则不放松）')
  const newGood = validateResearch({ ...base, perp: { positionLogic: { side: 'long', entryPrice: 60000, stopPrice: 59000, isExistingPosition: false } } })
  assert(newGood.ok, '新仓多头止损 59000 低于入场 → 通过')
}

console.log('\n[九轮-2] 版本一致性：哈希取 run 行持久化冻结配置，Admin 新发布不影响旧任务')
{
  // validate 阶段的 runtimeHash 现在来自 hashFrozenConfig(run 行持久化值)——
  // 纯函数验证：同一冻结配置（含发布后已变化的当前配置无关字段）两次哈希稳定；
  // 改变内容才导致漂移。freezeRunConfig 不再被 validate 调用（代码路径审查 + 哈希语义）
  const frozen = {
    label: 'v1',
    budgets: { maxLlmCalls: 6, maxToolCalls: 20, maxSearchCalls: 2, maxRuntimeMs: 60000 },
    knowledgeVersionId: 'kv-1',
    raw: { retrieval: { finalLimit: 8 } },
    fees: { takerRate: 0.0005, makerRate: 0.0002, slippageRate: 0.0002 },
    stepSize: 0.001,
    minNotional: 100,
    fundingWindow: { intervalMs: 28800000, graceMs: 3600000 },
  }
  const h1 = hashFrozenConfig(frozen)
  const h2 = hashFrozenConfig({ ...frozen })
  assert(h1 === h2 && h1.length === 64, '同一冻结配置重复哈希稳定（run 行重算与创建时一致 → 旧任务不因新发布失败）')
  const h3 = hashFrozenConfig({ ...frozen, raw: { retrieval: { finalLimit: 9 } } })
  assert(h1 !== h3, '冻结配置内容变化 → 哈希漂移（version_mismatch 仍能拦截运行中篡改）')
  const base = { claims: [], counterClaims: [], knownEvidenceIds: new Set<string>(), modelVersion: null, frozenConfigHash: h1, runtimeConfigHash: hashFrozenConfig(frozen) }
  const same = validateResearch(base)
  assert(same.ok, '持久化冻结配置重算哈希 = 冻结哈希 → 通过（Admin 发布新版本后旧 run 不再误报 version_mismatch）')
}

console.log('\n[九轮-3] 意图路由：「预测一周涨跌」→ 方向研究，不再落入事件合约研究')
{
  assert(classifyIntent('预测 BTCUSDT 一周涨跌') === 'structure', '「预测 BTCUSDT 一周涨跌」→ structure（teaching + 1w 方向研究；修复前因「涨跌」误入 event）')
  assert(classifyIntent('BTCUSDT 下周走势怎么看') === 'structure', '「下周走势」→ structure（方向研究措辞）')
  assert(classifyIntent('BTCUSDT 10 分钟内会高于 65000 吗，事件合约怎么算') === 'event', '事件合约语义（高于执行价）→ 仍为 event（不误伤）')
  assert(classifyIntent('我 0.5 个 BTC 做多，入场价 60000，风险预算 500') === 'perp', '持仓语义 → perp（不误伤）')
  assert(classifyIntent('BTCUSDT 现在什么结构') === 'structure', '普通结构问题 → structure（不误伤）')
}

console.log('\n[九轮-4] 校准后分位网格：三分支概率经 isotonic 重映射 level 计算')
{
  // 模拟 isotonic 重映射后网格（名义 0.05→0.07 等）：概率内插以映射后 level 为准；
  // 验证 Node 端内插函数对「校准后网格」按新 key 工作（映射由 research-py 工件提供，
  // 此处验证消费端语义：level 重映射改变概率，值不变）
  const nominal = { '0.05': -0.02, '0.5': 0.001, '0.95': 0.025 }
  const calibrated = { '0.07': -0.02, '0.52': 0.001, '0.93': 0.025 }
  const th = Math.log(65000 / 64900) // ≈ 0.000154
  const pNom = probAboveFromQuantileGrid(nominal, th)
  const pCal = probAboveFromQuantileGrid(calibrated, th)
  assert(pNom !== null && pCal !== null && Math.abs(pNom - pCal) > 1e-4, '同一分位值、不同（校准后）level 网格 → 概率不同（推理确实经过映射）')
  // 边界：校准后网格仍要求 ≥3 个点（py 端保证 7 分位 → 映射后 key 去重仍 ≥3）
  assert(probAboveFromQuantileGrid({ '0.5': 0.001 }, th) === null, '网格点数 <3 → null（tail 语义不变）')
}

console.log('\n[九轮-5] 角色模板驱动反证审查者：promptRef 解析与回退')
{
  const inline = await resolveRolePrompt('inline: 自定义反证模板 v2')
  assert(inline === '自定义反证模板 v2', 'promptRef inline:<文本> → 直接使用配置内联模板')
  assert((await resolveRolePrompt('inline:')) === null, 'inline 空文本 → null（回退工程默认模板）')
  assert((await resolveRolePrompt('../secrets')) === null, 'promptRef 含路径穿越 → 拒绝')
  assert((await resolveRolePrompt('not-exist-template')) === null, '模板文件不存在 → null（回退并在日志注明）')
}

console.log('\n[止损触发] 当前价已穿越用户确认的止损价 → exit（修复前可能 hold/reduce）')
{
  const a = decidePerp({
    ...holdInput,
    position: { side: 'long' as const, isStale: false, stopPrice: 58000, lastPrice: 57900 },
  })
  assert(a.action === 'exit', '多头当前价 57900 ≤ 止损 58000 → exit（不再 hold）')
  assert(a.reasons.some((r) => r.includes('止损触发')), 'exit 理由说明止损触发（价格维度）')
  const b = decidePerp({
    ...holdInput,
    position: { side: 'short' as const, isStale: false, stopPrice: 62000, lastPrice: 62100 },
  })
  assert(b.action === 'exit', '空头当前价 62100 ≥ 止损 62000 → exit（对称）')
  const c = decidePerp({
    ...holdInput,
    position: { side: 'long' as const, isStale: false, stopPrice: 58000, lastPrice: 60000 },
  })
  assert(c.action === 'hold', '价格未穿越止损（60000 > 58000）→ 仍按结构 hold（不误触发）')
  const e = decidePerp({
    ...holdInput,
    position: { side: 'long' as const, isStale: false, stopPrice: null, lastPrice: 57000 },
  })
  assert(e.action === 'wait' && e.reasons.some((r) => r.includes('未设置止损')), '无止损价（未知）→ wait 要求补全止损（评审 F1：风险约束不可用，不走结构分支输出 hold）')
}

console.log('\n[方向门控] 事件参与：报价方向适用性 + 反证结论进入最终建议')
{
  const { gateEventDirection, applyEventDirectionGate } = await import('../server/src/services/decisionPolicy.js')
  // 用户合成复现场景：两周期均空头、报价看涨（above）→ 必须否决
  const veto = gateEventDirection({
    quoteDirection: 'above', execDirection: 'bear', backgroundDirection: 'bear',
    linkedCounterClaims: 2, counterSummaries: ['结构反证：空头趋势完好'],
  })
  assert(veto.verdict === 'veto' && veto.reasons.some((r) => r.includes('理论适用性否决')), '双空头 + 看涨报价 → veto（修复前仅看无冲突即可通过）')
  // 单周期反向同样否决
  const veto2 = gateEventDirection({
    quoteDirection: 'below', execDirection: 'bull', backgroundDirection: 'bear',
    linkedCounterClaims: 0, counterSummaries: [],
  })
  assert(veto2.verdict === 'veto', '执行周期多头 + 看跌报价 → veto（任一非中性反向即否决）')
  // 双中性 → 证据不足（不是通过）
  const ins = gateEventDirection({
    quoteDirection: 'above', execDirection: 'neutral', backgroundDirection: 'neutral',
    linkedCounterClaims: 0, counterSummaries: [],
  })
  assert(ins.verdict === 'insufficient' && ins.reasons.some((r) => r.includes('方向证据不足')), '双中性 → insufficient（交易区间不提供方向优势）')
  // 顺势 → 通过且附反证审查结论
  const pass = gateEventDirection({
    quoteDirection: 'above', execDirection: 'bull', backgroundDirection: 'neutral',
    linkedCounterClaims: 3, counterSummaries: [],
  })
  assert(pass.verdict === 'pass' && pass.reasons.some((r) => r.includes('反证审查')), '顺势 → pass 且输出反证审查结论')
  // 决策改写：conditional_entry 被否决 → wait（含解除条件）
  const rewritten = applyEventDirectionGate(
    { action: 'conditional_entry', side: null, reasons: ['EV=1>0 且五门槛通过（预算已确认）'], conditions: [] },
    { quoteDirection: 'above', execDirection: 'bear', backgroundDirection: 'bear', linkedCounterClaims: 1, counterSummaries: ['反例：区间内突破常失败'] },
  )
  assert(rewritten.action === 'wait' && rewritten.reasons.some((r) => r.includes('理论适用性否决')) && rewritten.reasons.some((r) => r.includes('反证佐证')), '否决改写：conditional_entry → wait，理由含否决与反证佐证')
  assert(rewritten.reasons.every((r) => !r.includes('五门槛')), '否决时清除「五门槛通过」误导性理由')
  assert(rewritten.conditions.some((c) => c.includes('解除条件')), '否决输出解除条件')
  const kept = applyEventDirectionGate(
    { action: 'conditional_entry', side: null, reasons: ['EV=1>0 且五门槛通过'], conditions: [] },
    { quoteDirection: 'below', execDirection: 'bear', backgroundDirection: 'bear', linkedCounterClaims: 0, counterSummaries: [] },
  )
  assert(kept.action === 'conditional_entry' && kept.reasons.some((r) => r.includes('理论适用性通过')), '通过路径：保持 conditional_entry 并附通过理由')
}

console.log('\n[评审 F1] 无止损持仓：风险约束不可用，不得输出 hold')
{
  const noStop = {
    ...holdInput,
    position: { side: 'long' as const, isStale: false, stopPrice: null, lastPrice: 60000 },
  }
  const d = decidePerp(noStop)
  assert(d.action === 'wait' && d.reasons.some((r) => r.includes('未设置止损')), '无止损持仓 → wait 且要求补全止损（修复前可输出 hold）')
  const withStop = decidePerp(holdInput)
  assert(withStop.action === 'hold', '有止损+结构支持 → hold（不误伤）')
}

console.log('\n[评审 F8] 特征窗口：ret_240 需要 closes[i-240]，最小根数 241（240 根静默补零已修复）')
{
  assert(MIN_BARS === 241, 'MIN_BARS=241')
  const c240 = Array.from({ length: 240 }, (_, i) => 100 + i)
  assert(featuresAt(c240, 239) === null, '恰 240 根 → 特征不可用（修复前 ret_240 静默为 0）')
  const c241 = [...c240, 340]
  const f = featuresAt(c241, 240)
  assert(f !== null && f.ret_240 !== 0, `241 根 → ret_240 实际计算（${f?.ret_240.toFixed(4)}）`)
}

console.log('\n[评审 F11] 数值红线：LLM 反证文本任何情况不得含概率/胜率数字')
{
  const r1 = validateResearch({
    claims: [], counterClaims: [{ text: '反证：该形态历史胜率：90%', evidenceIds: [] }],
    knownEvidenceIds: new Set(), modelVersion: 'fv-evt-r-1h', frozenConfigHash: null, runtimeConfigHash: null,
  })
  assert(!r1.ok && r1.issues.some((i) => i.code === 'fabricated_number'), 'modelVersion 存在时反证写「胜率：90%」→ 拒绝（修复前通过）')
  const r2 = validateResearch({
    claims: [{ text: '结构保持良好', kind: 'interpretation' as const, evidenceIds: [] }],
    counterClaims: [{ text: '未见反向结构确认', evidenceIds: [] }],
    knownEvidenceIds: new Set(), modelVersion: 'fv-evt-r-1h', frozenConfigHash: null, runtimeConfigHash: null,
  })
  assert(r2.ok, '无概率数字的反证/解释 → 通过（不误伤）')
}

console.log('\n[评审 F7] 复盘日期：显式日期解析；无法解析返回 invalid/undefined（调用方请求补全，不用当前冒充历史）')
{
  const t = parseReplayAsOf('复盘 2026-10-01 的 BTC')
  assert(typeof t === 'number' && new Date(t).toISOString().startsWith('2026-10-01T15:59'), '「2026-10-01」→ UTC+8 当日 23:59:59')
  assert(parseReplayAsOf('复盘 2026-13-40') === 'invalid', '非法日期 → invalid')
  assert(parseReplayAsOf(`复盘 ${new Date(Date.now() + 86400_000).getUTCFullYear() + 1}-01-01`) === 'invalid', '未来日期 → invalid')
  assert(parseReplayAsOf('复盘一下') === undefined, '无日期 → undefined（调用方出补全提示）')
  assert(typeof parseReplayAsOf('复盘昨天的走势') === 'number', '「昨天」保持可用')
}

console.log('\n[评审 F6] 持仓草稿：必填槽位检测 + 共享 PositionInputSchema 校验')
{
  assert(missingPositionFields({ side: 'long', qty: 0.1 }).join(',') === 'symbol,entryPrice,riskBudget', '「做多 0.1」缺 symbol/entryPrice/riskBudget')
  assert(missingPositionFields({ symbol: 'BTCUSDT', side: 'long', qty: 0.1, entryPrice: 60000, riskBudget: 200 }).length === 0, '字段齐全 → 可确认')
  const ok = PositionInputSchema.safeParse({ symbol: 'BTCUSDT', side: 'long', qty: '0.1', entryPrice: '60000', leverage: 10, marginMode: 'isolated', riskBudget: '200', confirmedAt: 1 })
  assert(ok.success, '合法草稿过 schema')
  assert(!PositionInputSchema.safeParse({ symbol: 'BTCUSDT', side: 'north', qty: '0.1', entryPrice: '60000', leverage: 10, marginMode: 'isolated', riskBudget: '200', confirmedAt: 1 }).success, '非法方向被 schema 拒绝')
  assert(!PositionInputSchema.safeParse({ symbol: 'BTCUSDT', side: 'long', qty: '-0.1', entryPrice: '60000', leverage: 10, marginMode: 'isolated', riskBudget: '200', confirmedAt: 1 }).success, '非正数量被 schema 拒绝')
  assert(!PositionInputSchema.safeParse({ symbol: 'BTCUSDT', side: 'long', qty: '0.1', entryPrice: '60000', leverage: 200, marginMode: 'isolated', riskBudget: '200', confirmedAt: 1 }).success, '越界杠杆被 schema 拒绝')
}

console.log('\n[复审 R1] 质量门控看完整问题集合（与排序无关）')
{
  assert(hasBlockingQualityIssue([{ code: 'insufficient_history' }, { code: 'stale_market' }]), '[insufficient_history, stale_market] → 阻断（修复前只看第一项会放行）')
  assert(hasBlockingQualityIssue([{ code: 'stale_market' }, { code: 'insufficient_history' }]), '[stale_market, insufficient_history] → 阻断')
  assert(hasBlockingQualityIssue([{ code: 'insufficient_history' }, { code: 'window_gap' }, { code: 'stale_reference_price' }]), '缺口/参考价异常 → 阻断')
  assert(!hasBlockingQualityIssue([{ code: 'insufficient_history' }]), '仅 insufficient_history → 不阻断（特征门槛另行把关）')
  assert(!hasBlockingQualityIssue([]), '无问题 → 不阻断')
}

console.log('\n[复审 R3] 复盘具体时刻按该时刻解析（不再一律日末）')
{
  const t1 = parseReplayAsOf('复盘 2026-10-01 10:00 的 BTCUSDT')
  assert(typeof t1 === 'number' && new Date(t1).toISOString() === '2026-10-01T02:00:00.000Z', '2026-10-01 10:00（UTC+8）→ 02:00Z')
  const t2 = parseReplayAsOf('复盘 2026-10-01 20:00 的 BTCUSDT')
  assert(typeof t2 === 'number' && new Date(t2).toISOString() === '2026-10-01T12:00:00.000Z', '2026-10-01 20:00 → 12:00Z（不同时刻结果不同）')
  const t3 = parseReplayAsOf('复盘 2026-10-01 10点30分')
  assert(typeof t3 === 'number' && new Date(t3).toISOString() === '2026-10-01T02:30:00.000Z', '「10点30分」→ 02:30Z')
  assert(parseReplayAsOf('复盘 2026-10-01 25:00') === 'invalid', '非法时刻 25:00 → invalid')
  const t0 = parseReplayAsOf('复盘 2026-10-01 的 BTC')
  assert(typeof t0 === 'number' && new Date(t0).toISOString().startsWith('2026-10-01T15:59'), '仅日期 → 当日 23:59:59（约定保留）')
}

console.log('\n[复审 R6] 概率文本绕过形态全部拒绝')
{
  const phrases = ['胜率约90%', '获胜概率为0.9', '90% 的胜率', 'win rate: 90%', '概率高达 99%']
  for (const p of phrases) {
    const r = validateResearch({
      claims: [], counterClaims: [{ text: p, evidenceIds: [] }],
      knownEvidenceIds: new Set(), modelVersion: 'fv-evt-r-1h', frozenConfigHash: null, runtimeConfigHash: null,
    })
    assert(!r.ok && r.issues.some((i) => i.code === 'fabricated_number'), `反证「${p}」→ 拒绝`)
  }
  const interp = validateResearch({
    claims: [{ text: '解释：胜率：99%', kind: 'interpretation' as const, evidenceIds: [] }], counterClaims: [],
    knownEvidenceIds: new Set(), modelVersion: 'fv-evt-r-1h', frozenConfigHash: null, runtimeConfigHash: null,
  })
  assert(!interp.ok && interp.issues.some((i) => i.code === 'fabricated_number'), 'modelVersion 存在时解释 claim 含概率 → 拒绝（不再豁免）')
}

console.log('\n[三轮-2] 复盘时刻：限定词/相对日带时刻/裸时刻/不可解析补全')
{
  const t1 = parseReplayAsOf('复盘 2026-10-01 下午3点')
  assert(typeof t1 === 'number' && new Date(t1).toISOString() === '2026-10-01T07:00:00.000Z', '下午3点 → 15:00（UTC+8）= 07:00Z')
  const t2 = parseReplayAsOf('复盘 2026-10-01 10时30分')
  assert(typeof t2 === 'number' && new Date(t2).toISOString() === '2026-10-01T02:30:00.000Z', '「10时30分」→ 02:30Z（时=点别名）')
  const fixedNow = Date.UTC(2026, 9, 13, 8, 0) // 2026-10-13 16:00（UTC+8）
  const t3 = parseReplayAsOf('复盘昨天10:00', fixedNow)
  assert(typeof t3 === 'number' && new Date(t3).toISOString() === '2026-10-12T02:00:00.000Z', '昨天10:00 → 昨日 10:00（修复前=昨日 16:00 混入后续数据）')
  assert(parseReplayAsOf('复盘 2026-10-01 下午') === 'invalid', '有限定词无时刻 → invalid（请求补全，不退回日末）')
  const t5 = parseReplayAsOf('复盘 10:00', fixedNow)
  assert(typeof t5 === 'number' && new Date(t5).toISOString() === '2026-10-13T02:00:00.000Z', '裸时刻 → 今天该时刻')
  assert(parseReplayAsOf('复盘 23:00', fixedNow) === 'invalid', '裸时刻今天未到 → invalid')
}

console.log('\n[三轮-3] resolveLlmClient：显式传入冻结配置时严格尊重（含关闭），不回退全局')
{
  assert(resolveLlmClient({ chat: { enabled: false } }) === null, '冻结 chat.enabled=false（无 baseUrl）→ null（修复前回退全局配置）')
  assert(resolveLlmClient(null) === null, '冻结 capabilities=null → null')
  assert(resolveLlmClient({ chat: { enabled: true, baseUrl: 'http://127.0.0.1:9', model: 'm' } }) !== null, '冻结 chat 完整 → 用冻结值构造')
}

console.log('\n[三轮-5] 概率红线共现规则：措辞/语序无关')
{
  for (const p of ['胜率大约为90%', '上涨概率达到90%', '胜率超过80%']) {
    const r = validateResearch({
      claims: [], counterClaims: [{ text: p, evidenceIds: [] }],
      knownEvidenceIds: new Set(), modelVersion: null, frozenConfigHash: null, runtimeConfigHash: null,
    })
    assert(!r.ok && r.issues.some((i) => i.code === 'fabricated_number'), `「${p}」→ 拒绝`)
  }
  const ok1 = validateResearch({
    claims: [], counterClaims: [{ text: '该结构近期涨幅约 5%，未见反转信号', evidenceIds: [] }],
    knownEvidenceIds: new Set(), modelVersion: null, frozenConfigHash: null, runtimeConfigHash: null,
  })
  assert(ok1.ok, '无概率词的百分比（涨幅 5%）→ 不误伤')
  const ok2 = validateResearch({
    claims: [], counterClaims: [{ text: '形态概率无法从现有证据估计', evidenceIds: [] }],
    knownEvidenceIds: new Set(), modelVersion: null, frozenConfigHash: null, runtimeConfigHash: null,
  })
  assert(ok2.ok, '概率词无数字 → 不误伤')
}

console.log('\n[四轮-1] 时刻解析不截断表达：「半」=30 分；「N秒」不带分')
{
  const t1 = parseReplayAsOf('复盘 2026-10-01 10点半')
  assert(typeof t1 === 'number' && new Date(t1).toISOString() === '2026-10-01T02:30:00.000Z', '10点半 → 10:30（修复前半被忽略成 10:00）')
  const t2 = parseReplayAsOf('复盘 2026-10-01 10点30秒')
  assert(typeof t2 === 'number' && new Date(t2).toISOString() === '2026-10-01T02:00:30.000Z', '10点30秒 → 10:00:30（修复前误读为 10:30，多纳入 29 分 30 秒数据）')
  const t3 = parseReplayAsOf('复盘 2026-10-01 10点30分25秒')
  assert(typeof t3 === 'number' && new Date(t3).toISOString() === '2026-10-01T02:30:25.000Z', '10点30分25秒 → 10:30:25')
  const t4 = parseReplayAsOf('复盘 2026-10-01 10点30分')
  assert(typeof t4 === 'number' && new Date(t4).toISOString() === '2026-10-01T02:30:00.000Z', '10点30分 → 10:30（不回归）')
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
