/**
 * 研究运行持久化（RunStore 的 PG 实现）与进程内进度总线。
 * 对应 docs/specs/agent-orchestration.md：每步持久化可恢复、取消检查、
 * SSE 进度事件；结论只有校验通过后才写入 result（此后不可变）。
 */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { and, desc, eq, gt, notInArray, sql } from 'drizzle-orm'
import type { RunProgressEvent, ResearchRunCreate } from 'biance-vision-brooks'
import { evidenceItems, researchRuns, runEvents, runSteps } from '../../models.js'
import type { EvidenceItemRow, ResearchRunRow, RunStepRow } from '../../models.js'
import { getDb } from '../../db.js'
import { getCapabilities } from '../../admin/capabilities.js'
import { latestKnowledgeVersion } from '../../knowledge/store.js'
import { kv, log } from '../../logger.js'
import { DEFAULT_PERP_FEES } from '../../services/perpetualAnalyzer.js'
import { FUNDING_GRACE_MS, FUNDING_INTERVAL_MS } from '../perp/calc.js'
import type { EventBus, RunStatus, StageName } from '../orchestrator/types.js'
import { LeaseLostError } from '../orchestrator/types.js'

// ---- 进度总线（进程内；worker 与 app 同库不同进程时 SSE 以 DB 事件序列为准 + 轮询补发） ----

const emitter = new EventEmitter()
emitter.setMaxListeners(200)

/** SSE 事件持久化：run_events 落库（seq 递增）；返回 seq（失败 → null，调用方降级直推） */
async function persistRunEvent(runId: string, event: RunProgressEvent, retried = false): Promise<number | null> {
  try {
    const d = getDb()
    if (!d) return null
    const next = (await d.execute(sql`select coalesce(max(seq),0)+1 as s from run_events where run_id = ${runId}`)) as unknown as
      | { s: number }[]
      | { rows: { s: number }[] }
    const seq = (Array.isArray(next) ? next[0]?.s : next.rows[0]?.s) ?? 1
    await d.insert(runEvents).values({
      runId,
      seq,
      type: event.type,
      step: event.step ?? null,
      payload: (event.payload ?? null) as Record<string, unknown> | null,
      at: event.at,
    })
    return seq
  } catch {
    // 序号竞争（跨进程并发）触发 (run_id,seq) 主键冲突：重取 max 重试一次；再失败才降级
    if (!retried) return persistRunEvent(runId, event, true)
    return null
  }
}

// 同 run 事件串行化（评审 F10）：SELECT max(seq)+1 再 INSERT 非原子，fire-and-forget 并发
// 会抢同一序号（冲突被吞 → 事件只留在进程内推送，DB 重放丢失，开始/完成可能乱序）；
// 进程内按 run 串行后消除竞争，主键 (run_id,seq) 作为最后防线。终态后清理链防泄漏。
const eventChains = new Map<string, Promise<unknown>>()

function enqueuePersist(runId: string, event: RunProgressEvent): Promise<number | null> {
  const prev = eventChains.get(runId) ?? Promise.resolve()
  const task = prev
    .then(() => persistRunEvent(runId, event))
    .finally(() => {
      if (event.type === 'run_published' || event.type === 'run_failed' || event.type === 'run_cancelled') {
        eventChains.delete(runId)
      }
    })
  eventChains.set(runId, task.catch(() => null))
  return task
}

export const runBus: EventBus = {
  emit(runId: string, event: RunProgressEvent): void {
    // 先落库拿到 seq 再推送：实时事件与重连重放共用同一持久化序列，
    // 订阅者拿到的每条事件都有连续序号（落库失败才降级为无 seq 直推）
    void enqueuePersist(runId, event).then((seq) => {
      emitter.emit(`run:${runId}`, seq === null ? event : ({ ...event, seq } as RunProgressEvent))
    })
  },
}

