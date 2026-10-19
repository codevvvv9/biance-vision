/**
 * 研究运行执行入口（worker 任务调用；smoke 直接调用同一函数）。
 * 启动时把 run 行重建为 RunContext（版本钉住字段在 snapshot 阶段填充），
 * 交给固定流水线；取消/失败语义由 pipeline + PgRunStore 落库。
 */
import type { MarketType, ResearchHorizon } from 'biance-vision-brooks'
import { randomUUID } from 'node:crypto'
import { runPipeline } from '../orchestrator/pipeline.js'
import type { RunContext } from '../orchestrator/types.js'
import { RunCancelled } from '../orchestrator/types.js'
import { buildStages } from './stages.js'
import { PgRunStore, acquireRunLease, getRun, getSteps, runBus } from './store.js'
import { kv, log } from '../../logger.js'


/**
 * 检查点序列化（纯函数，导出供断点恢复回归测试复用生产同一路径）：
 * 由 pipeline 在阶段完成事务中与 run_steps 状态原子落库——写库失败=阶段失败
 * （恢复时重跑），不吞错误制造「completed 但无输出」的恢复窗口。
 * result 一并存入：publish 阶段 completed 之后、最终 publish 写库之前崩溃时，
 * 恢复方可从 checkpoint 恢复结果并幂等补发布（runPipeline 末尾）。
 * v2 新增字段必须同步进 CHECKPOINT_V2_KEYS 与 hydrate 恢复列表，否则断点恢复丢状态。
 */
const CHECKPOINT_V2_KEYS = [
  'v2Payload',
  'probabilityBlock',
  'eventAnalysis',
  'eventQuoteInput',
  'structureView',
  'decision',
  'lastPrice',
  'ruleLinks',
  'knowledgeEmpty',
] as const

export function runCheckpointOf(c: RunContext, _name: string): Record<string, unknown> {
  const v2 = c as unknown as Record<string, unknown>
  return {
    plan: c.plan,
    qualityIssues: c.qualityIssues,
    structures: c.structures,
    retrieval: c.retrieval,
    claims: c.claims,
    counterClaims: c.counterClaims,
    // P1-2 综合解释随检查点持久化：synthesis 完成后崩溃，恢复执行 publish 不再重调 LLM
    synthesis: c.synthesis,
    // 降级发布标志必须随检查点持久化：validate 降级收尾后崩溃，恢复执行 publish 时
    // 仍按降级门控装配（剔 LLM 反证语义已在 pipeline 内完成，counterClaims 为剔除后集合）
    degradedPublish: c.degradedPublish,
    usage: c.usage,
    result: c.result,
    v2: Object.fromEntries(CHECKPOINT_V2_KEYS.map((k) => [k, v2[k]])),
  }
}

