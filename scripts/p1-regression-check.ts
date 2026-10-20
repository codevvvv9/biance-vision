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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ===========================================================================
// 2026-10-20 评审八项修复回归（P1 终验补充：隔离性 / 上下文继承 / 预算约束）
// ===========================================================================

console.log('\n[R-评审#2] 综合解释全句校验：来源锚定 + 决策一致性（不只带 [k] 的句子；2026-10-20 第二轮四个边界）')
{
  const { checkSynthesisText, synthesisUserPrompt } = await import('../server/src/research/runs/synthesis.js')
  const input = {
    question: '现在的结构如何',
    symbol: 'BTCUSDT',
    horizon: '1h',
    decision: { action: 'wait', side: null as 'long' | 'short' | null, reasons: ['等待回调确认'], conditions: ['回调不破前低'] },
    claims: [{ text: 'BTC 15m：状态 多头趋势', kind: 'fact' as const, evidenceIds: [] }],
    counterClaims: [],
    scenarios: [],
    evidenceTexts: ['多头趋势延续，执行周期不断创新高，关键支撑 60000'],
  }
  // 评审复现句 1：无引用、无数字、与任何来源（证据/facts/决策）无词项重叠 → 无来源剔除
  const a = checkSynthesisText('天气晴朗，适合外出旅行。', input)
  assert(a.by.unsupported === 1 && a.kept.length === 0, '「天气晴朗，适合外出旅行」被来源锚定剔除（修复前无 [k] 句不检查）')
  // 评审复现句 2：满仓 + 无止损指令 → 决策红线剔除
  const b = checkSynthesisText('现在立即满仓做多，无需设置止损。', input)
  assert(b.by.decision === 1 && b.kept.length === 0, '「立即满仓做多，无需止损」被决策红线剔除（修复前照常发布）')
  // 第二轮 #1：「当」单字误判条件——「当前结构支持立即做多」不得因「当前」豁免指令检查
  const b2 = checkSynthesisText('当前结构支持立即做多。', input)
  assert(b2.by.decision === 1 && b2.kept.length === 0, '「当前结构支持立即做多」被剔除（「当前」不是条件句；修复前 COND_RE 单字「当」放行）')
  // 无条件方向矛盾（决策 wait/side=null，句含开多指令且无条件词）
  const c = checkSynthesisText('建议做多入场。', input)
  assert(c.by.decision === 1, '决策 wait 下无条件「建议做多」被方向矛盾剔除')
  // 第二轮 #2：动作冲突——exit 决策下「建议加仓继续持有」与已计算动作矛盾
  const exitInput = {
    ...input,
    decision: { action: 'exit' as const, side: null as 'long' | 'short' | null, reasons: ['止损已触发'], conditions: [] },
  }
  const c2 = checkSynthesisText('多头趋势延续，建议加仓继续持有。', exitInput)
  assert(c2.by.decision === 1 && c2.kept.length === 0, 'exit 决策下「建议加仓继续持有」被动作冲突剔除（修复前只查方向不查动作）')
  // 第二轮 #2 输入侧：模型输入必须显式含 decision.action 与 conditions
  const promptBlocks = synthesisUserPrompt(input)
  assert(promptBlocks.factsBlock.includes('当前决策：等待') && promptBlocks.factsBlock.includes('前提条件：回调不破前低'), '模型输入含决策行（action 标签 + 前提条件；修复前缺失）')
  // 第二轮 #3：用户问题复述不得充当事实断言依据（承诺句双保险：红线 + 问题不入来源池）
  const qInput = { ...input, question: '收益稳定有保证吗？' }
  const d0 = checkSynthesisText('收益稳定有保证。', qInput)
  assert(d0.kept.length === 0 && (d0.by.decision === 1 || d0.by.unsupported === 1), '「收益稳定有保证」被剔除（问题措辞不算事实支撑；承诺红线兜底）')
  // 条件句允许讨论反向/反向证据情形（有「若/跌破」条件词 + 数字在证据白名单内）
  const d = checkSynthesisText('若跌破 60000 支撑，可考虑做空。', input)
  assert(d.kept.length === 1, '条件句讨论反向情形不被误伤（条件词 + 白名单数字）')
  // 合法转述句保留（与证据/决策词项重叠；问题词项已不算支撑来源）
  const e = checkSynthesisText('执行周期保持多头趋势，等待回调确认。', input)
  assert(e.kept.length === 1, '与证据/决策词项重叠的转述句保留（不误伤）')
  const e2 = checkSynthesisText('结构支持继续持有。', input)
  assert(e2.kept.length === 0 && e2.by.unsupported === 1, '仅与问题措辞重叠的断言句被剔除（问题 ≠ 事实支撑，2026-10-20 第二轮 #3）')
  // ---- 第三轮（子句级 + 否定语义）：与评审复现脚本 /tmp/bv-731c6b7-boundary-review.mts 同源 ----
  // #1 「等待」绕过：「无需等待…立即做多」与「决策为等待，但建议立即做多」不再被「等待」豁免
  const f1 = checkSynthesisText('无需等待回调确认，立即做多。', input)
  assert(f1.by.decision === 1 && f1.kept.length === 0, '「无需等待回调确认，立即做多」被剔除（等待须带后继动作标记才算条件；修复前裸「等待」放行）')
  const f2 = checkSynthesisText('当前决策为等待，但建议立即做多。', input)
  assert(f2.by.decision === 1 && f2.kept.length === 0, '「决策为等待，但建议立即做多」被剔除（转折后子句不受前文条件约束）')
  // 合法条件句不误伤：「等待…后」精确模式
  const f3 = checkSynthesisText('等待回调确认后再考虑入场。', input)
  assert(f3.kept.length === 1 && f3.dropped === 0, '「等待回调确认后再考虑入场」保留（等待…后 = 真条件表达，不降级）')
  // #2 exit 下「建议继续持有」= 明确动作建议，与退出结论校验一致性
  const f4 = checkSynthesisText('多头趋势延续，建议继续持有。', exitInput)
  assert(f4.by.decision === 1 && f4.kept.length === 0, 'exit 下「建议继续持有」被剔除（持有指令形态 vs {hold,conditional_entry}；描述性「持有」不查）')
  // #3 否定语义不误删：「不能保证收益」/「暂不减仓」是安全表述
  const f5 = checkSynthesisText('多头趋势延续，但不能保证收益。', input)
  assert(f5.kept.length === 1 && f5.dropped === 0, '「不能保证收益」保留（否定剥离；修复前误判收益承诺整句删除）')
  const holdInput = { ...input, decision: { action: 'hold' as const, side: null as 'long' | 'short' | null, reasons: ['结构支持持仓方向'], conditions: [] } }
  const f6 = checkSynthesisText('多头趋势延续，暂不减仓。', holdInput)
  assert(f6.kept.length === 1 && f6.dropped === 0, 'hold 下「暂不减仓」保留（否定剥离；修复前误判动作冲突整句删除）')
  // 问题复述与来源锚定不回归
  const f7 = checkSynthesisText('热气球适合旅行。', { ...input, question: '热气球是否适合旅行？' })
  assert(f7.by.unsupported === 1 && f7.kept.length === 0, '「热气球适合旅行」被剔除（问题措辞不算事实支撑，不回归）')
  // ---- 第四轮（转折重置/既成事实/否定剥离收紧/目标表补全），与 /tmp/bv-47c80c2-boundary-review.mts 同源 ----
  // #1 转折后的子句不受前文条件豁免（分隔词保留、显式重置）
  const g1 = checkSynthesisText('若回调确认，可考虑入场，但现在立即做多。', input)
  assert(g1.by.decision === 1 && g1.kept.length === 0, '「若回调确认…，但现在立即做多」被剔除（转折重置条件作用域；修复前 split 丢「但」整句豁免）')
  const g1c = checkSynthesisText('现在立即做多。', input)
  assert(g1c.by.decision === 1, '对照：无条件句「现在立即做多」仍剔除（不回归）')
  // #2 既成事实不是条件：「已/经/曾 触发」不开启豁免
  const g2 = checkSynthesisText('止损已触发，立即加仓。', exitInput)
  assert(g2.by.decision === 1 && g2.kept.length === 0, '「止损已触发，立即加仓」被剔除（触发带 已/经/曾 负向断言；修复前裸「触发」当条件豁免）')
  // #3 肯定强调语不被否定剥离：「不妨满仓」「不仅保证」原样保留给红线检查
  const g3 = checkSynthesisText('多头趋势延续，不妨满仓参与。', input)
  assert(g3.by.decision === 1 && g3.kept.length === 0, '「不妨满仓参与」被剔除（单字否定须紧邻目标词；修复前「不妨满仓」被误剥放行）')
  const g3b = checkSynthesisText('多头趋势延续，不仅保证收益。', input)
  assert(g3b.by.decision === 1 && g3b.kept.length === 0, '「不仅保证收益」被剔除（修复前「不仅保证」被误剥放行承诺红线）')
  // #4 否定目标表补全：「不建议继续持有」「暂不开仓」不再误删
  const g4 = checkSynthesisText('多头趋势延续，但不建议继续持有。', exitInput)
  assert(g4.kept.length === 1 && g4.dropped === 0, 'exit 下「不建议继续持有」保留（持有入否定目标表；修复前误删回退模板）')
  const g5 = checkSynthesisText('多头趋势延续，暂不开仓。', input)
  assert(g5.kept.length === 1 && g5.dropped === 0, 'wait 下「暂不开仓」保留（开仓入否定目标表；修复前误判动作冲突）')
  // ---- 第五轮（条件豁免只认明确假设表达 + 强调结构不做否定剥离），与 /tmp/bv-5fbb7c6-boundary-review.mts 同源 ----
  // #1a 裸「条件」不再开启豁免：现状描述（条件尚未满足）之后照常检查
  const h1 = checkSynthesisText('多头趋势延续，入场条件尚未满足，立即做多。', input)
  assert(h1.by.decision === 1 && h1.kept.length === 0, '「入场条件尚未满足，立即做多」被剔除（「条件」须带 后/时/再 才算假设；修复前裸词豁免）')
  // #1b 完成态负向断言补「被/正/未」：「已经被触发」「已经跌破」是既成事实不豁免
  const h2 = checkSynthesisText('止损已经被触发，立即加仓。', exitInput)
  assert(h2.by.decision === 1 && h2.kept.length === 0, '「止损已经被触发，立即加仓」被剔除（被动式紧邻字「被」；修复前只查已/经/曾）')
  const h3 = checkSynthesisText('关键支撑已经跌破，立即加仓。', exitInput)
  assert(h3.by.decision === 1 && h3.kept.length === 0, '「关键支撑已经跌破，立即加仓」被剔除（「跌破」带完成态断言；修复前裸词豁免）')
  // #2 强调结构（双重否定）= 肯定语义，不做否定剥离
  const h4 = checkSynthesisText('多头趋势延续，不得不满仓参与。', input)
  assert(h4.by.decision === 1 && h4.kept.length === 0, '「不得不满仓参与」被剔除（EMPHATIC 结构不剥离；修复前剥「不满仓」放行）')
  const h5 = checkSynthesisText('多头趋势延续，非满仓不可。', input)
  assert(h5.by.decision === 1 && h5.kept.length === 0, '「非满仓不可」被剔除（EMPHATIC 结构不剥离；修复前剥「非满仓」放行）')
  // 对照：真否定与真条件句不误伤
  const h6 = checkSynthesisText('多头趋势延续，不应满仓参与。', input)
  assert(h6.kept.length === 1 && h6.dropped === 0, '对照：「不应满仓参与」保留（真否定仍剥离）')
  const h7 = checkSynthesisText('若跌破关键支撑，再评估退出。', input)
  assert(h7.kept.length === 1 && h7.dropped === 0, '对照：「若跌破关键支撑，再评估退出」保留（真假设表达仍豁免）')
  // ---- 第六轮（裸事件词豁免移除 + 强调结构子句级化），与 /tmp/bv-2f79536-boundary-review.mts 同源 ----
  // #1 后缀完成态「了」不再绕过：裸触发/跌破/突破已移除，事件词只在「…时/后/再」结构中算假设
  const i1 = checkSynthesisText('止损触发了，立即加仓。', exitInput)
  assert(i1.by.decision === 1 && i1.kept.length === 0, '「止损触发了，立即加仓」被剔除（裸事件词豁免已移除；修复前「了」绕过完成态断言）')
  const i2 = checkSynthesisText('关键支撑跌破了，立即加仓。', exitInput)
  assert(i2.by.decision === 1 && i2.kept.length === 0, '「关键支撑跌破了，立即加仓」被剔除（同上）')
  const i3 = checkSynthesisText('若触发止损，再评估退出。', exitInput)
  assert(i3.kept.length === 1 && i3.dropped === 0, '对照：「若触发止损，再评估退出」保留（假设连接词仍豁免）')
  // #2 强调结构只保护它所在的子句：无关子句的「不能保证收益」照常剥离
  const i4 = checkSynthesisText('多头趋势延续，不能不注意风险，但不能保证收益。', input)
  assert(i4.kept.length === 1 && i4.dropped === 0, '「不能不注意风险，但不能保证收益」整句保留（EMPHATIC 子句级化；修复前句级短路误删）')
  const i5 = checkSynthesisText('多头趋势延续，应注意风险，但不能保证收益。', input)
  assert(i5.kept.length === 1 && i5.dropped === 0, '对照：无强调结构版本同样保留（不回归）')
  const i6 = checkSynthesisText('多头趋势延续，保证收益。', input)
  assert(i6.by.decision === 1 && i6.kept.length === 0, '对照：「保证收益」无否定前缀仍剔除（承诺红线不受剥离影响）')
  // ---- 第七轮（被否定的等待不豁免 + 时间标记完整结构），与 /tmp/bv-570453d-boundary-review.mts 同源 ----
  // #1 「无需等待…后再」= 条件被否定，不开启豁免
  const j1 = checkSynthesisText('无需等待回调确认后再入场，立即做多。', input)
  assert(j1.by.decision === 1 && j1.kept.length === 0, '「无需等待…后再入场，立即做多」被剔除（等待模式带否定断言；修复前局部命中「等待…后」仍豁免）')
  const j1c = checkSynthesisText('无需等待回调确认，立即做多。', input)
  assert(j1c.by.decision === 1, '对照：无后缀版「无需等待…立即做多」仍剔除（三轮行为不回归）')
  const j2 = checkSynthesisText('等待回调确认后再考虑入场。', input)
  assert(j2.kept.length === 1 && j2.dropped === 0, '对照：「等待回调确认后再考虑入场」保留（未被否定的推迟表达仍豁免）')
  // #2 名词内的「时/后」不是时间状语标记：「触发时间」的时、「后果」的后
  const j3 = checkSynthesisText('止损触发时间已经确认，立即加仓。', exitInput)
  assert(j3.by.decision === 1 && j3.kept.length === 0, '「止损触发时间已经确认，立即加仓」被剔除（TIME_MARK 排除名词组合；修复前「时间」的时被当后置标记）')
  const j4 = checkSynthesisText('触发止损时，再评估退出。', exitInput)
  assert(j4.kept.length === 1 && j4.dropped === 0, '对照：「触发止损时，再评估退出」保留（完整状语结构仍豁免）')
  // ---- 第八轮（条件分支统一 isConditionalClause：先等待补否定检查 + 等待分支复用 TIME_MARK），与 /tmp/bv-0ab5b8c-boundary-review.mts 同源 ----
  const k1 = checkSynthesisText('无需先等待回调确认，立即做多。', input)
  assert(k1.by.decision === 1 && k1.kept.length === 0, '「无需先等待回调确认，立即做多」被剔除（先等待分支补否定检查；修复前独立分支无守卫）')
  const k2 = checkSynthesisText('等待回调的后果是错过行情，立即做多。', input)
  assert(k2.by.decision === 1 && k2.kept.length === 0, '「等待回调的后果是错过行情，立即做多」被剔除（等待分支复用 TIME_MARK；修复前裸 [后再] 把「后果」当标记）')
  const k3 = checkSynthesisText('先等待回调确认，再评估入场。', input)
  assert(k3.kept.length === 1 && k3.dropped === 0, '对照：「先等待回调确认，再评估入场」保留（未被否定的先等待仍豁免）')
  // ---- 第九轮（统一否定短路 + 当/再完整语法位置），与 /tmp/bv-5ab71dd-boundary-review.mts 同源 ----
  // #1 否定拒绝统一：被否定的等待使整子句非条件，条件名词/事件词分支不得捞回
  const m1 = checkSynthesisText('无需等待入场条件满足后再参与，立即做多。', input)
  assert(m1.by.decision === 1 && m1.kept.length === 0, '「无需等待条件满足后再参与，立即做多」被剔除（否定短路；修复前 COND_NOUN 分支捞回）')
  const m2 = checkSynthesisText('无需等待突破关键支撑后再入场，立即做多。', input)
  assert(m2.by.decision === 1 && m2.kept.length === 0, '「无需等待突破后入场，立即做多」被剔除（否定短路；修复前 EVENT_MARK 分支捞回）')
  const m3 = checkSynthesisText('等待入场条件满足后再考虑参与。', input)
  assert(m3.kept.length === 1 && m3.dropped === 0, '对照：「等待条件满足后再考虑参与」保留（未被否定的等待+条件名词组合仍豁免）')
  // #2 词内字符不算标记：应当的当、再次的再
  const m4 = checkSynthesisText('多头趋势延续，应当立即做多。', input)
  assert(m4.by.decision === 1 && m4.kept.length === 0, '「应当立即做多」被剔除（当=当…时/之际结构且前非应/正；修复前「应当」命中连接词豁免）')
  const m5 = checkSynthesisText('多头趋势延续，入场条件再次不成立，立即做多。', input)
  assert(m5.by.decision === 1 && m5.kept.length === 0, '「条件再次不成立，立即做多」被剔除（再(?!次|现|者…)；修复前「再次」命中时间标记豁免）')
  const m6 = checkSynthesisText('当回调确认时，再评估入场。', input)
  assert(m6.kept.length === 1 && m6.dropped === 0, '对照：「当回调确认时，再评估入场」保留（当…时 完整结构仍豁免）')
  // ---- 第十轮（连接词词内字符：若干的若、适当…时机的跨词命中），与 /tmp/bv-f12d710-boundary-review.mts 同源 ----
  const n1 = checkSynthesisText('多头趋势延续，若干指标支持立即做多。', input)
  assert(n1.by.decision === 1 && n1.kept.length === 0, '「若干指标支持立即做多」被剔除（若(?!干)；修复前「若干」的若命中连接词豁免）')
  const n2 = checkSynthesisText('多头趋势延续，但不是适当的入场时机，立即做多。', input)
  assert(n2.by.decision === 1 && n2.kept.length === 0, '「不是适当的入场时机，立即做多」被剔除（当前排除「适」+ 时复用 WHEN_MARK；修复前「适当…时机」跨词命中当…时）')
  const n3 = checkSynthesisText('若回调确认，再评估入场。', input)
  assert(n3.kept.length === 1 && n3.dropped === 0, '对照：「若回调确认，再评估入场」保留（真假设若 不受若干排除影响）')
  const n4 = checkSynthesisText('多头趋势延续，指标支持立即做多。', input)
  assert(n4.by.decision === 1, '对照：去掉「若干」后同样剔除（剔除来自立即指令本身）')
}