/** 游标重放：读取 after 之后的事件（SSE 重连） */
export async function listRunEventsAfter(runId: string, after: number): Promise<{ seq: number; type: string; step: string | null; payload: unknown; at: number }[]> {
  const d = db()
  const rows = await d
    .select()
    .from(runEvents)
    .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, after)))
    .orderBy(runEvents.seq)
  return rows.map((r) => ({ seq: r.seq, type: r.type, step: r.step, payload: r.payload, at: r.at }))
}

export function subscribeRun(runId: string, listener: (event: RunProgressEvent) => void): () => void {
  const key = `run:${runId}`
  emitter.on(key, listener)
  return () => emitter.off(key, listener)
}

// ---- RunStore（PG） ----

export class StoreUnavailableError extends Error {
  constructor() {
    super('PostgreSQL 不可用，研究运行不可读写')
    this.name = 'StoreUnavailableError'
  }
}

/** 研究运行终态集合：终态后不再取消（acquireRunLease / requestCancel / chat-cutoff 共用口径） */
export const RUN_TERMINAL = new Set(['published', 'failed', 'cancelled'])

function db() {
  const d = getDb()
  if (!d) throw new StoreUnavailableError()
  return d
}

/** 默认运行预算（improvement-plan §4.3：可版本化工程默认值；费用表缺失时不假装执行费用上限）。
 * maxRuntimeMs=180s（浏览器 e2e 实测 2026-10-19：快照+结构+检索（嵌入网络延迟波动）+
 * LLM 反证（~16s）常态 40-60s，偶发 >60s 被 60s 默认值误杀成 failed；租约每步续期 +120s，
 * 180s 上限下无接管风险，单阶段 LLM 调用另有 90s 硬顶） */
export const DEFAULT_RUN_BUDGETS = { maxLlmCalls: 6, maxToolCalls: 20, maxSearchCalls: 2, maxRuntimeMs: 180_000 }

/** 运行租约时长（worker 崩溃后其他 worker 的接管等待上限） */
export const RUN_LEASE_MS = 120_000

/**
 * 原子抢占运行租约：lease 过期（或从未持有）且运行未终态时，worker 才能持有；
 * 同一时刻只有一个 worker 能成功。返回 false 表示他人持有或已终态（放弃执行）。
 */
export async function acquireRunLease(runId: string, owner: string): Promise<boolean> {
  const rows = await db()
    .update(researchRuns)
    .set({ leaseUntil: new Date(Date.now() + RUN_LEASE_MS), leaseOwner: owner, updatedAt: new Date() })
    .where(
      and(
        eq(researchRuns.id, runId),
        sql`${researchRuns.status} not in ('published','failed','cancelled')`,
        sql`(${researchRuns.leaseUntil} is null or ${researchRuns.leaseUntil} < now())`,
      ),
    )
    .returning({ id: researchRuns.id })
  return rows.length > 0
}

/** 冻结配置哈希（纯函数）：创建时与校验时用同一函数计算，保证可比性。
 * 入参不含 configHash 本身（run 行持久化值与内存值都可直接传入）。 */
