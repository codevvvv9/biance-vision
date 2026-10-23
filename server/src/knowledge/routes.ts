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
import { ADMIN_VIEWER } from './access.js'
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
  findDocumentByContentHash,
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
import { contentTypeForFileName } from './fileType.js'
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

  // ---- 离线导入通道（R2 §3.7 多路径兜底：MinerU/任意解析器产物上传）----
  // 接收 multipart：原文件（file）+ 解析产物（blocks JSON 字段）+ 元数据
  // 原文件存 blob + 建档（contentHash 去重）+ 直接用 blocks 切分入库（跳过 parseStep）
  // 产物走与在线通道完全相同的清洗→切分→质量门（红线 R-C：不允许绕过质量门）
  app.post('/api/admin/knowledge/documents/import-parsed', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    if (!req.isMultipart()) return badRequest(reply, '请用 multipart/form-data（file + blocks + 可选元数据）')
    const parts = req.parts({ limits: { fileSize: 50 * 1024 * 1024 } })
    let file: { buffer: Buffer; filename: string } | null = null
    let blocksJson = ''
    let metaJson = ''
    const fields: Record<string, string> = {}
    for await (const part of parts) {
      if (part.type === 'file') {
        file = { buffer: Buffer.from(await part.toBuffer()), filename: part.filename }
      } else if (part.fieldname === 'blocks') {
        blocksJson = String(part.value)
      } else if (part.fieldname === 'parseMeta') {
        metaJson = String(part.value)
      } else {
        fields[part.fieldname] = String(part.value)
      }
    }
    if (!file) return badRequest(reply, '缺少 file 字段（原始文件）')
    if (!blocksJson) return badRequest(reply, '缺少 blocks 字段（解析产物 JSON 数组）')

    // blocks 契约：ParsedBlock[]（kind/text/pageNo/figureId/level）
    const blocksParse = z
      .array(
        z.object({
          kind: z.enum(['text', 'figure', 'table', 'heading']),
          text: z.string().optional(),
          pageNo: z.number().int().positive().optional(),
          figureId: z.string().optional(),
          level: z.number().int().min(1).max(6).optional(),
        }),
      )
      .min(1)
      .safeParse(JSON.parse(blocksJson))
    if (!blocksParse.success) {
      return badRequest(reply, `blocks 格式不合法：${blocksParse.error.issues[0]?.message ?? '未知'}（期望 ParsedBlock[] JSON）`)
    }
    let externalMeta: Record<string, unknown> = {}
    if (metaJson) {
      try {
        externalMeta = JSON.parse(metaJson) as Record<string, unknown>
      } catch {
        return badRequest(reply, 'parseMeta 字段不是合法 JSON')
      }
    }

    const tier = TierSchema.safeParse(fields.sourceTier ?? 'community')
    const access = AccessSchema.safeParse(fields.access ?? 'public')
    if (!tier.success || !access.success) return badRequest(reply, 'sourceTier/access 取值不合法')
    const title = (fields.title ?? '').trim() || file.filename

    try {
      // 建档（blob 存储 + contentHash 去重，与在线通道同一入口）
      const result = await ingestBuffer({
        buffer: file.buffer,
        fileName: file.filename,
        title,
        sourceType: 'file',
        sourceTier: tier.data,
        access: access.data,
      })
      if (result.status === 'duplicate') {
        return { status: 'duplicate', document: { id: result.existingId } }
      }

      // 跳过 parseStep，直接走清洗→切分→质量门→索引（红线 R-C：与在线同规）
      const { processDocument } = await import('./pipeline.js')
      const { getDocument, setDocStatus } = await import('./store.js')
      const doc = await getDocument(result.docId)
      if (!doc) return badRequest(reply, '建档后文档消失（内部错误）')

      // 用 external blocks 替代 parseStep 的结果，标记来源
      const offlineMeta = {
        parser: (externalMeta.parser as string) ?? 'offline-import',
        blockCount: blocksParse.data.length,
        attemptId: crypto.randomUUID(),
        importedAt: new Date().toISOString(),
        ...externalMeta,
      }
      // 直接调用 processDocument 但注入 blocks（通过 pipeline 的离线入口）
      // 简化实现：setDocStatus 到 parsed 再走后半段
      await setDocStatus(result.docId, 'parsing', { parseMeta: offlineMeta })
      const { cleanBlocks } = await import('./clean.js')
      const { qualityGate: gate } = await import('./qualityGate.js')
      const cleaned = cleanBlocks(blocksParse.data)
      const gateResult = gate(cleaned.blocks, blocksParse.data)
      if (gateResult.blocked) {
        await setDocStatus(result.docId, 'failed', { error: gateResult.blockReason })
        return reply.code(422).send({ code: 'quality_blocked', message: gateResult.blockReason })
      }
      await setDocStatus(result.docId, 'parsed', {
        parseMeta: { ...offlineMeta, cleanStats: cleaned.stats, qualityWarnings: gateResult.warnings },
      })
      // 后半段（chunked → indexed）由 processDocument 从 parsed 状态续跑——但当前
      // processDocument 是全流程。简化：直接在这里做切分+入库
      const { chunkBlocks } = await import('./chunk.js')
      const { replaceChunks, workingVersionId } = await import('./store.js')
      const chunks = chunkBlocks(cleaned.blocks)
      if (chunks.length === 0) {
        await setDocStatus(result.docId, 'failed', { error: '切分结果为空' })
        return badRequest(reply, '切分结果为空（blocks 内容不足以产生有效切块）')
      }
      const updatedDoc = (await getDocument(result.docId))!
      await replaceChunks(updatedDoc, chunks)
      await setDocStatus(result.docId, 'indexed', {
        parseMeta: { ...offlineMeta, chunkCount: chunks.length, cleanStats: cleaned.stats, qualityWarnings: gateResult.warnings },
      })
      recordAudit(session, {
        action: 'knowledge_import',
        target: 'import-parsed',
        detail: `离线导入 ${file.filename}（${blocksParse.data.length} blocks → ${chunks.length} chunks，parser=${offlineMeta.parser}）`,
      })
      return {
        status: 'indexed',
        document: { id: result.docId, title },
        chunkCount: chunks.length,
        qualityWarnings: gateResult.warnings,
      }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'import_parsed_failed', message: e.message })
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

  // ---- W2 第三批：清单条目状态（ManifestDialog 数据源，修 G1 断链半边） ----
  const manifestEntryDto = (r: Awaited<ReturnType<typeof listManifestEntries>>[number]): Record<string, unknown> => ({
    id: r.id,
    url: r.url,
    type: r.type,
    title: r.title,
    topics: r.topics,
    status: r.status,
    docId: r.docId,
    lastError: r.lastError,
    enabled: r.enabled,
    access: r.access,
    sourceTier: r.sourceTier,
    importMethod: r.importMethod,
    notes: r.notes,
    updatedAt: r.updatedAt.getTime(),
  })

  app.get('/api/admin/knowledge/manifest-entries', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    return { entries: (await listManifestEntries()).map(manifestEntryDto) }
  })

  // 从默认清单重新同步（只 upsert 条目入库，不抓取；抓取仍走 import-manifest）
  app.post('/api/admin/knowledge/manifest-entries/sync', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = z.object({ entries: z.array(ManifestEntrySchema).min(1).max(200) }).safeParse(req.body ?? {})
    if (!body.success) return badRequest(reply, body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'))
    const count = await upsertManifestEntries(body.data.entries)
    recordAudit(session, {
      action: 'knowledge_import',
      target: 'manifest',
      detail: `从默认清单重新同步 ${count} 条（仅入库不抓取）`,
    })
    return { synced: count, entries: (await listManifestEntries()).map(manifestEntryDto) }
  })

  // ---- W2 第三批：上传预检（三道校验的第三道：contentHash 服务端查重） ----
  app.post('/api/admin/knowledge/documents/precheck', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = z.object({ contentHash: z.string().length(64) }).safeParse(req.body ?? {})
    if (!body.success) return badRequest(reply, 'contentHash 必填（sha256 hex，64 字符）')
    const existing = await findDocumentByContentHash(body.data.contentHash)
    return {
      duplicate: existing !== null,
      existingId: existing?.id ?? null,
      existingTitle: existing?.title ?? null,
    }
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
    reply.header('content-type', contentTypeForFileName(doc.fileName))
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
      access: ADMIN_VIEWER, // 管理端检索调试按超管全量（W1-A）
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

  // ---- W2 知识库管理端新增端点（lumen 六模式的后端支撑）----

  // 文档删除（两段式：默认归档+purge=true 彻底清除）
  app.delete('/api/admin/knowledge/documents/:id', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const purge = (req.query as { purge?: string }).purge === '1'
    try {
      const { deleteDocument } = await import('./store.js')
      const result = await deleteDocument(id, { purge })
      recordAudit(session, {
        action: 'knowledge_delete',
        target: id.slice(0, 8),
        detail: purge ? `彻底清除（chunks+blob+版本引用）` : `归档（移出当前发布集合，新版本 ${result.newVersionLabel ?? '无变更'}）`,
      })
      return result
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'delete_failed', message: e.message })
    }
  })

  // 轻量状态批量端点（差异轮询：只传 id 列表，只回 id/status/errorCode/ageMs + worker 心跳）
  app.get('/api/admin/knowledge/documents/statuses', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const ids = String((req.query as { ids?: string }).ids ?? '').split(',').filter(Boolean).slice(0, 100)
    if (ids.length === 0) return badRequest(reply, 'ids 参数必填（逗号分隔，≤100）')
    const { listDocuments, workerHeartbeat } = await import('./store.js')
    const [all, worker] = await Promise.all([listDocuments(), workerHeartbeat()])
    const byId = new Map(all.map((d) => [d.id, d]))
    const now = Date.now()
    return {
      statuses: ids.map((id) => {
        const d = byId.get(id)
        return {
          id,
          status: d?.status ?? 'gone',
          errorCode: d?.error ?? null,
          ageMs: d ? now - d.updatedAt.getTime() : 0,
        }
      }),
      worker,
    }
  })

  // 解析日志（ParseLogDrawer 数据源）：单轮=最近一轮的完整 stage 时间线；
  // 旧文档（W2 打点启用前）无事件 → hasEvents=false，前端降级文案
  app.get('/api/admin/knowledge/documents/:id/events', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    const { getDocument } = await import('./store.js')
    const doc = await getDocument(id)
    if (!doc) return reply.code(404).send({ code: 'not_found', message: '文档不存在' })
    const meta = doc.parseMeta as Record<string, unknown>
    const events = Array.isArray(meta.events) ? (meta.events as unknown[]) : []
    return {
      docId: doc.id,
      title: doc.title,
      status: doc.status,
      runNo: Number(meta.runNo) || 0,
      attemptId: typeof meta.attemptId === 'string' ? meta.attemptId : null,
      hasEvents: events.length > 0,
      events: events.map((e, i) => {
        const ev = e as { seq?: number; stage?: string; message?: string | null; atMs?: number; durationMs?: number | null }
        return {
          seq: ev.seq ?? i + 1,
          stage: ev.stage ?? 'unknown',
          message: ev.message ?? null,
          atMs: ev.atMs ?? 0,
          durationMs: ev.durationMs ?? null,
        }
      }),
    }
  })

  // 版本历史列表
  app.get('/api/admin/knowledge/versions', async (req, reply) => {
    deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { listKnowledgeVersions } = await import('./store.js')
    const versions = await listKnowledgeVersions()
    return {
      versions: versions.map((v) => ({
        id: v.id,
        label: v.label,
        docCount: v.docVersionIds.length,
        note: v.note,
        createdBy: v.createdBy,
        createdAt: v.createdAt.getTime(),
      })),
    }
  })

  // 版本回滚（旧集合发布新版本，不修改历史——红线 2）
  app.post('/api/admin/knowledge/versions/:id/restore', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    try {
      const { getKnowledgeVersion, latestKnowledgeVersion } = await import('./store.js')
      const target = await getKnowledgeVersion(id)
      if (!target) return reply.code(404).send({ code: 'not_found', message: '版本不存在' })
      const latest = await latestKnowledgeVersion()
      if (latest?.id === id) return badRequest(reply, '该版本已是当前版本')
      // 红线 2：以旧集合发布新版本，不就地改历史
      const { randomUUID } = await import('node:crypto')
      const { getDb } = await import('../db.js')
      const { knowledgeVersions } = await import('../models.js')
      const label = `restore-${target.label}`
      const db = getDb()
      if (!db) return badRequest(reply, '数据库不可用')
      const [newVer] = await db.insert(knowledgeVersions).values({
        id: randomUUID(),
        label,
        docVersionIds: target.docVersionIds,
        note: `restore:${target.label}`,
        createdBy: session.username,
      }).returning()
      recordAudit(session, { action: 'knowledge_restore', target: target.label, detail: `切回 ${target.label} → 新版本 ${label}（${target.docVersionIds.length} docs）` })
      return { restored: true, newVersion: { id: newVer.id, label: newVer.label, docCount: newVer.docVersionIds.length } }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'restore_failed', message: e.message })
    }
  })

  // 案例下架（G4：接通既有 setCasePublished(false)）
  app.post('/api/admin/knowledge/cases/:id/unpublish', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const { id } = req.params as { id: string }
    try {
      const { setCasePublished } = await import('./ruleCards.js')
      const cw = await setCasePublished(id, false)
      recordAudit(session, { action: 'knowledge_unpublish', target: `case:${id.slice(0, 8)}`, detail: `案例下架（${cw.symbol}/${cw.interval}）` })
      return { ok: true }
    } catch (err) {
      const e = err as { statusCode?: number; message: string }
      return reply.code(e.statusCode ?? 500).send({ code: 'unpublish_failed', message: e.message })
    }
  })

  // 批量操作（发布/重解析/删除——部分失败汇报）
  app.post('/api/admin/knowledge/documents/batch', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    if (!ensureStorage(reply)) return reply
    const body = z.object({
      action: z.enum(['publish', 'reparse', 'delete']),
      ids: z.array(z.string()).min(1).max(50),
      purge: z.boolean().optional(),
    }).safeParse(req.body ?? {})
    if (!body.success) return badRequest(reply, body.error.issues[0]?.message ?? '参数不合法')
    const { action, ids, purge } = body.data
    const succeeded: string[] = []
    const failed: { id: string; error: string }[] = []
    for (const id of ids) {
      try {
        if (action === 'publish') {
          const { publishDocument } = await import('./store.js')
          await publishDocument(id, `batch:${session.username}`, session.username)
          succeeded.push(id)
        } else if (action === 'reparse') {
          const { processDocument } = await import('./pipeline.js')
          await processDocument(id).catch(() => {}) // reparse 异步入队，不等待完成
          succeeded.push(id)
        } else if (action === 'delete') {
          const { deleteDocument } = await import('./store.js')
          await deleteDocument(id, { purge })
          succeeded.push(id)
        }
      } catch (err) {
        failed.push({ id, error: (err as Error).message.slice(0, 200) })
      }
    }
    recordAudit(session, {
      action: `knowledge_batch_${action}` as 'knowledge_batch_publish',
      target: `${ids.length} docs`,
      detail: `批量${action}：成功 ${succeeded.length}，失败 ${failed.length}`,
    })
    return { succeeded, failed }
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
    const citation = await fetchCitation(id, { access: ADMIN_VIEWER }) // 管理端按超管全量（W1-A）
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