console.log('\n[R-评审#4] 综合解释 token/费用记账：buildSynthesis 透出 usage')
{
  const { buildSynthesis } = await import('../server/src/research/runs/synthesis.js')
  const input = {
    question: '还能持有吗',
    symbol: 'BTCUSDT',
    horizon: '1h',
    decision: { action: 'hold' as const, side: 'long' as const, reasons: ['结构支持持仓方向'], conditions: [] },
    claims: [],
    counterClaims: [],
    scenarios: [],
    evidenceTexts: ['多头趋势延续，执行周期不断创新高'],
  }
  const r = await buildSynthesis(input, {
    llm: async () => ({ text: '结构支持继续持有。', usage: { promptTokens: 120, completionTokens: 80 } }),
    system: 's',
  })
  assert(r.didCallLlm && r.usage !== null && r.usage.promptTokens === 120 && r.usage.completionTokens === 80, 'LLM 成功调用透出 usage（调用方可累计 tokens/costUsd；修复前恒为 null）')
  const fail = await buildSynthesis(input, {
    llm: async () => { throw new Error('boom') },
    system: 's',
  })
  assert(fail.usage === null && fail.source === 'template' && fail.degraded === true, '调用失败 usage=null 回退模板（degraded）')
}

console.log('\n[R-评审#3] 事件追问语义：到期临近重估不再冒充换周期')
{
  const { buildFollowUpActions } = await import('../server/src/research/scenes.js')
  const evt = buildFollowUpActions({ scene: 'quote-review', product: 'event', runId: 'r1', evidenceRefIds: [], searchEnabled: false })
  const evtRerun = evt.find((a) => a.action === 'rerun_with')
  assert(evtRerun?.parameters?.interval === 'same', '事件「到期临近时重估」interval=same（保持原报价与周期，当前时刻重估）')
  const perp = buildFollowUpActions({ scene: 'hold-review', product: 'perp', runId: 'r2', evidenceRefIds: [], searchEnabled: false })
  const perpRerun = perp.find((a) => a.action === 'rerun_with')
  assert(perpRerun?.parameters?.interval === 'next', 'perp「换个周期再跑一次」interval=next（语义不变）')
}

