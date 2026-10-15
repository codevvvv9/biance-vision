/**
 * /api/admin/knowledge/* 路由（docs/specs/knowledge-rag.md、api-storage.md）。
 * - 全部 requireSuperadmin；DB 不可用一律 503 { code: 'storage_unavailable' }
 * - 上传走 multipart（@fastify/multipart 已全局注册，单文件 ≤50MB）
 * - 响应经 shared zod schema 校验（KnowledgeDocument/ChunkPreview/SearchDebugResult）
 * - 导入/发布写 audit_records（action=knowledge_import / knowledge_publish）
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  KnowledgeChunkPreviewSchema,
  KnowledgeDocumentSchema,
  ManifestEntrySchema,
  SearchDebugResultSchema,
} from 'biance-vision-brooks'
import type { SearchDebugResult } from 'biance-vision-brooks'
import { recordAudit } from '../audit.js'
import type { SessionRecord } from '../users.js'
import { getDb } from '../db.js'
import { kv, log } from '../logger.js'
import { fetchUrlContent, ingestBuffer } from './ingest.js'
import { enqueueKnowledgeParse } from './jobs.js'
import { fetchCitation, searchHybrid } from './retrieval.js'
import {
  buildCaseWindow,
  deleteRuleCardDraft,
  draftRuleCard,
  getCaseWindow,
  getRuleCard,
  listCaseWindows,
  listRuleCards,
  publishRuleCard,
  setCasePublished,
  updateRuleCardDraft,
} from './ruleCards.js'
import {
  getDocument,
  getKnowledgeVersion,
  listChunksOfVersion,
  listDocuments,
  listManifestEntries,
  publishDocument,
  setManifestEntryStatus,
  upsertManifestEntries,
  workingVersionId,
} from './store.js'
import { getBlobStore } from './blobstore.js'
import { vectorStatus } from './vector.js'

interface KnowledgeRouteDeps {
  requireSuperadmin: (req: FastifyRequest) => SessionRecord
}

function ensureStorage(reply: FastifyReply): boolean {
  if (!getDb()) {
    reply.code(503).send({ code: 'storage_unavailable', message: 'PostgreSQL 不可用，知识库不可用' })
    return false
  }
  return true
}

function badRequest(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ code: 'bad_request', message })
}

const TierSchema = z.enum(['official', 'official_derivative', 'community'])
const AccessSchema = z.enum(['public', 'purchase', 'member'])

/** 表行 → 契约对象（时间戳转毫秒） */
function toDocumentDto(row: {
  id: string
  sourceType: string
  title: string
  status: string
  sourceTier: string
  access: string
  version: number
  contentHash: string
  error: string | null
  createdAt: Date
}): z.infer<typeof KnowledgeDocumentSchema> {
  return KnowledgeDocumentSchema.parse({
    id: row.id,
    sourceType: row.sourceType,
    title: row.title,
    status: row.status,
    sourceTier: row.sourceTier,
    access: row.access,
    version: row.version,
    contentHash: row.contentHash,
    error: row.error ?? undefined,
    createdAt: row.createdAt.getTime(),
  })
}

