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
import { ResearchRunCreateSchema, TraderProfilePatchSchema } from 'biance-vision-brooks'
import { getDb } from '../../db.js'
import { eventQuotes, knowledgeDocuments, portfolioPositions, structureEvents } from '../../models.js'
import { kv, log } from '../../logger.js'
import type { SessionRecord } from '../../users.js'
import { findLiveSession, readSessionToken } from '../../users.js'
import { clientIpOf } from '../../authRoutes.js'
import { acquireSse, releaseSse, sseCounts } from '../../security/sseGuards.js'
import { claimIdempotency, completeIdempotency, idempotencyRejected, replyReplay } from '../../security/idempotency.js'
import { enqueueResearchRun } from './jobs.js'
import { createRun, getRunForUser, getSteps, listEvidence, listRuns, requestCancel, subscribeRun } from './store.js'
import { loadSnapshotPack } from '../../services/marketSnapshot.js'
import { handleResearchChat } from './chat.js'
import { listRunEventsAfter, getEvidenceItem } from './store.js'
import { createConversation, getConversationForUser, listConversations, listMessages, patchContext, postMessage } from './conversation.js'
import { assertChatAllowed, recordChatMessage } from '../../chatPolicy.js'
import { accessCtxFromSession, canSeeAccess } from '../../knowledge/access.js'
import { getDocument } from '../../knowledge/store.js'
import { getBlobStore } from '../../knowledge/blobstore.js'
import { contentTypeForFileName } from '../../knowledge/fileType.js'
import { projectEvidenceSource } from './evidenceSource.js'

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
  sceneCode: string | null
  snapshotId: string | null
  configVersion: string | null
  knowledgeVersion: string | null
  ruleVersion: string | null
  modelVersion: string | null
  createdAt: Date
  publishedAt: Date | null
  error: string | null
  /** 创建请求快照（追问重跑按此恢复原研究上下文；旧 run 无此列时缺省） */
  input?: Record<string, unknown> | null
}) {
  return {
    id: row.id,
    status: row.status,
    product: row.product,
    symbol: row.symbol,
    marketType: row.marketType,
    horizon: row.horizon,
    asOf: row.asOf,
    sceneCode: row.sceneCode ?? undefined,
    input: (row.input ?? undefined) as unknown as undefined | Record<string, unknown>,
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
        intent: m.intent, sceneCode: m.sceneCode ?? undefined, runId: m.runId, card: m.card,
        citations: m.citations ?? undefined, createdAt: m.createdAt.getTime(),
      })),
    }
  })

  app.post('/api/conversations/:id/messages', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    // 用户级聊天管控（禁用/每日上限），鉴权后、业务前拦截
    await assertChatAllowed(session.username)
    const { id } = req.params as { id: string }
    const conv = await getConversationForUser(id, session.username)
    if (conv === null) return reply.code(404).send({ code: 'not_found', message: '会话不存在' })
    const body = (req.body ?? {}) as { message?: unknown }
    const message = typeof body.message === 'string' ? body.message : ''
    if (message.trim() === '') return badRequest(reply, 'message 不能为空')
    const r = await postMessage(conv, message)
    // 按交互次数宽松口径：postMessage 的 10s 同内容幂等重放走到这里会重复计数，可接受
    await recordChatMessage(session.username)
    return reply.code(202).send({
      message: { id: r.message.id, role: r.message.role, content: r.message.content, intent: r.message.intent, sceneCode: r.message.sceneCode ?? undefined, promptRefs: r.message.promptRefs ?? undefined, runId: r.message.runId, card: r.message.card, createdAt: r.message.createdAt.getTime() },
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

  // ---- UI 辅助翻译：消息级「翻译」按钮（X 式内联展开）。不落会话历史、
  // 不创建研究 run；翻译消耗 LLM/离线引擎，计入用户级每日交互口径防刷。
  app.post('/api/translate', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    await assertChatAllowed(session.username)
    const body = (req.body ?? {}) as { text?: unknown; targetLang?: unknown }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '') return badRequest(reply, 'text 不能为空')
    if (text.length > 4000) return badRequest(reply, 'text 过长（≤4000 字符）')
    const targetLang = typeof body.targetLang === 'string' && /^[a-z]{2}$/.test(body.targetLang) ? body.targetLang : 'en'
    const { translateWithFallback } = await import('../translate.js')
    const out = await translateWithFallback(text, { text, targetLang, sourceLang: targetLang === 'zh' ? 'en' : 'zh' })
    await recordChatMessage(session.username)
    return { text: out.text, engine: out.engine }
  })

  // ---- P1-4 用户画像：长期研究偏好（独立 PG 表；leverageHabitMax 为描述性字段非授权上限） ----
  app.get('/api/users/me/profile', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { loadTraderProfile } = await import('../profile.js')
    return { profile: await loadTraderProfile(session.username) }
  })

  app.patch('/api/users/me/profile', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const parsed = TraderProfilePatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(reply, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'))
    const { saveTraderProfile } = await import('../profile.js')
    const profile = await saveTraderProfile(session.username, parsed.data)
    return { profile }
  })

  // ---- P1-8 服务端下发配置（红线 #10：免责文案前端只渲染不内置）。
  // 会话可选：仅公开文案与输入面板配置，不含敏感信息；未登录前端回退内置占位。
  app.get('/api/config/research-ui', async (_req, _reply) => {
    const { getDisclaimers, getChatInputConfig } = await import('../../admin/settingsStore.js')
    return { disclaimers: await getDisclaimers(), chatInput: await getChatInputConfig() }
  })


  // ---- 对话入口：自然语言 → 意图槽位 → 创建研究运行（多轮带 lastRunId 继承上下文） ----
  app.post('/api/research/chat', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    // 遗留入口同样纳入用户级聊天管控（与对话消息口径一致）
    await assertChatAllowed(session.username)
    const body = (req.body ?? {}) as { message?: unknown; lastRunId?: unknown }
    const message = typeof body.message === 'string' ? body.message : ''
    if (message.trim() === '') return badRequest(reply, 'message 不能为空')
    const lastRunId = typeof body.lastRunId === 'string' ? body.lastRunId : undefined
    try {
      const outcome = await handleResearchChat(session.username, { message, lastRunId })
      await recordChatMessage(session.username)
      return reply.code(202).send(outcome)
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'chat_failed', message: e.message })
    }
  })

  app.post('/api/research/runs', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    // 直建 run 也要过用户级管控，堵住绕过对话入口的通道
    await assertChatAllowed(session.username)
    // P1-5 幂等（键可选阶段，§5.2 兼容 rollout）：带 Idempotency-Key 的请求——
    // 同键同内容重放返回原 runId（网络重试不双建 run/双扣额度）；同键异内容 409
    const idem = await claimIdempotency(req, '/api/research/runs', 'user', session.username)
    if (idem.kind === 'replay') return await replyReplay(reply, idem.statusCode, idem.body)
    if (idem.kind === 'in_progress' || idem.kind === 'conflict') throw idempotencyRejected(idem)
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
      // 503 未实际入队，不计交互次数（仅 202 计）
      log.warn('research', '队列不可用，研究运行已建档未投递', kv({ run: row.id.slice(0, 8) }))
      return reply.code(503).send({ code: 'queue_unavailable', message: '队列不可用；运行已保存，稍后由管理员重投', runId: row.id })
    }
    await recordChatMessage(session.username)
    const responseBody = { runId: row.id, run: runDto(row) }
    if (idem.kind === 'fresh') {
      // 成功才写完成记录（失败/超时键可重试；重放返回原 202 与 runId）
      await completeIdempotency(req, '/api/research/runs', 'user', session.username, 202, responseBody)
    }
    return reply.code(202).send(responseBody)
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
   * 不可用时返回 snapshot:false 且带 reason（ok/no_snapshot/no_row/no_key/blob_missing/
   * hash_mismatch/no_interval），前端按原因展示回退文案并读实时库（带 asOf）。 */
  app.get('/api/research/runs/:id/candles', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const row = await getRunForUser(id, session.username)
    if (!row) return reply.code(404).send({ code: 'not_found', message: '研究运行不存在' })
    if (row.snapshotId === null) return { snapshot: false, candles: [], reason: 'no_snapshot' }
    const pack = await loadSnapshotPack(row.snapshotId)
    if (pack.status !== 'ok') return { snapshot: false, candles: [], reason: pack.status }
    const q = req.query as { interval?: string; priceType?: string }
    const interval = q.interval ?? '15m'
    const priceType = q.priceType ?? 'trade'
    const INTERVAL_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 }
    const step = INTERVAL_MS[interval] ?? 60_000
    const rows = pack.pack.candles.find((c) => c.interval === interval && c.priceType === priceType)?.rows ?? []
    if (rows.length === 0) return { snapshot: false, candles: [], reason: 'no_interval' }
    return {
      snapshot: true,
      reason: 'ok',
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
    // W2 流程 7：同时取版本/状态/access/blobKey 供证据源投影（fileUrl/contentHash/docUpdated）
    const titles = new Map<string, string>()
    const docRows = new Map<string, { id: string; title: string; version: number; status: string; access: string; blobKey: string | null }>()
    for (const e of evidence) {
      const docId = e.docVersionId?.split('#')[0]
      if (docId && !titles.has(docId)) {
        const rows = await getDb()!
          .select({
            id: knowledgeDocuments.id,
            title: knowledgeDocuments.title,
            version: knowledgeDocuments.version,
            status: knowledgeDocuments.status,
            access: knowledgeDocuments.access,
            blobKey: knowledgeDocuments.blobKey,
          })
          .from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.id, docId))
          .limit(1)
        titles.set(docId, rows[0]?.title ?? '')
        if (rows[0] !== undefined) docRows.set(docId, rows[0])
      }
    }
    const viewer = accessCtxFromSession(session)
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
        ...projectEvidenceSource(e, docRows.get(e.docVersionId?.split('#')[0] ?? ''), viewer),
      })),
      structures,
    }
  })

  // 用户侧原文读取（W2 流程 7）：冻结证据 → 源文档当前文件；按当前 access 判权
  // （历史快照三阶段语义第三阶段）；受限 403、已清除/无文件 404；HTML 加 CSP sandbox
  // 隔离脚本注入面（前端 iframe 再叠 sandbox 属性，双层防线）
  app.get('/api/research/evidence/:id/file', async (req, reply) => {
    const session = deps.requireSession(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const evidence = await getEvidenceItem(id)
    if (!evidence) return reply.code(404).send({ code: 'not_found', message: '证据不存在' })
    const run = await getRunForUser(evidence.runId, session.username)
    if (!run) return reply.code(404).send({ code: 'not_found', message: '研究运行不存在' })
    if (evidence.kind !== 'knowledge_chunk' || evidence.docVersionId === null) {
      return reply.code(404).send({ code: 'no_source_file', message: '该证据没有本地原文（规则卡/市场数据/网页）' })
    }
    const doc = await getDocument(evidence.docVersionId.split('#')[0])
    if (!doc || doc.status === 'archived') {
      return reply.code(404).send({ code: 'source_removed', message: '源文档已归档或清除，原文不可用' })
    }
    if (!canSeeAccess(accessCtxFromSession(session), doc.access)) {
      return reply.code(403).send({ code: 'access_restricted', message: '该资料的访问级别限制了原文查看' })
    }
    if (doc.blobKey === null || doc.blobKey === '') {
      return reply.code(404).send({ code: 'no_source_file', message: '源文档没有本地文件（URL/清单导入）' })
    }
    const buf = await getBlobStore().get(doc.blobKey)
    if (buf === null) return reply.code(404).send({ code: 'not_found', message: '原始文件已丢失（blob 缺失）' })
    const ct = contentTypeForFileName(doc.fileName)
    reply.header('content-type', ct)
    reply.header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName || doc.title)}`)
    // nosniff 防 MIME 嗅探；HTML 再加 CSP sandbox（禁脚本/表单——服务端白名单防线）
    reply.header('x-content-type-options', 'nosniff')
    if (ct.startsWith('text/html')) reply.header('content-security-policy', 'sandbox')
    return reply.send(buf)
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
    // P1-1 紧急硬限（进程内 4/用户、20/IP、100/进程）：在写任何 SSE 头之前拒绝
    const admission = acquireSse(session.username, clientIpOf(req))
    if (!admission.ok) {
      log.warn('sse', '连接超硬限被拒', kv({ run: id, 用户: session.username, 范围: admission.scope, 在线: sseCounts().total }))
      return reply.code(429).header('retry-after', String(admission.retryAfterSeconds ?? 5)).send({
        statusCode: 429, error: 'Too Many Requests',
        message: '当前订阅连接数已达上限，请关闭其他标签页后重试', code: 'rate_limited',
        retryAfterSeconds: admission.retryAfterSeconds ?? 5,
      })
    }
    const ticket = admission.ticket!
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
    // 实时进度与重连重放共用同一持久化序列，序号连续不重发。
    // P1-1：串行调度（上一轮未完成不叠加——慢查询下防 async interval 重叠）+
    // 每轮复查存活会话（登出/停用/吊销最迟 ~1.5s 停流，不只依赖初始握手）；
    // 会话/数据查询失败（保护存储不可用）不继续发送旧缓存，直接关闭
    let polling = false
    const poll = setInterval(async () => {
      if (polling) return
      polling = true
      try {
        const live = await findLiveSession(readSessionToken(req.headers.cookie), 'user')
        if (!live) {
          cleanup()
          reply.raw.end()
          return
        }
        const fresh = await getRunForUser(id, live.username)
        if (!fresh) {
          cleanup()
          reply.raw.end()
          return
        }
        for (const ev of await listRunEventsAfter(id, lastSeq)) {
          sendOnce(ev.type, { runId: id, step: ev.step ?? undefined, at: ev.at, ...(ev.payload as Record<string, unknown>) }, ev.seq)
        }
        pushState(fresh)
        if (TERMINAL.has(fresh.status)) {
          cleanup()
          reply.raw.end()
        }
      } catch {
        // 查询失败（存储不可用）：不继续发送旧缓存——关闭本流，客户端按游标重连
        cleanup()
        reply.raw.end()
      } finally {
        polling = false
      }
    }, 1500)
    let cleaned = false
    function cleanup(): void {
      if (cleaned) return
      cleaned = true
      clearInterval(poll)
      unsubscribe()
      releaseSse(ticket) // P1-1：配额释放幂等（与 acquire 成对）
    }
    req.raw.on('close', cleanup)
  })
}