/** 规范化 JSON：键按字母序递归排序。pg jsonb 落库即按字母序重排键，
 * 创建时（插入序）与校验时（读回序）字符串不同会让同一配置哈希不一致——
 * 哈希必须建立在键序无关的规范形态上 */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(',')}}`
  }
  return JSON.stringify(v)
}

export function hashFrozenConfig(
  frozen: Omit<NonNullable<import('../orchestrator/types.js').RunContext['frozenConfig']>, 'configHash'>,
): string {
  const { budgets, knowledgeVersionId, raw, fees, stepSize, minNotional, fundingWindow } = frozen
  return createHash('sha256')
    .update(canonicalJson({ budgets, knowledgeVersionId, raw, fees, stepSize, minNotional, fundingWindow }))
    .digest('hex')
}

/** 冻结运行配置：发布版本全文 + 预算 + 知识版本 + 永续费率/步进/名义下限/funding 时效 + 内容哈希（运行中不受新发布影响）。
 * userId（可选）：P1-4 画像快照——创建 run 时把用户长期偏好冻结进 raw.traderProfile
 * （画像此后变更不影响本 run；f6 评测无 userId 调用保持确定性）。 */
export async function freezeRunConfig(userId?: string): Promise<NonNullable<import('../orchestrator/types.js').RunContext['frozenConfig']>> {
  const { currentAgentConfig } = await import('../../admin/agentVersions.js')
  const agent = await currentAgentConfig()
  // 配置预算完整冻结（maxToolCalls/maxRuntimeMs/maxCostUsd 都落实到 pipeline 执行控制；
  // 未配置的字段保留工程默认，maxCostUsd 仅在配置了单价来源时才真正可执行）
  const conf = (agent?.config.budgets ?? {}) as { maxToolCalls?: number; maxRuntimeMs?: number; maxCostUsd?: number }
  const budgets = {
    ...DEFAULT_RUN_BUDGETS,
    ...(conf.maxToolCalls !== undefined ? { maxToolCalls: conf.maxToolCalls } : {}),
    ...(conf.maxRuntimeMs !== undefined ? { maxRuntimeMs: conf.maxRuntimeMs } : {}),
    ...(conf.maxCostUsd !== undefined ? { maxCostUsd: conf.maxCostUsd } : {}),
  }
  let knowledgeVersionId: string | null = null
  const bound = agent?.config.ruleParams?.knowledgeVersion
  if (typeof bound === 'string' && bound !== '') {
    knowledgeVersionId = bound
  } else {
    const kv = await latestKnowledgeVersion()
    knowledgeVersionId = kv?.id ?? null
  }
  // 永续计算参数随 run 冻结（八轮修复）：ruleParams.perp 可覆盖，默认取 calc.ts 的
  // DEFAULT_FEES 与工程默认（单一来源，不再有散落的硬编码默认值）；参与 configHash
  const perp = ((agent?.config.ruleParams?.perp ?? {}) as Record<string, unknown>)
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  const fees = {
    takerRate: num(perp.takerRate, DEFAULT_PERP_FEES.takerRate),
    makerRate: num(perp.makerRate, DEFAULT_PERP_FEES.makerRate),
    slippageRate: num(perp.slippageRate, DEFAULT_PERP_FEES.slippageRate),
  }
  const stepSize = num(perp.stepSize, 0) > 0 ? num(perp.stepSize, 0.001) : 0.001
  const minNotional = num(perp.minNotional, 100)
  const fundingWindow = {
    intervalMs: num(perp.fundingIntervalMs, FUNDING_INTERVAL_MS) || FUNDING_INTERVAL_MS,
    graceMs: num(perp.fundingGraceMs, FUNDING_GRACE_MS),
  }
  // 评审 R4：无发布 Agent 版本时，raw 不能只冻结空对象——capabilities 冻结
  // 「解析后的有效配置」（app_settings → 环境变量，与 getCapabilities() 解析链一致），
  // 保证旧 run 与恢复执行使用创建时的有效配置
  const raw = (agent?.config ?? {}) as Record<string, unknown>
  if (agent === null || raw.capabilities === undefined) {
    raw.capabilities = getCapabilities()
  }
  // P0-6 提示词终解析：五个模板全文冻结进 raw.prompts（{name,templateId,version,content,source}）；
  // 执行阶段只读冻结内容，不再解析发布指针（红线 #2）。注册表清空时回退工程默认+日志。
  const { freezePromptSet } = await import('../prompts.js')
  raw.prompts = await freezePromptSet(raw as { roles?: { name?: string; promptRef?: string }[] })
  // P1-2 综合解释预算：ruleParams.synthesis 未显式关闭且 chat 能力可用时 +1
  // （DEFAULT 6→7；BudgetSchema 无 maxLlmCalls 键，工程默认即权威，不做 per-agent 覆盖）
  const synthesisOff = (raw.ruleParams as { synthesis?: { enabled?: boolean } } | undefined)?.synthesis?.enabled === false
  const chatOn =
    (raw.capabilities as { chat?: { enabled?: boolean; baseUrl?: string; model?: string } } | undefined)?.chat?.enabled === true
  if (!synthesisOff && chatOn) {
    budgets.maxLlmCalls = DEFAULT_RUN_BUDGETS.maxLlmCalls + 1
  }
  // P1-4 画像快照：用户长期偏好冻结进 raw.traderProfile（变更不影响历史 run）
  if (userId !== undefined && userId !== '') {
    try {
      const { loadTraderProfile } = await import('../profile.js')
      const profile = await loadTraderProfile(userId)
      if (profile !== null) raw.traderProfile = profile as unknown as Record<string, unknown>
    } catch {
      /* 画像读取失败不阻塞 run 创建（快照缺省为空） */
    }
  }
  const frozen = { label: agent?.label ?? 'default-v1', budgets, knowledgeVersionId, raw, fees, stepSize, minNotional, fundingWindow }
  return { ...frozen, configHash: hashFrozenConfig(frozen) }
}

export async function createRun(input: {
  userId: string
  create: ResearchRunCreate
  conversationId?: string
}): Promise<ResearchRunRow> {
  const asOf = input.create.asOf ?? Date.now()
  const frozen = await freezeRunConfig(input.userId)
  // P1-1 场景：显式传入优先；缺省按产品+引用推导（历史复盘 asOf 早于创建时刻 → replay-analysis）
  const sceneCode =
    input.create.sceneCode ??
    (await import('../scenes.js')).defaultSceneForProduct(input.create.product, {
      positionId: input.create.positionId ?? null,
      quoteId: input.create.quoteId ?? null,
      asOfIsHistorical: input.create.asOf !== undefined && input.create.asOf < Date.now() - 60_000,
    })
  const rows = await db()
    .insert(researchRuns)
    .values({
      id: randomUUID(),
      userId: input.userId,
      status: 'queued',
      product: input.create.product,
      sceneCode,
      symbol: input.create.symbol,
      marketType: input.create.marketType,
      horizon: input.create.horizon,
      question: input.create.question ?? null,
      positionId: input.create.positionId ?? null,
      quoteId: input.create.quoteId ?? null,
      asOf,
      input: input.create as unknown as Record<string, unknown>,
      frozenConfig: frozen as unknown as Record<string, unknown>,
      conversationId: input.conversationId ?? null,
    })
    .returning()
  return rows[0]
}

export async function getRun(id: string): Promise<ResearchRunRow | null> {
  const rows = await db().select().from(researchRuns).where(eq(researchRuns.id, id)).limit(1)
  return rows[0] ?? null
}

export async function getRunForUser(id: string, userId: string): Promise<ResearchRunRow | null> {
  const rows = await db()
    .select()
    .from(researchRuns)
    .where(and(eq(researchRuns.id, id), eq(researchRuns.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

export async function listRuns(userId: string, limit = 50): Promise<ResearchRunRow[]> {
  return db()
    .select()
    .from(researchRuns)
    .where(eq(researchRuns.userId, userId))
    .orderBy(desc(researchRuns.createdAt))
    .limit(limit)
}

/** 全部未终态运行（不按 listRuns 的 50 条截断）：chat-cutoff 全量取消等管控场景用 */
export async function listActiveRuns(userId: string): Promise<ResearchRunRow[]> {
  return db()
    .select()
    .from(researchRuns)
    .where(and(eq(researchRuns.userId, userId), notInArray(researchRuns.status, [...RUN_TERMINAL])))
    .orderBy(desc(researchRuns.createdAt))
}

export async function getSteps(runId: string): Promise<RunStepRow[]> {
  return db().select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(runSteps.startedAt)
}

export async function listEvidence(runId: string): Promise<EvidenceItemRow[]> {
  return db().select().from(evidenceItems).where(eq(evidenceItems.runId, runId))
}

/** 证据冻结：把检索命中的片段写入 evidence_items（发布回答前调用，此后资料更新不影响） */
export async function freezeEvidence(
  runId: string,
  items: {
    stance: 'support' | 'counter'
    /** web_page：search 能力经「搜索 → 原页抓取核验」后的网页证据（refId 存最终 URL） */
    kind: 'knowledge_chunk' | 'market_bar' | 'structure_event' | 'rule_card' | 'web_page'
    refId: string
    docVersionId?: string | null
    pageNo?: number | null
    figureId?: string | null
    contentHash?: string | null
    sourceTier?: string | null
    text: string
  }[],
): Promise<string[]> {
  if (items.length === 0) return []
  const rows = await db()
    .insert(evidenceItems)
    .values(items.map((i) => ({ runId, ...i })))
    .returning()
  return rows.map((r) => r.id)
}

/** 取消：置 cancelRequested；流水线在下一step边界检查并放弃后续写入。
 * where 排除终态（消除「检查后取消」竞态：已终态 run 返回 false，不置标记也不发取消事件） */
export async function requestCancel(id: string, userId: string): Promise<boolean> {
  const rows = await db()
    .update(researchRuns)
    .set({ cancelRequested: true, updatedAt: new Date() })
    .where(and(eq(researchRuns.id, id), eq(researchRuns.userId, userId), notInArray(researchRuns.status, [...RUN_TERMINAL])))
    .returning()
  if (rows.length > 0) {
    runBus.emit(id, { type: 'run_cancelled', runId: id, at: Date.now() })
  }
  return rows.length > 0
}

/** 版本钉住：snapshot 阶段把共享版本写回 run 行（此后不受后续发布影响） */
export async function pinRunVersions(
  runId: string,
  versions: {
    snapshotId?: string | null
    knowledgeVersion?: string | null
    ruleVersion?: string | null
    configVersion?: string | null
    modelVersion?: string | null
  },
): Promise<void> {
  await db()
    .update(researchRuns)
    .set({ ...versions, updatedAt: new Date() })
    .where(eq(researchRuns.id, runId))
}

export class PgRunStore {
  /** owner 传入时仅租约持有者可转换；取消路径（runner 的 RunCancelled 分支）不传 = 无条件 */
  async transition(runId: string, status: RunStatus, leaseOwner?: string): Promise<void> {
    if (leaseOwner === undefined) {
      await db()
        .update(researchRuns)
        .set({ status, updatedAt: new Date() })
        .where(eq(researchRuns.id, runId))
      return
    }
    const rows = await db()
      .update(researchRuns)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(researchRuns.id, runId), eq(researchRuns.leaseOwner, leaseOwner)))
      .returning({ id: researchRuns.id })
    if (rows.length === 0) throw new LeaseLostError(runId, leaseOwner)
  }

  async stepStarted(runId: string, step: StageName, at: number, leaseOwner?: string): Promise<void> {
    // attempt 递增：同一 step 的修复轮重跑各占一行；带 owner 时先验证租约（丢失不插入）
    await db().transaction(async (tx) => {
      if (leaseOwner !== undefined) {
        const held = await tx
          .select({ id: researchRuns.id })
          .from(researchRuns)
          .where(and(eq(researchRuns.id, runId), eq(researchRuns.leaseOwner, leaseOwner)))
          .limit(1)
        if (held.length === 0) throw new LeaseLostError(runId, leaseOwner)
      }
      await tx.execute(
        sql`insert into run_steps (id, run_id, step, status, started_at, attempt)
          values (${randomUUID()}, ${runId}, ${step}, 'running', ${at},
            (select coalesce(max(attempt), -1) + 1 from run_steps where run_id = ${runId} and step = ${step}))`,
      )
    })
  }

  async stepCompleted(runId: string, step: StageName, at: number, summary?: string, costMs?: number): Promise<void> {
    const rows = await db().select().from(runSteps).where(and(eq(runSteps.runId, runId), eq(runSteps.step, step)))
    const latest = rows.sort((a, b) => b.attempt - a.attempt)[0]
    if (!latest) return
    await db()
      .update(runSteps)
      .set({ status: 'completed', endedAt: at, summary: summary ?? null, costMs: costMs ?? null })
      .where(eq(runSteps.id, latest.id))
  }

  /**
   * 阶段完成与检查点原子提交（RunStore.completeStage 契约）：
   * 同一事务内 (a) run_steps 最新 attempt 置 completed；(b) research_runs 写 ctxState
   * 并以 leaseOwner 条件续租。任一失败整体回滚——阶段不算完成，恢复时重跑（宁可重算不可丢状态）。
   * 丢租约（他人已接管）抛 LeaseLostError 终止本次执行。
   */
  async completeStage(
    runId: string,
    step: StageName,
    at: number,
    costMs: number,
    ctxState: Record<string, unknown> | null,
    leaseOwner: string,
  ): Promise<void> {
    await db().transaction(async (tx) => {
      const rows = await tx.select().from(runSteps).where(and(eq(runSteps.runId, runId), eq(runSteps.step, step)))
      const latest = rows.sort((a, b) => b.attempt - a.attempt)[0]
      if (latest !== undefined) {
        await tx.update(runSteps).set({ status: 'completed', endedAt: at, costMs }).where(eq(runSteps.id, latest.id))
      }
      const renewed = await tx
        .update(researchRuns)
        .set({ ctxState: ctxState ?? undefined, leaseUntil: new Date(Date.now() + RUN_LEASE_MS), updatedAt: new Date() })
        .where(and(eq(researchRuns.id, runId), eq(researchRuns.leaseOwner, leaseOwner)))
        .returning({ id: researchRuns.id })
      if (renewed.length === 0) {
        throw new LeaseLostError(runId, leaseOwner)
      }
    })
  }

  /** 带 owner 时在事务内先验证租约再更新（丢失不写——防止旧 worker 覆盖接管者的步骤状态） */
  async stepFailed(runId: string, step: StageName, at: number, error: string, leaseOwner?: string): Promise<void> {
    await db().transaction(async (tx) => {
      if (leaseOwner !== undefined) {
        const held = await tx
          .select({ id: researchRuns.id })
          .from(researchRuns)
          .where(and(eq(researchRuns.id, runId), eq(researchRuns.leaseOwner, leaseOwner)))
          .limit(1)
        if (held.length === 0) throw new LeaseLostError(runId, leaseOwner)
      }
      const rows = await tx.select().from(runSteps).where(and(eq(runSteps.runId, runId), eq(runSteps.step, step)))
      const latest = rows.sort((a, b) => b.attempt - a.attempt)[0]
      if (!latest) return
      await tx.update(runSteps).set({ status: 'failed', endedAt: at, error }).where(eq(runSteps.id, latest.id))
    })
  }

  async publish(runId: string, result: unknown, leaseOwner?: string): Promise<void> {
    const rows = await db()
      .update(researchRuns)
      .set({ status: 'published', result: result as Record<string, unknown>, publishedAt: new Date(), updatedAt: new Date() })
      .where(leaseOwner !== undefined ? and(eq(researchRuns.id, runId), eq(researchRuns.leaseOwner, leaseOwner)) : eq(researchRuns.id, runId))
      .returning({ id: researchRuns.id })
    if (rows.length === 0 && leaseOwner !== undefined) throw new LeaseLostError(runId, leaseOwner)
    log.ok('research', '研究运行发布', kv({ run: runId.slice(0, 8) }))
  }

  /** 带 owner 时仅租约持有者可置失败（丢租约抛错，不污染接管者的运行） */
  async fail(runId: string, error: string, leaseOwner?: string): Promise<void> {
    const rows = await db()
      .update(researchRuns)
      .set({ status: 'failed', error: error.slice(0, 1000), updatedAt: new Date() })
      .where(leaseOwner !== undefined ? and(eq(researchRuns.id, runId), eq(researchRuns.leaseOwner, leaseOwner)) : eq(researchRuns.id, runId))
      .returning({ id: researchRuns.id })
    if (rows.length === 0 && leaseOwner !== undefined) throw new LeaseLostError(runId, leaseOwner)
  }

  async isCancelled(runId: string): Promise<boolean> {
    const rows = await db()
      .select({ cancelRequested: researchRuns.cancelRequested })
      .from(researchRuns)
      .where(eq(researchRuns.id, runId))
      .limit(1)
    return rows[0]?.cancelRequested === true
  }
}