export async function executeRun(runId: string): Promise<void> {
  const row = await getRun(runId)
  if (!row) throw new Error(`研究运行不存在：${runId}`)
  // 断点恢复（#8 修复）：worker 重启/重复投递后，queued 与 running/validating 的
  // 运行都可续跑（lease 过期即接管）；已终态（published/failed/cancelled）不重入。
  if (['published', 'failed', 'cancelled'].includes(row.status)) {
    log.info('research', '忽略已终态的运行任务', kv({ run: runId.slice(0, 8), 状态: row.status }))
    return
  }
  // 租约原子抢占：lease 过期才可接管；他人持有时本次执行直接放弃（互斥）
  const workerId = randomUUID()
  if (!(await acquireRunLease(runId, workerId))) {
    log.warn('research', '租约被其他 worker 持有，放弃本次执行', kv({ run: runId.slice(0, 8) }))
    return
  }
  const input = row.input as {
    product: 'perp' | 'event' | 'teaching'
    marketType: MarketType
    horizon: ResearchHorizon
    question?: string
    positionId?: string
    quoteId?: string
    positionOverride?: { leverage?: number }
  }
  const ctx: RunContext = {
    runId: row.id,
    userId: row.userId,
    product: input.product,
    symbol: row.symbol,
    marketType: input.marketType,
    horizon: input.horizon,
    question: input.question ?? null,
    sceneCode: row.sceneCode ?? null,
    positionId: input.positionId ?? null,
    quoteId: input.quoteId ?? null,
    asOf: row.asOf,
    frozenConfig: (row.frozenConfig as RunContext['frozenConfig']) ?? null,
    qualityIssues: [],
    snapshotPack: null,
    snapshotId: row.snapshotId,
    configVersion: row.configVersion,
    knowledgeVersion: row.knowledgeVersion,
    ruleVersion: row.ruleVersion,
    modelVersion: row.modelVersion,
    plan: null,
    structures: null,
    retrieval: null,
    productPayload: null,
    claims: [],
    counterClaims: [],
    synthesis: null,
    decision: null,
    result: null,
    validationFeedback: null,
    degradedPublish: undefined,
    usage: { llmCalls: 0, tokens: 0, searchCalls: 0, toolCalls: 0, costUsd: 0 },
    runStartedAt: Date.now(),
  }
  // 从检查点水化（snapshotPack 经输入包重载，保证与哈希一致）
  const saved = row.ctxState as Record<string, unknown> | null
  if (saved !== null) {
    ctx.plan = (saved.plan as RunContext['plan']) ?? null
    ctx.qualityIssues = (saved.qualityIssues as RunContext['qualityIssues']) ?? []
    ctx.structures = (saved.structures as RunContext['structures']) ?? null
    ctx.retrieval = (saved.retrieval as RunContext['retrieval']) ?? null
    ctx.claims = (saved.claims as RunContext['claims']) ?? []
    ctx.counterClaims = (saved.counterClaims as RunContext['counterClaims']) ?? []
    ctx.synthesis = (saved.synthesis as RunContext['synthesis']) ?? null
    ctx.degradedPublish = (saved.degradedPublish as RunContext['degradedPublish']) ?? undefined
    ctx.usage = { ...ctx.usage, ...((saved.usage as RunContext['usage']) ?? {}) }
    const v2 = saved.v2 as Record<string, unknown> | undefined
    if (v2 !== undefined) {
      const target = ctx as unknown as Record<string, unknown>
      // ruleLinks/knowledgeEmpty（理论关联链路）同样必须随检查点恢复——
      // 否则检索完成后重启，product_analysis 读取 v2.ruleLinks.find 会崩（P1 修复）
      for (const k of ['v2Payload', 'probabilityBlock', 'eventAnalysis', 'eventQuoteInput', 'structureView', 'decision', 'lastPrice', 'ruleLinks', 'knowledgeEmpty']) {
        if (v2[k] !== undefined) target[k] = v2[k]
      }
    }
  }
  if (ctx.snapshotId !== null) {
    const { loadSnapshotPack } = await import('../../services/marketSnapshot.js')
    const pack = await loadSnapshotPack(ctx.snapshotId)
    if (pack.status === 'ok') ctx.snapshotPack = { candles: pack.pack.candles, funding: pack.pack.funding, indexRef: pack.pack.indexRef }
  }
  // 续跑时把已有 result 带回（幂等发布）：优先已落库 result，其次 checkpoint 里的
  // （publish 阶段 completed 后、最终发布写库前崩溃 → 从 checkpoint 恢复并补发布）
  ctx.result =
    (row.result as RunContext['result']) ??
    ((saved as { result?: unknown } | null)?.result as RunContext['result'] | undefined) ??
    null
  const positionOverride = input.positionOverride ?? null
  try {
    const completed = new Set(
      (await getSteps(row.id)).filter((st) => st.status === 'completed').map((st) => st.step),
    )
    if (completed.size > 0) {
      log.info('research', '断点恢复', kv({ run: runId.slice(0, 8), 已完成: [...completed].join(',') }))
    }
    const stages = buildStages(positionOverride).filter((st) => !completed.has(st.name))
    await runPipeline(ctx, stages, new PgRunStore(), runBus, { leaseOwner: workerId, checkpointOf: runCheckpointOf })
    // P1-5 研究记忆：run 发布后 fire-and-forget 提取（每会话累计 6 条新消息触发；
    // 失败只记日志，不影响已完成的 run）
    if (row.conversationId !== null && row.conversationId !== '') {
      const { maybeExtractMemories } = await import('../memory.js')
      maybeExtractMemories(row.userId, row.conversationId)
    }
  } catch (err) {
    if (err instanceof RunCancelled) {
      // 取消是合法终态：落库由 store.fail 之外单独处理
      const store = new PgRunStore()
      await store.transition(runId, 'cancelled').catch(() => {})
      log.info('research', '研究运行已取消', kv({ run: runId.slice(0, 8) }))
      return
    }
    throw err
  }
}
