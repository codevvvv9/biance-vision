/**
 * /api/research/runs* 路由（docs/specs/api-storage.md）：
 * - POST /runs：创建（校验持仓/报价归属）→ 入队（队列不可用 503）→ 202 + runId
 * - GET /runs、GET /runs/:id：列表 / 详情（含步骤与证据 ID）
 * - POST /runs/:id/cancel：置取消标记（此后不再写入后续步骤）
 * - GET /runs/:id/events：SSE（先回放库内状态，再本地订阅 + 轮询跨进程补发）
 * - GET /runs/:id/result：校验后的最终结果（未发布 409）
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { ResearchRunCreateSchema } from 'biance-vision-brooks'
import { getDb } from '../../db.js'
import { eventQuotes, knowledgeDocuments, portfolioPositions, structureEvents } from '../../models.js'
import { kv, log } from '../../logger.js'
import type { SessionRecord } from '../../users.js'
import { enqueueResearchRun } from './jobs.js'
import { createRun, getRunForUser, getSteps, listEvidence, listRuns, requestCancel, subscribeRun } from './store.js'
import { loadSnapshotPack } from '../../services/marketSnapshot.js'
import { handleResearchChat } from './chat.js'
import { listRunEventsAfter } from './store.js'
import { createConversation, getConversationForUser, listConversations, listMessages, patchContext, postMessage } from './conversation.js'

interface RunRouteDeps {
  requireSession: (req: FastifyRequest) => SessionRecord
}

function ensureStorage(reply: FastifyReply): boolean {
  if (!getDb()) {
    reply.code(503).send({ code: 'storage_unavailable', message: 'PostgreSQL 不可用，无法创建研究运行' })
    return false
  }
  return true
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ code: 'bad_request', message })
}

function runDto(row: {
  id: string
  status: string
  product: string
  symbol: string
  marketType: string
  horizon: string
  asOf: number
  snapshotId: string | null
  configVersion: string | null
  knowledgeVersion: string | null
  ruleVersion: string | null
  modelVersion: string | null
  createdAt: Date
  publishedAt: Date | null
  error: string | null
}) {
  return {
    id: row.id,
    status: row.status,
    product: row.product,
    symbol: row.symbol,
    marketType: row.marketType,
    horizon: row.horizon,
    asOf: row.asOf,
    snapshotId: row.snapshotId ?? undefined,
    configVersion: row.configVersion ?? undefined,
    knowledgeVersion: row.knowledgeVersion ?? undefined,
    ruleVersion: row.ruleVersion ?? undefined,
    modelVersion: row.modelVersion ?? undefined,
    createdAt: row.createdAt.getTime(),
    publishedAt: row.publishedAt?.getTime(),
    error: row.error ?? undefined,
  }
}

function stepDto(row: {
  step: string
  status: string
  startedAt: number | null
  endedAt: number | null
  summary: string | null
}) {
  return {
    step: row.step,
    status: row.status,
    startedAt: row.startedAt ?? undefined,
    endedAt: row.endedAt ?? undefined,
    summary: row.summary ?? undefined,
  }
}

const TERMINAL = new Set(['published', 'failed', 'cancelled'])

export function registerResearchRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  // ---- 会话层（P2）：六意图路由/确认卡/上下文 PATCH（归属检查；幂等键可选透传） ----
  app.post('/api/conversations', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const body = (req.body ?? {}) as { title?: unknown; idempotencyKey?: string }
    const conv = await createConversation(session.username, typeof body.title === 'string' ? body.title.slice(0, 80) : '')
    return reply.code(201).send({ conversation: { id: conv.id, title: conv.title, context: conv.context, createdAt: conv.createdAt.getTime() } })
  })

  app.get('/api/conversations', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const rows = await listConversations(session.username)
    return { conversations: rows.map((c) => ({ id: c.id, title: c.title, context: c.context, updatedAt: c.updatedAt.getTime() })) }
  })

  app.get('/api/conversations/:id/messages', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const conv = await getConversationForUser(id, session.username)
    if (conv === null) return reply.code(404).send({ code: 'not_found', message: '会话不存在' })
    const after = (req.query as { after?: string }).after
    const rows = await listMessages(id, after)
    return {
      messages: rows.map((m) => ({
        id: m.id, conversationId: m.conversationId, role: m.role, content: m.content,
        intent: m.intent, runId: m.runId, card: m.card, createdAt: m.createdAt.getTime(),
      })),
    }
  })

  app.post('/api/conversations/:id/messages', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const conv = await getConversationForUser(id, session.username)
    if (conv === null) return reply.code(404).send({ code: 'not_found', message: '会话不存在' })
    const body = (req.body ?? {}) as { message?: unknown }
    const message = typeof body.message === 'string' ? body.message : ''
    if (message.trim() === '') return badRequest(reply, 'message 不能为空')
    const r = await postMessage(conv, message)
    return reply.code(202).send({
      message: { id: r.message.id, role: r.message.role, content: r.message.content, intent: r.message.intent, runId: r.message.runId, card: r.message.card, createdAt: r.message.createdAt.getTime() },
      runId: r.runId,
      needCompletion: r.needCompletion,
    })
  })

  app.patch('/api/conversations/:id/context', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const conv = await getConversationForUser(id, session.username)
    if (conv === null) return reply.code(404).send({ code: 'not_found', message: '会话不存在' })
    const patch = (req.body ?? {}) as Record<string, unknown>
    const r = await patchContext(conv, patch)
    if (patch.confirm === true && r.confirmedPositionId === null && patch.positionDraft !== undefined) {
      return badRequest(reply, '持仓草稿字段不完整（需 symbol/side/qty/entryPrice/riskBudget）')
    }
    return { context: r.context, confirmedPositionId: r.confirmedPositionId }
  })


  // ---- 对话入口：自然语言 → 意图槽位 → 创建研究运行（多轮带 lastRunId 继承上下文） ----
  app.post('/api/research/chat', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const body = (req.body ?? {}) as { message?: unknown; lastRunId?: unknown }
    const message = typeof body.message === 'string' ? body.message : ''
    if (message.trim() === '') return badRequest(reply, 'message 不能为空')
    const lastRunId = typeof body.lastRunId === 'string' ? body.lastRunId : undefined
    try {
      const outcome = await handleResearchChat(session.username, { message, lastRunId })
      return reply.code(202).send(outcome)
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'chat_failed', message: e.message })
    }
  })

  app.post('/api/research/runs', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const parsed = ResearchRunCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(reply, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'))
    const input = parsed.data
    const db = getDb()!
    // 持仓/报价归属校验：必须是当前用户的记录
    if (input.positionId) {
      const rows = await db
        .select({ id: portfolioPositions.id })
        .from(portfolioPositions)
        .where(and(eq(portfolioPositions.id, input.positionId), eq(portfolioPositions.userId, session.username)))
        .limit(1)
      if (rows.length === 0) return badRequest(reply, '持仓不存在或不属于当前用户')
    }
    if (input.quoteId) {
      const rows = await db
        .select({ id: eventQuotes.id })
        .from(eventQuotes)
        .where(and(eq(eventQuotes.id, input.quoteId), eq(eventQuotes.userId, session.username)))
        .limit(1)
      if (rows.length === 0) return badRequest(reply, '报价不存在或不属于当前用户')
    }
    const row = await createRun({ userId: session.username, create: input })
    const queued = await enqueueResearchRun(row.id)
    if (!queued) {
      // 队列不可用：显式 503，不静默丢失（行保留 queued，恢复后可重投）
      log.warn('research', '队列不可用，研究运行已建档未投递', kv({ run: row.id.slice(0, 8) }))
      return reply.code(503).send({ code: 'queue_unavailable', message: '队列不可用；运行已保存，稍后由管理员重投', runId: row.id })
    }
    return reply.code(202).send({ runId: row.id, run: runDto(row) })
  })

  app.get('/api/research/runs', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const rows = await listRuns(session.username)
    return { runs: rows.map(runDto) }
  })

  app.get('/api/research/runs/:id', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const row = await getRunForUser(id, session.username)
    if (!row) return reply.code(404).send({ code: 'not_found', message: '研究运行不存在' })
    const [steps, evidence] = await Promise.all([getSteps(id), listEvidence(id)])
    return {
      run: runDto(row),
      steps: steps.map(stepDto),
      evidenceIds: evidence.map((e) => e.id),
    }
  })

  app.get('/api/research/runs/:id/result', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const row = await getRunForUser(id, session.username)
    if (!row) return reply.code(404).send({ code: 'not_found', message: '研究运行不存在' })
    if (row.status !== 'published' || row.result === null) {
      return reply.code(409).send({ code: 'not_published', message: `结果未发布（当前状态 ${row.status}）；未校验的结论不对外提供` })
    }
    return { runId: row.id, result: row.result, product: row.product }
  })

  /** 快照输入包 K 线（评审 F3：结果图表读冻结输入包而非实时库，历史复盘图表可复现）。
   * 旧 run 无快照包时返回 snapshot:false，前端回退实时库（带 asOf）。 */
  app.get('/api/research/runs/:id/candles', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const row = await getRunForUser(id, session.username)
    if (!row) return reply.code(404).send({ code: 'not_found', message: '研究运行不存在' })
    if (row.snapshotId === null) return { snapshot: false, candles: [] }
    const pack = await loadSnapshotPack(row.snapshotId)
    if (pack === null) return { snapshot: false, candles: [] }
    const q = req.query as { interval?: string; priceType?: string }
    const interval = q.interval ?? '15m'
    const priceType = q.priceType ?? 'trade'
    const INTERVAL_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }
    const step = INTERVAL_MS[interval] ?? 60_000
    const rows = pack.candles.find((c) => c.interval === interval && c.priceType === priceType)?.rows ?? []
    return {
      snapshot: true,
      candles: rows.map((r) => ({
        openTime: r.t,
        open: r.o,
        high: r.h,
        low: r.l,
        close: r.c,
        closeTime: r.t + step - 1,
        volume: r.v,
        isClosed: true,
      })),
    }
  })

  /** 冻结证据明细（用户读自己的 run；资料更新不影响此处快照）；附带快照结构事件供图表联动定位 */  app.get('/api/research/runs/:id/evidence', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const row = await getRunForUser(id, session.username)
    if (!row) return reply.code(404).send({ code: 'not_found', message: '研究运行不存在' })
    const evidence = await listEvidence(id)
    const structures = row.snapshotId
      ? await getDb()!
          .select({
            id: structureEvents.id,
            kind: structureEvents.kind,
            direction: structureEvents.direction,
            atTime: structureEvents.atTime,
            knownAtTime: structureEvents.knownAtTime,
            provisional: structureEvents.provisional,
            ruleId: structureEvents.ruleId,
            note: structureEvents.note,
          })
          .from(structureEvents)
          .where(eq(structureEvents.snapshotId, row.snapshotId))
          .orderBy(structureEvents.atTime)
      : []
    // docTitle 解析（论断引用定位）：knowledge_chunk 的 docVersionId 形如 `${docId}#${v}`
    const titles = new Map<string, string>()
    for (const e of evidence) {
      const docId = e.docVersionId?.split('#')[0]
      if (docId && !titles.has(docId)) {
        const rows = await getDb()!
          .select({ title: knowledgeDocuments.title })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.id, docId))
          .limit(1)
        titles.set(docId, rows[0]?.title ?? '')
      }
    }
    return {
      evidence: evidence.map((e) => ({
        id: e.id,
        stance: e.stance,
        kind: e.kind,
        refId: e.refId,
        docTitle: e.kind === 'rule_card' ? '规则卡' : titles.get(e.docVersionId?.split('#')[0] ?? '') ?? '',
        pageNo: e.pageNo,
        figureId: e.figureId,
        sourceTier: e.sourceTier,
        text: e.text,
      })),
      structures,
    }
  })

  app.post('/api/research/runs/:id/cancel', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const row = await getRunForUser(id, session.username)
    if (!row) return reply.code(404).send({ code: 'not_found', message: '研究运行不存在' })
    if (TERMINAL.has(row.status)) return badRequest(reply, `运行已结束（${row.status}），无需取消`)
    const ok = await requestCancel(id, session.username)
    return { ok, runId: id }
  })

  // SSE 进度：terminal 后即关闭；跨进程（worker 执行）经 1.5s 轮询补发状态变化
  app.get('/api/research/runs/:id/events', async (req, reply) => {
    const session = deps.requireSession(req)
    const { id } = req.params as { id: string }
    const row = await getRunForUser(id, session.username)
    if (!row) return reply.code(404).send({ code: 'not_found', message: '研究运行不存在' })
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    const send = (type: string, data: unknown, seq?: number): void => {
      if (seq !== undefined) reply.raw.write(`id: ${seq}\n`)
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    let lastStatus = ''
    // 双通道去重游标：订阅推送（同进程）与 DB 轮询（跨进程 worker）共用同一 seq 序列，
    // 已发过的 seq 不再重发；无 seq 的降级事件直发
    let lastSeq = 0
    const sendOnce = (type: string, data: unknown, seq?: number): void => {
      if (seq !== undefined) {
        if (seq <= lastSeq) return
        lastSeq = seq
      }
      send(type, data, seq)
    }
    const pushState = (r: NonNullable<typeof row>): void => {
      if (r.status === lastStatus) return
      lastStatus = r.status
      if (r.status === 'published') {
        send('run_published', { runId: r.id, at: r.publishedAt?.getTime() ?? Date.now(), result: r.result })
      } else if (r.status === 'failed') {
        send('run_failed', { runId: r.id, at: Date.now(), error: r.error ?? '未知错误' })
      } else if (r.status === 'cancelled') {
        send('run_cancelled', { runId: r.id, at: Date.now() })
      }
    }
    // 游标重放（断线重连不丢事件）：优先显式 ?after=seq，其次浏览器 EventSource
    // 自动重连携带的 Last-Event-ID 头（本服务端每条事件都写了 id: 行，头由浏览器自动带上）；
    // 无游标时回放步骤级状态（首次订阅）
    const afterParam = (req.query as { after?: string }).after ?? (req.headers['last-event-id'] as string | undefined)
    if (afterParam !== undefined && afterParam !== '') {
      lastSeq = Number(afterParam) || 0
      for (const ev of await listRunEventsAfter(id, lastSeq)) {
        sendOnce(ev.type, { runId: id, step: ev.step ?? undefined, at: ev.at, ...(ev.payload as Record<string, unknown>) }, ev.seq)
      }
    } else {
      for (const s of await getSteps(id)) {
        if (s.status === 'completed') send('step_completed', { runId: id, step: s.step, at: s.endedAt ?? Date.now() })
        else if (s.status === 'failed') send('run_failed', { runId: id, step: s.step, at: s.endedAt ?? Date.now(), error: s.error ?? '' })
      }
    }
    pushState(row)
    if (TERMINAL.has(row.status)) {
      reply.raw.end()
      return
    }
    // 本进程事件（smoke/同进程执行）：事件已先落库拿 seq 再推送（runBus），带连续序号
    const unsubscribe = subscribeRun(id, (event) => {
      sendOnce(event.type, event, (event as unknown as { seq?: number }).seq)
      if (event.type === 'run_published' || event.type === 'run_failed' || event.type === 'run_cancelled') {
        cleanup()
        reply.raw.end()
      }
    })
    // 跨进程（独立 worker）：轮询除终态外持续读取新增事件（run_events），
    // 实时进度与重连重放共用同一持久化序列，序号连续不重发
    const poll = setInterval(async () => {
      try {
        const fresh = await getRunForUser(id, session.username)
        if (!fresh) return
        for (const ev of await listRunEventsAfter(id, lastSeq)) {
          sendOnce(ev.type, { runId: id, step: ev.step ?? undefined, at: ev.at, ...(ev.payload as Record<string, unknown>) }, ev.seq)
        }
        pushState(fresh)
        if (TERMINAL.has(fresh.status)) {
          cleanup()
          reply.raw.end()
        }
      } catch {
        /* 轮询失败下一轮再试 */
      }
    }, 1500)
    let cleaned = false
    function cleanup(): void {
      if (cleaned) return
      cleaned = true
      clearInterval(poll)
      unsubscribe()
    }
    req.raw.on('close', cleanup)
  })
}
