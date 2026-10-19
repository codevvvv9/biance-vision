/**
 * /api/admin/* 路由汇总：
 * - agents / evaluations / models（docs/specs/api-storage.md、admin-security.md、evaluation-deployment.md）
 * - 核心域：users（含聊天管控）、audit-logs、ai/overview|user|conversations（链路 A 会话全景）、
 *   conversations（链路 B 研究会话追踪）
 * 全部 requireSuperadmin；DB 不可用 503；发布/回滚/训练触发/聊天管控写审计。
 * debug-run：用版本配置跑一次轻量校验（能力/知识绑定解析 + 检索冒烟），不产生正式研究结论。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import {
  AgentCapabilitiesSchema,
  AgentConfigSchema,
  AgentVersionSchema,
  EvalDatasetSchema,
  EvalDatasetKindSchema,
  EvalRunSchema,
  TraderProfilePatchSchema,
} from 'biance-vision-brooks'
import { listActiveUsernames, queryAudit, recordAudit } from '../audit.js'
import { createDraft as createPromptDraft, currentPointers as listPromptPointers, listTemplates as listPromptTemplates, publishTemplate, rollbackTo as rollbackPromptTo, toDto as promptToDto, updateDraft as updatePromptDraft } from './promptsAdmin.js'
import { getUsers, updateChatPolicy } from '../users.js'
import type { SessionRecord } from '../users.js'
import { getChatUsageToday, normalizeChatPolicy } from '../chatPolicy.js'
import { buildSystemPrompt, getAiProfilesMasked, resolveAiProfile, resolveAiProfileName } from '../ai.js'
import {
  adminAiStats,
  getConversationAny,
  listConversations as listAiConversations,
  listMemories,
  memoriesPromptBlock,
} from '../aiMemory.js'
import { getDb } from '../db.js'
import { kv, log } from '../logger.js'
import { evalDatasets, evalRuns, predictionModels } from '../models.js'
import type { EvalDatasetRow, EvalRunRow, PredictionModelRow } from '../models.js'
import { searchHybrid } from '../knowledge/retrieval.js'
import { latestKnowledgeVersion } from '../knowledge/store.js'
import { getCapabilities, refreshCapabilities, resolveSecret, saveCapabilities } from './capabilities.js'
import {
  createDraft,
  getCurrentAgentVersion,
  getVersion,
  listVersions,
  publishVersion,
  rollbackTo,
  toVersionDto,
  updateDraft,
} from './agentVersions.js'
import { enqueueEvalRun, enqueueTrainJob, pinnedConfigVersion } from './jobs.js'
import { researchPyHealthy } from '../researchpy.js'
import { toModelInfo } from '../research/productRoutes.js'
import { getConversationByIdAdmin, listConversationsWithStats, listMessages } from '../research/runs/conversation.js'
import { getRun, listActiveRuns, requestCancel } from '../research/runs/store.js'

interface AdminRouteDeps {
  requireSuperadmin: (req: FastifyRequest) => SessionRecord
}

function ensureStorage(reply: FastifyReply): boolean {
  if (!getDb()) {
    reply.code(503).send({ code: 'storage_unavailable', message: 'PostgreSQL 不可用' })
    return false
  }
  return true
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ code: 'bad_request', message })
}

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown, reply: FastifyReply): z.infer<S> | null {
  const r = schema.safeParse(body)
  if (!r.success) {
    badRequest(reply, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('；'))
    return null
  }
  return r.data as z.infer<S>
}

// ---- /api/admin/agents ----

function registerAgentRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/api/admin/agents/versions', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const current = await getCurrentAgentVersion()
    return { versions: (await listVersions()).map(toVersionDto).map((v) => AgentVersionSchema.parse(v)), currentVersionId: current?.id ?? null }
  })

  app.post('/api/admin/agents/versions', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = parseBody(z.object({ label: z.string().trim().min(1).max(64), config: AgentConfigSchema }), req.body, reply)
    if (!body) return reply
    try {
      const row = await createDraft(body)
      recordAudit(session, { action: 'settings_update', target: row.id, detail: `新建 Agent 版本草稿「${body.label}」` })
      return reply.code(201).send({ version: AgentVersionSchema.parse(toVersionDto(row)) })
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      const status = /duplicate|unique/i.test(e.message) ? 400 : (e.statusCode ?? 500)
      return reply.code(status).send({ code: 'create_failed', message: /unique/i.test(e.message) ? '版本标签已存在' : e.message })
    }
  })

  app.put('/api/admin/agents/versions/:id', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const body = parseBody(z.object({ config: AgentConfigSchema }), req.body, reply)
    if (!body) return reply
    try {
      const row = await updateDraft(id, body.config)
      recordAudit(session, { action: 'settings_update', target: id, detail: '编辑 Agent 版本草稿' })
      return { version: AgentVersionSchema.parse(toVersionDto(row)) }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'update_failed', message: e.message })
    }
  })

  app.post('/api/admin/agents/versions/:id/publish', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    try {
      const row = await publishVersion(id)
      await refreshCapabilities()
      recordAudit(session, { action: 'settings_update', target: id, detail: `发布 Agent 版本「${row.label}」（当前发布指针切换）` })
      return { version: AgentVersionSchema.parse(toVersionDto(row)) }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'publish_failed', message: e.message })
    }
  })

  app.post('/api/admin/agents/versions/:id/rollback', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    try {
      const row = await rollbackTo(id)
      await refreshCapabilities()
      recordAudit(session, { action: 'settings_update', target: id, detail: `回滚到 Agent 版本「${row.label}」` })
      return { version: AgentVersionSchema.parse(toVersionDto(row)) }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'rollback_failed', message: e.message })
    }
  })

  /** 调试运行：解析版本配置的依赖（能力/知识版本）并跑一次检索冒烟，返回校验结果 */
  app.post('/api/admin/agents/versions/:id/debug-run', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const row = await getVersion(id)
    if (!row) return reply.code(404).send({ code: 'not_found', message: '版本不存在' })
    const config = AgentConfigSchema.parse(row.config)
    const caps = getCapabilities()
    const latestKv = await latestKnowledgeVersion()
    const outcome = await searchHybrid('H2 second entry pullback', {
      finalLimit: config.retrieval?.finalLimit ?? 5,
      candidateLimit: config.retrieval?.candidateLimit,
      skipRerank: config.retrieval?.rerank === false,
    })
    return {
      versionLabel: row.label,
      checks: {
        chat: caps.chat.enabled ? 'on' : '待配置',
        embedding: caps.embedding.enabled ? 'on' : '待配置（向量召回跳过）',
        rerank: caps.rerank.enabled ? 'on' : '待配置（精排跳过）',
        search: caps.search.enabled ? 'on' : '待配置（事件研究搜索不可用）',
        knowledgeVersion: config.ruleParams?.knowledgeVersion ?? latestKv?.id ?? '无发布知识版本',
      },
      retrievalSmoke: {
        hits: outcome.hits.length,
        topTitles: outcome.hits.slice(0, 3).map((h) => h.docTitle),
        notes: outcome.debug.notes,
      },
    }
  })

  /** 能力配置读写（草稿期全局配置；Agent 版本发布后以其 config.capabilities 为准） */
  app.get('/api/admin/agents/capabilities', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    await refreshCapabilities()
    return { capabilities: getCapabilities(), source: (await getCurrentAgentVersion()) ? 'agent_version' : 'app_settings' }
  })

  app.put('/api/admin/agents/capabilities', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    try {
      const caps = await saveCapabilities(req.body)
      recordAudit(session, { action: 'settings_update', target: 'capabilities', detail: `能力配置更新（app_settings）` })
      return { capabilities: caps }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 400).send({ code: 'save_failed', message: e.message })
    }
  })

  /**
   * 能力连通性测试：body 可携带未保存的草稿配置（先测后存）；
   * 缺省测当前生效配置。embedding 报告维度与耗时（维度需与
   * knowledge_chunks.embedding 列一致）；未启用/未配置的能力明确「待配置」。
   */
  app.post('/api/admin/agents/capabilities/test', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    await refreshCapabilities()
    const overrides = (req.body ?? {}) as { capabilities?: unknown }
    let caps = getCapabilities()
    if (overrides.capabilities !== undefined) {
      const parsed = AgentCapabilitiesSchema.safeParse(overrides.capabilities)
      if (!parsed.success) return badRequest(reply, '草稿能力配置不合法')
      caps = parsed.data
    }
    const started = Date.now()
    const results: Record<string, { status: 'ok' | 'failed' | 'skipped'; detail: string; latencyMs?: number }> = {}

    if (!caps.embedding.enabled || !caps.embedding.baseUrl || !caps.embedding.model) {
      results.embedding = { status: 'skipped', detail: '待配置（enabled/baseUrl/model 不全）' }
    } else {
      const t0 = Date.now()
      try {
        const key = resolveSecret(caps.embedding.secretRef)
        const res = await fetch(`${caps.embedding.baseUrl.replace(/\/+$/, '')}/embeddings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: caps.embedding.model, input: ['connectivity probe'] }),
          signal: AbortSignal.timeout(20_000),
        })
        if (!res.ok) {
          results.embedding = { status: 'failed', detail: `HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`, latencyMs: Date.now() - t0 }
        } else {
          const json = (await res.json()) as { data?: { embedding: number[] }[] }
          const dims = json.data?.[0]?.embedding.length ?? 0
          results.embedding = { status: 'ok', detail: `连接成功，返回 ${dims} 维（配置 ${caps.embedding.dims ?? 1536}${dims === (caps.embedding.dims ?? 1536) ? '' : '，与配置不一致！'}）`, latencyMs: Date.now() - t0 }
        }
      } catch (err) {
        results.embedding = { status: 'failed', detail: (err as Error).message, latencyMs: Date.now() - t0 }
      }
    }

    if (!caps.rerank.enabled || !caps.rerank.baseUrl || !caps.rerank.model) {
      results.rerank = { status: 'skipped', detail: '待配置' }
    } else {
      const t0 = Date.now()
      try {
        const key = resolveSecret(caps.rerank.secretRef)
        const res = await fetch(`${caps.rerank.baseUrl.replace(/\/+$/, '')}/rerank`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: caps.rerank.model, query: 'probe', documents: ['probe'] }),
          signal: AbortSignal.timeout(15_000),
        })
        results.rerank = res.ok
          ? { status: 'ok', detail: '连接成功', latencyMs: Date.now() - t0 }
          : { status: 'failed', detail: `HTTP ${res.status}`, latencyMs: Date.now() - t0 }
      } catch (err) {
        results.rerank = { status: 'failed', detail: (err as Error).message, latencyMs: Date.now() - t0 }
      }
    }

    if (!caps.chat.enabled || !caps.chat.baseUrl || !caps.chat.model) {
      results.chat = { status: 'skipped', detail: '待配置' }
    } else {
      const t0 = Date.now()
      try {
        const res = await fetch(`${caps.chat.baseUrl.replace(/\/+$/, '')}/models`, {
          headers: { authorization: `Bearer ${resolveSecret(caps.chat.secretRef) ?? ''}` },
          signal: AbortSignal.timeout(10_000),
        })
        results.chat = res.ok
          ? { status: 'ok', detail: '模型列表可达', latencyMs: Date.now() - t0 }
          : { status: 'failed', detail: `HTTP ${res.status}`, latencyMs: Date.now() - t0 }
      } catch (err) {
        results.chat = { status: 'failed', detail: (err as Error).message, latencyMs: Date.now() - t0 }
      }
    }

    for (const k of ['vision', 'search'] as const) {
      results[k] = { status: 'skipped', detail: caps[k].enabled ? '已启用（本页不探测，运行时验证）' : '待配置' }
    }
    return { results, totalMs: Date.now() - started }
  })
}

// ---- /api/admin/evaluations ----

function toDatasetDto(row: EvalDatasetRow): z.infer<typeof EvalDatasetSchema> {
  return EvalDatasetSchema.parse({
    id: row.id,
    kind: row.kind,
    name: row.name,
    version: row.version,
    itemCount: row.itemCount,
  })
}

function toEvalRunDto(row: EvalRunRow): z.infer<typeof EvalRunSchema> {
  return EvalRunSchema.parse({
    id: row.id,
    datasetId: row.datasetId,
    configVersion: row.configVersion,
    status: row.status,
    metrics: row.metrics ?? null,
    startedAt: row.startedAt ?? undefined,
    endedAt: row.endedAt ?? undefined,
  })
}

function registerEvaluationRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/api/admin/evaluations/datasets', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const rows = await getDb()!.select().from(evalDatasets).orderBy(desc(evalDatasets.createdAt))
    // 只返回元信息（items 可能很大，详情按 id 取）
    return { datasets: rows.map(toDatasetDto) }
  })

  app.get('/api/admin/evaluations/datasets/:id', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const rows = await getDb()!.select().from(evalDatasets).where(eq(evalDatasets.id, id)).limit(1)
    if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '数据集不存在' })
    return { dataset: toDatasetDto(rows[0]), items: rows[0].items }
  })

  app.post('/api/admin/evaluations/datasets', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = parseBody(
      z.object({
        kind: EvalDatasetKindSchema,
        name: z.string().trim().min(1).max(100),
        items: z.array(z.unknown()).min(1).max(2000),
      }),
      req.body,
      reply,
    )
    if (!body) return reply
    // 同名数据集版本递增（旧行保留）
    const prev = await getDb()!
      .select({ version: evalDatasets.version })
      .from(evalDatasets)
      .where(and(eq(evalDatasets.kind, body.kind), eq(evalDatasets.name, body.name)))
      .orderBy(desc(evalDatasets.version))
      .limit(1)
    const version = (prev[0]?.version ?? 0) + 1
    const rows = await getDb()!
      .insert(evalDatasets)
      .values({ kind: body.kind, name: body.name, version, itemCount: body.items.length, items: body.items })
      .returning()
    recordAudit(session, { action: 'settings_update', target: rows[0].id, detail: `新建评测数据集「${body.name}」v${version}（${body.kind}，${body.items.length} 条）` })
    return reply.code(201).send({ dataset: toDatasetDto(rows[0]) })
  })

  /**
   * 编辑已有数据集版本（改名或整体替换 items）：原地更新、version 不变——
   * 版本递增语义由 POST（同名新建 = version+1）承担，PUT 只修正该版本行本身。
   */
  app.put('/api/admin/evaluations/datasets/:id', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const body = parseBody(
      z
        .object({
          name: z.string().trim().min(1).max(100).optional(),
          items: z.array(z.unknown()).min(1).max(2000).optional(),
        })
        .refine((v) => v.name !== undefined || v.items !== undefined, { message: '至少提供 name 或 items 之一' }),
      req.body,
      reply,
    )
    if (!body) return reply
    const patch: { name?: string; items?: unknown[]; itemCount?: number; updatedAt: Date } = { updatedAt: new Date() }
    if (body.name !== undefined) patch.name = body.name
    if (body.items !== undefined) {
      patch.items = body.items
      patch.itemCount = body.items.length
    }
    const rows = await getDb()!.update(evalDatasets).set(patch).where(eq(evalDatasets.id, id)).returning()
    if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '数据集不存在' })
    recordAudit(session, {
      action: 'settings_update',
      target: id,
      detail: `编辑评测数据集「${rows[0].name}」v${rows[0].version}（${[body.name !== undefined ? '改名' : null, body.items !== undefined ? `替换 items=${body.items.length}` : null].filter(Boolean).join('，')}）`,
    })
    return { dataset: toDatasetDto(rows[0]) }
  })

  app.delete('/api/admin/evaluations/datasets/:id', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const rows = await getDb()!.delete(evalDatasets).where(eq(evalDatasets.id, id)).returning()
    if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '数据集不存在' })
    recordAudit(session, { action: 'settings_update', target: id, detail: `删除评测数据集「${rows[0].name}」v${rows[0].version}` })
    return { ok: true }
  })

  app.post('/api/admin/evaluations/runs', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = parseBody(z.object({ datasetId: z.string().uuid() }), req.body, reply)
    if (!body) return reply
    const ds = await getDb()!.select().from(evalDatasets).where(eq(evalDatasets.id, body.datasetId)).limit(1)
    if (ds.length === 0) return reply.code(404).send({ code: 'not_found', message: '数据集不存在' })
    const configVersion = await pinnedConfigVersion()
    const rows = await getDb()!
      .insert(evalRuns)
      .values({ datasetId: body.datasetId, configVersion, status: 'queued' })
      .returning()
    const queued = await enqueueEvalRun(rows[0].id)
    if (!queued) return reply.code(503).send({ code: 'queue_unavailable', message: '队列不可用，稍后重试' })
    recordAudit(session, { action: 'settings_update', target: rows[0].id, detail: `触发评测（数据集 ${ds[0].name} v${ds[0].version}，配置 ${configVersion}）` })
    return reply.code(202).send({ run: toEvalRunDto(rows[0]) })
  })

  app.get('/api/admin/evaluations/runs/:id', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const rows = await getDb()!.select().from(evalRuns).where(eq(evalRuns.id, id)).limit(1)
    if (rows.length === 0) return reply.code(404).send({ code: 'not_found', message: '评测运行不存在' })
    return { run: toEvalRunDto(rows[0]), report: rows[0].report ?? null, error: rows[0].error ?? null }
  })

  app.get('/api/admin/evaluations/runs', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const rows = await getDb()!.select().from(evalRuns).orderBy(desc(evalRuns.createdAt)).limit(50)
    return { runs: rows.map(toEvalRunDto) }
  })
}

// ---- /api/admin/models（训练触发 + 注册表管理视角） ----

function registerModelRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/api/admin/models', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const rows = await getDb()!.select().from(predictionModels).orderBy(desc(predictionModels.updatedAt))
    return {
      models: rows.map((r: PredictionModelRow) => ({ ...toModelInfo(r), artifactPath: r.artifactPath ?? null, unavailableReason: r.status })),
      researchPy: { healthy: await researchPyHealthy() },
    }
  })

  app.post('/api/admin/models/train', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = parseBody(
      z.object({
        modelVersion: z.string().trim().min(1).max(64),
        horizon: z.enum(['10m', '30m', '1h', '1d', '1w']),
        symbol: z.string().trim().optional(),
        marketType: z.enum(['spot', 'usdm_perp']).optional(),
        /** 事件（strike_relative，指数价）| 方向研究（return_positive，成交价；1w 方向研究用） */
        targetType: z.enum(['strike_relative', 'return_positive']).optional(),
      }),
      req.body,
      reply,
    )
    if (!body) return reply
    if (!(await researchPyHealthy())) {
      return reply.code(503).send({ code: 'researchpy_down', message: 'research-py 服务不可达（先启动 compose research-py 或本地 uvicorn）' })
    }
    const queued = await enqueueTrainJob(body)
    if (!queued) return reply.code(503).send({ code: 'queue_unavailable', message: '队列不可用，稍后重试' })
    recordAudit(session, { action: 'settings_update', target: body.modelVersion, detail: `触发模型训练（${body.horizon}，${body.symbol ?? 'BTCUSDT'}）` })
    log.ok('model', '训练任务入队', kv({ 模型: body.modelVersion, 期限: body.horizon }))
    return reply.code(202).send({ ok: true, modelVersion: body.modelVersion })
  })

  /** 分布校准确认 + 发布：数值门槛（训练时落库）与校准确认双门控后才 published */
  app.post('/api/admin/models/:modelVersion/calibrate-confirm', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return
    const { modelVersion } = req.params as { modelVersion: string }
    const { confirmCalibrationAndPublish } = await import('../research/training.js')
    const r = await confirmCalibrationAndPublish(modelVersion)
    if (!r.ok) return reply.code(409).send({ code: 'calibration_rejected', message: r.reason })
    recordAudit(session, { action: 'settings_update', target: modelVersion, detail: '分布校准确认并发布模型（candidate → published）' })
    return { ok: true, modelVersion, status: 'published' }
  })
}

// ---- 核心域：用户 / 审计 / AI 全景 / 聊天管控 / 研究会话追踪（自 index.ts 收口） ----

function registerAdminCoreRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  /** 系统真实用户列表（AI 档案绑定等场景需精准匹配用户名，不含密码哈希）；
   * 附带聊天管控与当日用量；activeRecently 为活跃近似（5 分钟内有审计动作的进行中会话，
   * 只读浏览不计——见 audit.ts listActiveUsernames） */
  app.get('/api/admin/users', async (req) => {
    deps.requireSuperadmin(req)
    const active = listActiveUsernames(5 * 60_000)
    return {
      users: getUsers()
        .map((u) => {
          const chatPolicy = normalizeChatPolicy(u)
          return {
            username: u.username,
            role: u.role,
            createdAt: u.createdAt,
            chatPolicy,
            chatUsage: { today: getChatUsageToday(u.username), limit: chatPolicy.dailyLimit },
            activeRecently: active.has(u.username),
          }
        })
        .sort((a, b) => a.role.localeCompare(b.role) || a.createdAt - b.createdAt),
    }
  })

  app.get('/api/admin/audit-logs', async (req) => {
    deps.requireSuperadmin(req)
    const q = req.query as { username?: string; limit?: string }
    return queryAudit({ username: q.username, limit: parseInt(q.limit ?? '', 10) || 200 })
  })

  // ---- AI 会话记录全景（链路 A：aiMemory 的 ai_conversations；上下文 / 记忆 / 提示词 / 配置） ----

  /** 各用户 AI 使用统计 + 全部档案（脱敏） */
  app.get('/api/admin/ai/overview', async (req) => {
    deps.requireSuperadmin(req)
    return {
      stats: adminAiStats().map((s) => ({ ...s, profileName: resolveAiProfileName(s.username) })),
      profiles: getAiProfilesMasked(),
    }
  })

  /** 指定用户 AI 全景：生效档案与配置、会话列表、长期记忆、完整生效提示词 */
  app.get('/api/admin/ai/user', async (req, reply) => {
    deps.requireSuperadmin(req)
    const username = String((req.query as { username?: string }).username ?? '').trim()
    if (!username) return badRequest(reply, '缺少 username')
    const profileName = resolveAiProfileName(username)
    const profile = resolveAiProfile(username)
    return {
      username,
      profileName,
      profileConfigured: !!profile,
      profileMasked: getAiProfilesMasked()[profileName] ?? null,
      prompt: profile ? buildSystemPrompt(profile, memoriesPromptBlock(username)) : '',
      conversations: listAiConversations(username),
      memories: listMemories(username),
    }
  })

  /** 任意会话的完整消息记录（链路 A，不限归属，管理端查看上下文用） */
  app.get('/api/admin/ai/conversations/:id', async (req, reply) => {
    deps.requireSuperadmin(req)
    const conv = getConversationAny((req.params as { id: string }).id)
    if (!conv) return badRequest(reply, '会话不存在')
    return {
      conversation: {
        id: conv.id,
        username: conv.username,
        title: conv.title || '新对话',
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messages: conv.messages.map((m) => ({ role: m.role, content: m.content, at: m.at })),
      },
    }
  })

  // ---- 用户级聊天管控 ----

  /** 更新聊天管控：disabled 禁用/解禁；dailyLimit 正整数上限或 null 解除 */
  app.put('/api/admin/users/:username/chat-policy', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    const { username } = req.params as { username: string }
    const body = parseBody(
      z
        .object({
          disabled: z.boolean().optional(),
          dailyLimit: z.number().int().positive().nullable().optional(),
        })
        .refine((v) => v.disabled !== undefined || v.dailyLimit !== undefined, { message: '至少提供 disabled 或 dailyLimit 之一' }),
      req.body,
      reply,
    )
    if (!body) return reply
    const user = updateChatPolicy(username, body)
    if (!user) return reply.code(404).send({ code: 'not_found', message: `用户 ${username} 不存在` })
    const chatPolicy = normalizeChatPolicy(user)
    recordAudit(session, {
      action: 'chat_policy_update',
      target: user.username,
      detail: `聊天管控更新：${chatPolicy.disabled ? '禁用' : '启用'}，每日上限 ${chatPolicy.dailyLimit ?? '不限'}`,
    })
    log.info('admin', '聊天管控更新', kv({ 操作者: session.username, 目标: user.username, 禁用: chatPolicy.disabled, 每日上限: chatPolicy.dailyLimit ?? '不限' }))
    return { username: user.username, chatPolicy }
  })

  /** 一键切断：先禁用聊天（纯 JSON，DB 不可用也生效），再尽力取消其全部未终态研究运行；
   * cancelDeferred=true 表示 DB 不可用或有 run 未取消成功（可能竞态终态），禁用本身不受影响 */
  app.post('/api/admin/users/:username/chat-cutoff', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    const { username } = req.params as { username: string }
    const user = updateChatPolicy(username, { disabled: true })
    if (!user) return reply.code(404).send({ code: 'not_found', message: `用户 ${username} 不存在` })
    const cancelledRuns: string[] = []
    let cancelDeferred = false
    if (getDb()) {
      for (const r of await listActiveRuns(user.username)) {
        if (await requestCancel(r.id, user.username)) cancelledRuns.push(r.id)
        else cancelDeferred = true
      }
    } else {
      cancelDeferred = true
    }
    recordAudit(session, {
      action: 'chat_cutoff',
      target: user.username,
      detail:
        `聊天切断：禁用聊天并取消 ${cancelledRuns.length} 个进行中研究` +
        (cancelDeferred ? '（部分取消延后：DB 不可用或运行已竞态终态）' : ''),
    })
    log.warn('admin', '聊天切断', kv({ 操作者: session.username, 目标: user.username, 取消研究: cancelledRuns.length, 取消延后: cancelDeferred || undefined }))
    return { disabled: true, cancelledRuns, cancelDeferred }
  })

  // ---- 研究会话追踪（链路 B：conversations/conversation_messages） ----

  /** 指定用户的会话列表（带消息数统计） */
  app.get('/api/admin/conversations', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const q = req.query as { username?: string; limit?: string }
    const username = String(q.username ?? '').trim()
    if (!username) return badRequest(reply, '缺少 username')
    const limit = Math.min(Math.max(parseInt(q.limit ?? '', 10) || 50, 1), 200)
    const rows = await listConversationsWithStats(username, limit)
    return {
      conversations: rows.map((c) => ({
        id: c.id,
        title: c.title,
        context: c.context,
        updatedAt: c.updatedAt.getTime(),
        messageCount: c.messageCount,
      })),
    }
  })

  /** 会话详情：完整消息 + 引用的研究运行摘要（runId 去重拉取） */
  app.get('/api/admin/conversations/:id', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const conv = await getConversationByIdAdmin(id)
    if (!conv) return reply.code(404).send({ code: 'not_found', message: '会话不存在' })
    const messages = await listMessages(id, undefined, 500)
    const runIds = [...new Set(messages.map((m) => m.runId).filter((x): x is string => typeof x === 'string' && x !== ''))]
    const runs: Record<string, { id: string; status: string; product: string; symbol: string; horizon: string; createdAt: number }> = {}
    for (const runId of runIds) {
      const run = await getRun(runId)
      if (run) {
        runs[run.id] = { id: run.id, status: run.status, product: run.product, symbol: run.symbol, horizon: run.horizon, createdAt: run.createdAt.getTime() }
      }
    }
    return {
      conversation: {
        id: conv.id,
        userId: conv.userId,
        title: conv.title,
        context: conv.context,
        createdAt: conv.createdAt.getTime(),
        updatedAt: conv.updatedAt.getTime(),
      },
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        intent: m.intent,
        content: m.content,
        card: m.card,
        runId: m.runId,
        createdAt: m.createdAt.getTime(),
      })),
      runs,
    }
  })
}

// ---- /api/admin/prompts（P0-6 提示词注册表：列表/草稿/编辑/发布/回滚；全 requireSuperadmin+审计） ----

function registerPromptRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/api/admin/prompts', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const q = req.query as { name?: string; scene?: string }
    const [templates, pointers] = await Promise.all([listPromptTemplates(q.name, q.scene), listPromptPointers()])
    return { templates: templates.map(promptToDto), pointers }
  })

  app.post('/api/admin/prompts', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(64),
        scene: z.string().trim().max(64).optional(),
        content: z.string().min(1).max(20000),
        note: z.string().max(500).optional(),
      }),
      req.body,
      reply,
    )
    if (body === null) return reply
    try {
      const row = await createPromptDraft({ ...body, createdBy: session.username })
      recordAudit(session, { action: 'settings_update', target: row.id, detail: `新建提示词草稿「${row.name}」v${row.version}` })
      return reply.code(201).send({ template: promptToDto(row) })
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'create_failed', message: e.message })
    }
  })

  app.put('/api/admin/prompts/:id', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const body = parseBody(z.object({ content: z.string().min(1).max(20000).optional(), note: z.string().max(500).optional() }), req.body, reply)
    if (body === null) return reply
    try {
      const row = await updatePromptDraft(id, body)
      recordAudit(session, { action: 'settings_update', target: id, detail: `编辑提示词草稿「${row.name}」v${row.version}` })
      return { template: promptToDto(row) }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'update_failed', message: e.message })
    }
  })

  app.post('/api/admin/prompts/:id/publish', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    try {
      const row = await publishTemplate(id)
      recordAudit(session, { action: 'settings_update', target: id, detail: `发布提示词「${row.name}」v${row.version}（指针已切换）` })
      return { template: promptToDto(row) }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'publish_failed', message: e.message })
    }
  })

  app.post('/api/admin/prompts/:id/rollback', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    try {
      const row = await rollbackPromptTo(id)
      recordAudit(session, { action: 'settings_update', target: id, detail: `回滚提示词「${row.name}」到 v${row.version}` })
      return { template: promptToDto(row) }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'rollback_failed', message: e.message })
    }
  })
}

// ---- /api/admin/settings（P1-8：免责文案与输入面板配置；requireSuperadmin+审计）----
function registerSettingsRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/api/admin/settings/disclaimers', async (req) => {
    deps.requireSuperadmin(req)
    const { getDisclaimers, DEFAULT_DISCLAIMERS } = await import('./settingsStore.js')
    return { disclaimers: await getDisclaimers(), defaults: DEFAULT_DISCLAIMERS }
  })

  app.put('/api/admin/settings/disclaimers', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    const body = parseBody(
      z.object({
        perp: z.string().max(500).optional(),
        event: z.string().max(500).optional(),
        common: z.string().max(500).optional(),
      }),
      req.body,
      reply,
    )
    if (body === null) return
    const { saveDisclaimers } = await import('./settingsStore.js')
    const disclaimers = await saveDisclaimers(body)
    recordAudit(session, { action: 'settings_update', target: 'research_disclaimers', detail: '更新免责文案（研究回复与结果卡）' })
    return { disclaimers }
  })

  app.get('/api/admin/settings/chat-input', async (req) => {
    deps.requireSuperadmin(req)
    const { getChatInputConfig } = await import('./settingsStore.js')
    return { chatInput: await getChatInputConfig() }
  })

  app.put('/api/admin/settings/chat-input', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    const { saveChatInputConfig } = await import('./settingsStore.js')
    try {
      const chatInput = await saveChatInputConfig(req.body)
      recordAudit(session, { action: 'settings_update', target: 'chat_input_config', detail: `更新输入面板配置（${Object.keys(chatInput.scenes).join(',')} 场景）` })
      return { chatInput }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 400).send({ code: 'save_failed', message: e.message })
    }
  })

  /** P1-4 admin 代改用户画像（trader_profiles；审计留痕） */
  app.put('/api/admin/users/:username/profile', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return
    const { username } = req.params as { username: string }
    const parsed = TraderProfilePatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return badRequest(reply, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'))
    const { saveTraderProfile } = await import('../research/profile.js')
    const profile = await saveTraderProfile(username, parsed.data)
    recordAudit(session, { action: 'settings_update', target: username, detail: `代改用户画像（风险=${profile.riskProfile ?? '未设'}，经验=${profile.experienceLevel ?? '未设'}）` })
    return { username, profile }
  })
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  registerAdminCoreRoutes(app, deps)
  registerAgentRoutes(app, deps)
  registerEvaluationRoutes(app, deps)
  registerModelRoutes(app, deps)
  registerPromptRoutes(app, deps)
  registerSettingsRoutes(app, deps)
}