export function registerKnowledgeRoutes(app: FastifyInstance, deps: KnowledgeRouteDeps): void {
  // ---- 文件上传（multipart：file + title/sourceTier/access 字段） ----
  app.post('/api/admin/knowledge/documents', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    if (!req.isMultipart()) return badRequest(reply, '请用 multipart/form-data 上传文件')
    const parts = req.parts({ limits: { fileSize: 50 * 1024 * 1024 } })
    let file: { buffer: Buffer; filename: string; mimetype: string } | null = null
    const fields: Record<string, string> = {}
    for await (const part of parts) {
      if (part.type === 'file') {
        if (file) return badRequest(reply, '一次只允许上传一个文件')
        file = { buffer: Buffer.from(await part.toBuffer()), filename: part.filename, mimetype: part.mimetype }
      } else {
        fields[part.fieldname] = String(part.value)
      }
    }
    if (!file) return badRequest(reply, '缺少文件字段 file')
    const tier = TierSchema.safeParse(fields.sourceTier ?? 'community')
    const access = AccessSchema.safeParse(fields.access ?? 'public')
    if (!tier.success || !access.success) return badRequest(reply, 'sourceTier/access 取值不合法')
    const title = (fields.title ?? '').trim() || file.filename
    try {
      const result = await ingestBuffer({
        buffer: file.buffer,
        fileName: file.filename,
        title,
        sourceType: 'file',
        sourceTier: tier.data,
        access: access.data,
        contentType: file.mimetype,
      })
      recordAudit(session, {
        action: 'knowledge_import',
        target: result.docId,
        detail: `文件上传「${result.title}」（${result.status === 'duplicate' ? '重复资料' : '已入队解析'}）`,
      })
      const doc = await getDocument(result.docId)
      return reply.code(result.status === 'duplicate' ? 200 : 202).send({
        status: result.status,
        document: doc ? toDocumentDto(doc) : null,
      })
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'ingest_failed', message: e.message })
    }
  })

  // ---- 单 URL 导入 ----
  app.post('/api/admin/knowledge/documents/import-url', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = z
      .object({
        url: z.string().url(),
        title: z.string().trim().min(1).optional(),
        sourceTier: TierSchema.optional(),
        access: AccessSchema.optional(),
      })
      .safeParse(req.body ?? {})
    if (!body.success) return badRequest(reply, body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'))
    try {
      const { buffer, fileName, contentType } = await fetchUrlContent(body.data.url)
      const result = await ingestBuffer({
        buffer,
        fileName,
        title: body.data.title ?? fileName,
        sourceType: 'url',
        sourceUrl: body.data.url,
        sourceTier: body.data.sourceTier,
        access: body.data.access,
        contentType,
      })
      recordAudit(session, {
        action: 'knowledge_import',
        target: result.docId,
        detail: `URL 导入「${body.data.url}」（${result.status === 'duplicate' ? '重复资料' : '已入队解析'}）`,
      })
      const doc = await getDocument(result.docId)
      return reply.code(result.status === 'duplicate' ? 200 : 202).send({
        status: result.status,
        document: doc ? toDocumentDto(doc) : null,
      })
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 502).send({ code: 'import_failed', message: e.message })
    }
  })

  // ---- manifest 批量导入 ----
  app.post('/api/admin/knowledge/documents/import-manifest', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = z.object({ entries: z.array(ManifestEntrySchema).min(1).max(200) }).safeParse(req.body ?? {})
    if (!body.success) return badRequest(reply, body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'))
    const { entries } = body.data
    await upsertManifestEntries(entries)
    const summary = { imported: 0, duplicates: 0, failed: 0, pendingUpload: 0 }
    const failures: { id: string; error: string }[] = []
    for (const entry of entries) {
      if (!entry.enabled || entry.importMethod !== 'url_fetch') {
        if (entry.enabled) {
          summary.pendingUpload++
          await setManifestEntryStatus(entry.id, 'pending', { lastError: '等待用户上传有使用权的文件' })
        } else {
          await setManifestEntryStatus(entry.id, 'skipped', { lastError: '清单条目未启用' })
        }
        continue
      }
      if (entry.access !== 'public') {
        summary.pendingUpload++
        await setManifestEntryStatus(entry.id, 'skipped', { lastError: `访问方式 ${entry.access}，仅允许用户上传（URL 导入不绕过访问限制）` })
        continue
      }
      try {
        const { buffer, fileName, contentType } = await fetchUrlContent(entry.url)
        const result = await ingestBuffer({
          buffer,
          fileName,
          title: entry.title || fileName,
          sourceType: 'manifest',
          sourceUrl: entry.url,
          sourceTier: entry.sourceTier,
          access: entry.access,
          contentType,
          manifestEntryId: entry.id,
        })
        if (result.status === 'duplicate') summary.duplicates++
        else summary.imported++
      } catch (err) {
        summary.failed++
        const message = (err as Error).message
        failures.push({ id: entry.id, error: message })
        await setManifestEntryStatus(entry.id, 'failed', { lastError: message.slice(0, 500) })
      }
    }
    recordAudit(session, {
      action: 'knowledge_import',
      target: 'manifest',
      detail: `清单批量导入 ${entries.length} 条（新 ${summary.imported} / 重复 ${summary.duplicates} / 失败 ${summary.failed} / 待上传 ${summary.pendingUpload}）`,
    })
    return { summary, failures, entries: await listManifestEntries() }
  })

  // ---- 文档列表 / 预览 ----
  app.get('/api/admin/knowledge/documents', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const status = (req.query as { status?: string }).status
    const docs = await listDocuments(status)
    return { documents: docs.map(toDocumentDto) }
  })

  app.get('/api/admin/knowledge/documents/:id/preview', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const doc = await getDocument(id)
    if (!doc) return reply.code(404).send({ code: 'not_found', message: '文档不存在' })
    // 预览目标：已发布看当前版本，其余看工作版本
    const versionId = doc.status === 'published' ? `${doc.id}#${doc.version}` : workingVersionId(doc)
    const chunks = await listChunksOfVersion(versionId)
    const previews = chunks.map((c) =>
      KnowledgeChunkPreviewSchema.parse({
        chunkId: c.id,
        docId: c.docId,
        pageNo: c.pageNo ?? undefined,
        figureId: c.figureId ?? undefined,
        kind: c.kind,
        text: c.text.slice(0, 400),
      }),
    )
    return {
      document: toDocumentDto(doc),
      parseMeta: doc.parseMeta,
      chunks: previews,
      vector: vectorStatus(),
    }
  })

  // ---- 原始文件回读（管理端预览：PDF/HTML 走浏览器原生渲染，TXT/MD 前端按 md 展示） ----
  app.get('/api/admin/knowledge/documents/:id/file', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const doc = await getDocument(id)
    if (!doc || doc.blobKey === null || doc.blobKey === '')
      return reply.code(404).send({ code: 'not_found', message: '原始文件不存在（URL/manifest 导入无本地文件）' })
    const buf = await getBlobStore().get(doc.blobKey)
    if (buf === null) return reply.code(404).send({ code: 'not_found', message: '原始文件已丢失（blob 缺失）' })
    const ext = (doc.fileName.split('.').pop() ?? '').toLowerCase()
    const ct: Record<string, string> = {
      pdf: 'application/pdf',
      html: 'text/html; charset=utf-8',
      htm: 'text/html; charset=utf-8',
      txt: 'text/plain; charset=utf-8',
      md: 'text/markdown; charset=utf-8',
      markdown: 'text/markdown; charset=utf-8',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }
    reply.header('content-type', ct[ext] ?? 'application/octet-stream')
    reply.header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName || doc.title)}`)
    return reply.send(buf)
  })

  // ---- 重解析 / 发布 ----
  app.post('/api/admin/knowledge/documents/:id/reparse', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const doc = await getDocument(id)
    if (!doc) return reply.code(404).send({ code: 'not_found', message: '文档不存在' })
    if (doc.status === 'parsing') return badRequest(reply, '文档正在解析中')
    await enqueueKnowledgeParse(id)
    return { ok: true, docId: id }
  })

  app.post('/api/admin/knowledge/documents/:id/publish', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const note = z.string().trim().max(500).optional().parse((req.body as { note?: unknown } | null)?.note ?? undefined) || ''
    try {
      const { doc, knowledgeVersion } = await publishDocument(id, note, session.username)
      recordAudit(session, {
        action: 'knowledge_publish',
        target: knowledgeVersion.label,
        detail: `发布「${doc.title}」#${doc.version}（知识版本 ${knowledgeVersion.label}，含 ${knowledgeVersion.docVersionIds.length} 个文档版本）`,
      })
      log.ok('knowledge', '知识发布', kv({ 文档: doc.title, 知识版本: knowledgeVersion.label }))
      return {
        document: toDocumentDto(doc),
        knowledgeVersion: {
          id: knowledgeVersion.id,
          label: knowledgeVersion.label,
          docVersionIds: knowledgeVersion.docVersionIds,
          createdAt: knowledgeVersion.createdAt.getTime(),
        },
      }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'publish_failed', message: e.message })
    }
  })

  // ---- 知识版本查询 ----
  app.get('/api/admin/knowledge/versions/current', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const v = await getKnowledgeVersion()
    if (!v) return { version: null }
    return {
      version: { id: v.id, label: v.label, docVersionIds: v.docVersionIds, createdAt: v.createdAt.getTime() },
    }
  })

  // ---- 检索调试（各阶段打点 + 命中明细） ----
  app.get('/api/admin/knowledge/search-debug', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const q = z
      .object({
        query: z.string().trim().min(1).max(500),
        mode: z.enum(['support', 'counter']).optional(),
        knowledgeVersionId: z.string().uuid().optional(),
      })
      .safeParse(req.query)
    if (!q.success) return badRequest(reply, 'query 必填（1-500 字符）')
    const outcome = await searchHybrid(q.data.query, {
      mode: q.data.mode,
      knowledgeVersionId: q.data.knowledgeVersionId,
    })
    const debug: SearchDebugResult = {
      ...outcome.debug,
      hits: outcome.hits.map((h) => ({
        chunkId: h.chunk.id,
        docTitle: h.docTitle,
        pageNo: h.chunk.pageNo,
        figureId: h.chunk.figureId,
        kind: h.chunk.kind as 'text' | 'figure' | 'table',
        snippet: h.chunk.text.slice(0, 300),
        sourceTier: h.docSourceTier as 'official' | 'official_derivative' | 'community',
      })),
    }
    return SearchDebugResultSchema.parse(debug)
  })

  // ---- 引用定位原文 ----
  // ---- 规则卡层（草拟→审核→发布；LLM 草拟仅生成草稿） ----
  app.post('/api/admin/knowledge/rule-cards/draft', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = z.object({ concept: z.string().trim().min(1).max(64) }).safeParse(req.body ?? {})
    if (!body.success) return badRequest(reply, 'concept 必填')
    try {
      const r = await draftRuleCard(body.data.concept, session.username)
      recordAudit(session, { action: 'knowledge_import', target: r.card.id, detail: `规则卡草拟「${body.data.concept}」（${r.draftedBy}，证据 ${r.evidenceCount}）` })
      return reply.code(201).send({ card: r.card, draftedBy: r.draftedBy, evidenceCount: r.evidenceCount })
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'draft_failed', message: e.message })
    }
  })

  app.get('/api/admin/knowledge/rule-cards', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    return { cards: await listRuleCards((req.query as { status?: string }).status) }
  })

  app.put('/api/admin/knowledge/rule-cards/:id', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const body = z
      .object({
        definition: z.string(),
        conditions: z.array(z.string()),
        context: z.string(),
        invalidation: z.string(),
        confusable: z.array(z.string()),
        counterExamples: z.array(z.string()),
        ruleId: z.string(),
        sourceNote: z.string(),
      })
      .safeParse((req.body as { content?: unknown } | null)?.content ?? req.body)
    if (!body.success) return badRequest(reply, body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'))
    try {
      const card = await updateRuleCardDraft(id, body.data)
      recordAudit(session, { action: 'settings_update', target: id, detail: `编辑规则卡草稿「${card.concept}」` })
      return { card }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'update_failed', message: e.message })
    }
  })

  app.post('/api/admin/knowledge/rule-cards/:id/publish', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    try {
      const card = await publishRuleCard(id)
      recordAudit(session, { action: 'knowledge_publish', target: card.id, detail: `发布规则卡「${card.concept}」v${card.version}` })
      return { card }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'publish_failed', message: e.message })
    }
  })

  app.delete('/api/admin/knowledge/rule-cards/:id', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    try {
      await deleteRuleCardDraft(id)
      return { ok: true }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 400).send({ code: 'delete_failed', message: e.message })
    }
  })

  // ---- 案例层（构建→审核→发布；outcome 仅 admin 详情可见，检索只回可见字段） ----
  app.post('/api/admin/knowledge/cases', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = z
      .object({
        symbol: z.string().trim().min(1),
        marketType: z.enum(['spot', 'usdm_perp']),
        interval: z.string().trim().min(1),
        atTime: z.number().int().optional(),
        lookback: z.number().int().min(30).max(500).optional(),
        forwardBars: z.number().int().min(1).max(200).optional(),
        annotation: z.string().max(500).optional(),
      })
      .safeParse(req.body ?? {})
    if (!body.success) return badRequest(reply, body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'))
    try {
      const cw = await buildCaseWindow(body.data, session.username)
      recordAudit(session, { action: 'knowledge_import', target: cw.id, detail: `构建案例窗 ${body.data.symbol}/${body.data.interval}` })
      return reply.code(201).send({ caseWindow: { ...cw, outcome: undefined } })
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'build_failed', message: e.message })
    }
  })

  app.get('/api/admin/knowledge/cases', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const all = (req.query as { all?: string }).all === '1'
    const rows = await listCaseWindows(!all)
    // 列表不回 outcome（防误泄）；详情按 id 取
    return { cases: rows.map((r) => ({ ...r, outcome: undefined })) }
  })

  app.get('/api/admin/knowledge/cases/:id', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const cw = await getCaseWindow(id)
    if (cw === null) return reply.code(404).send({ code: 'not_found', message: '案例不存在' })
    return { caseWindow: cw }
  })

  app.post('/api/admin/knowledge/cases/:id/publish', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    try {
      const cw = await setCasePublished(id, true)
      recordAudit(session, { action: 'knowledge_publish', target: id, detail: `发布案例窗 ${cw.symbol}/${cw.interval}` })
      return { caseWindow: { ...cw, outcome: undefined } }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'publish_failed', message: e.message })
    }
  })

  app.get('/api/admin/knowledge/chunks/:id', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const citation = await fetchCitation(id)
    if (!citation) return reply.code(404).send({ code: 'not_found', message: '切块不存在' })
    return {
      chunk: {
        chunkId: citation.chunk.id,
        docId: citation.chunk.docId,
        docVersionId: citation.chunk.docVersionId,
        chunkIndex: citation.chunk.chunkIndex,
        kind: citation.chunk.kind,
        text: citation.chunk.text,
        pageNo: citation.chunk.pageNo,
        figureId: citation.chunk.figureId,
        headingPath: citation.chunk.headingPath,
        contentHash: citation.chunk.contentHash,
      },
      docTitle: citation.docTitle,
      docSourceTier: citation.docSourceTier,
      adjacent: citation.adjacent.map((a) => ({ chunkId: a.id, chunkIndex: a.chunkIndex, text: a.text.slice(0, 400) })),
    }
  })
}