console.log('\n[R-评审#8] 评测输入随仓库交付（新 clone / CI 可复现）')
{
  const { existsSync } = await import('node:fs')
  const suite = join(dirname(fileURLToPath(import.meta.url)), 'evals/conversations-baseline.json')
  assert(existsSync(suite), 'scripts/evals/conversations-baseline.json 在版本控制目录（原 server/data/ 被整体忽略）')
  const { execFileSync } = await import('node:child_process')
  const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  let ignored = false
  try {
    execFileSync('git', ['check-ignore', '-q', 'scripts/evals/conversations-baseline.json'], { cwd: rootDir, stdio: 'ignore' })
    ignored = true
  } catch {
    ignored = false
  }
  assert(!ignored, '评测输入未被 .gitignore 忽略（git check-ignore 通过）')
}

// ---- 需要 DB 的用例（冻结隔离 / 场景提示词冻结）：无 DATABASE_URL 时跳过 ----
const hasDb = process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== ''
let dbOk = false
if (hasDb) {
  const { initDb } = await import('../server/src/db.js')
  dbOk = await initDb()
}
if (!hasDb || !dbOk) {
  console.log('\n[R-评审#1/#5/#6] 冻结隔离与场景冻结：DATABASE_URL 未配置或 DB 不可用 → 跳过')
} else {
  console.log('\n[R-评审#1] 冻结配置隔离：深拷贝 + 缺失画像清空（B 不继承 A；先返冻结对象不被改写）')
  {
    const { freezeRunConfig, hashFrozenConfig } = await import('../server/src/research/runs/store.js')
    const f1 = await freezeRunConfig()
    const h1 = f1.configHash
    const f2 = await freezeRunConfig()
    assert(f1.raw !== f2.raw, '两次冻结的 raw 不共享对象（深拷贝；修复前引用同一发布配置缓存）')
    assert(hashFrozenConfig(f1) === h1, '后续冻结不改写先前返回的冻结对象（hash 不漂移；修复前 C 冻结会改写 A 的对象）')
    assert((f1.raw as { traderProfile?: unknown }).traderProfile === undefined, '无 userId 冻结不含 traderProfile（缺失画像显式清空，不残留缓存旧值）')
    assert((f1.raw as { memoryBlock?: unknown }).memoryBlock === '', '无 userId 冻结 memoryBlock 为空串（评审 #6 记忆快照字段存在）')
    assert(typeof (f1.raw as { prompts?: Record<string, { content?: string }> }).prompts?.['synthesis-writer']?.content === 'string', '冻结集含 synthesis-writer 全文（不回归）')
  }

  console.log('\n[R-评审#5] 场景提示词进入冻结配置：freezePromptSet 按 (name, scene) 解析')
  {
    const { freezePromptSet, resolvePromptTemplate, writePromptPointer, deletePromptPointer, deletePromptRow, nextPromptVersion } = await import('../server/src/research/prompts.js')
    const { promptTemplates } = await import('../server/src/models.js')
    const { getDb } = await import('../server/src/db.js')
    const d = getDb()!
    const scene = 'p1-regression-scene'
    const created: string[] = []
    try {
      // 全局缺省解析（不回归）：内容非空
      const global = await freezePromptSet(null)
      assert(Object.values(global).every((p) => p.content.length > 0), '全局冻结集每个模板内容非空（不回归）')
      // 场景未发布 → 回退全局（与全局解析同内容）
      const fallback = await freezePromptSet(null, scene)
      assert(fallback['synthesis-writer'].content === global['synthesis-writer'].content, '场景未发布回退全局模板（不误伤）')
      // 发布场景模板 + 指针 → 场景冻结命中场景版本
      const version = await nextPromptVersion('synthesis-writer', scene)
      const [tpl] = await d
        .insert(promptTemplates)
        .values({ name: 'synthesis-writer', scene, content: 'P1 场景回归专用模板：{{vertical}}', status: 'published', version, note: 'p1-regression', createdBy: 'p1-check' })
        .returning({ id: promptTemplates.id })
      created.push(tpl.id)
      await writePromptPointer('synthesis-writer', scene, tpl.id)
      const scoped = await freezePromptSet(null, scene)
      assert(scoped['synthesis-writer'].content === 'P1 场景回归专用模板：{{vertical}}', '场景已发布时冻结命中场景模板（修复前恒解析全局）')
      assert(scoped['synthesis-writer'].templateId === tpl.id, '冻结记录场景模板 id（可审计）')
      const stillGlobal = await freezePromptSet(null)
      assert(stillGlobal['synthesis-writer'].content === global['synthesis-writer'].content, '全局冻结不受场景发布影响（作用域隔离）')
      // resolvePromptTemplate 单点：显式场景解析
      const single = await resolvePromptTemplate('synthesis-writer', { scene })
      assert(single.content.includes('P1 场景回归专用模板'), 'resolvePromptTemplate 按 (name, scene) 命中场景指针')
    } finally {
      await deletePromptPointer('synthesis-writer', scene)
      if (created.length > 0) await deletePromptRow(created[0])
    }
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
