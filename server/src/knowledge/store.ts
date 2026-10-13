/**
 * 知识库存储层（PG 唯一权威）：
 * - 文档状态机 uploaded→parsing→parsed→chunked→indexed→published / failed；
 * - 切块按 docVersionId（`${docId}#${version}`）组织：重解析写「工作版本」
 *   （version+1），发布时 bump version 并登记进全局 knowledge_versions；
 *   已发布版本的切块不可变，旧引用（引用快照）不随资料更新失效；
 * - 检索只命中 knowledge_versions 登记过的 docVersionId，与 doc.status 解耦。
 */
import { createHash } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeManifestEntries,
  knowledgeVersions,
} from '../models.js'
import type {
  KnowledgeChunkRow,
  KnowledgeDocumentRow,
  KnowledgeManifestEntryRow,
  KnowledgeVersionRow,
  NewKnowledgeChunkRow,
} from '../models.js'
import { getDb } from '../db.js'
import { kv, log } from '../logger.js'
import type { KnowledgeChunk } from './chunk.js'
import { extractDocTerms } from './terms.js'
import type { ManifestEntry } from 'biance-vision-brooks'

export class StoreUnavailableError extends Error {
  constructor() {
    super('PostgreSQL 不可用，知识库不可读写')
    this.name = 'StoreUnavailableError'
  }
}

function db() {
  const d = getDb()
  if (!d) throw new StoreUnavailableError()
  return d
}

export function sha256hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

// ---- 文档 ----

export interface CreateDocumentInput {
  sourceType: 'file' | 'url' | 'manifest'
  title: string
  sourceUrl?: string | null
  fileName?: string
  blobKey?: string | null
  sourceTier?: 'official' | 'official_derivative' | 'community'
  access?: 'public' | 'purchase' | 'member'
  contentHash: string
  manifestEntryId?: string | null
}

export interface CreateDocumentResult {
  doc: KnowledgeDocumentRow
  /** 命中已有相同 contentHash 的文档 */
  duplicateOf: KnowledgeDocumentRow | null
}

/** 新建文档（状态 uploaded）；contentHash 重复时返回 duplicateOf，不落新行 */
export async function createDocument(input: CreateDocumentInput): Promise<CreateDocumentResult> {
  const d = db()
  const existing = await d
    .select()
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.contentHash, input.contentHash))
    .limit(1)
  if (existing.length > 0) return { doc: existing[0], duplicateOf: existing[0] }
  const rows = await d
    .insert(knowledgeDocuments)
    .values({
      sourceType: input.sourceType,
      title: input.title,
      sourceUrl: input.sourceUrl ?? null,
      fileName: input.fileName ?? '',
      blobKey: input.blobKey ?? null,
      sourceTier: input.sourceTier ?? 'community',
      access: input.access ?? 'public',
      contentHash: input.contentHash,
      status: 'uploaded',
    })
    .returning()
  const doc = rows[0]
  log.info(
    'knowledge',
    '新建文档',
    kv({ id: doc.id.slice(0, 8), 标题: doc.title, 来源: doc.sourceType }),
  )
  if (input.manifestEntryId) {
    await d
      .update(knowledgeManifestEntries)
      .set({ status: 'imported', docId: doc.id, lastError: null, updatedAt: new Date() })
      .where(eq(knowledgeManifestEntries.id, input.manifestEntryId))
  }
  return { doc, duplicateOf: null }
}

export async function getDocument(id: string): Promise<KnowledgeDocumentRow | null> {
  const rows = await db().select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id)).limit(1)
  return rows[0] ?? null
}

export async function listDocuments(status?: string): Promise<KnowledgeDocumentRow[]> {
  const q = db().select().from(knowledgeDocuments)
  const rows =
    status !== undefined && status !== ''
      ? await q.where(eq(knowledgeDocuments.status, status)).orderBy(desc(knowledgeDocuments.updatedAt))
      : await q.orderBy(desc(knowledgeDocuments.updatedAt))
  return rows
}

export async function setDocStatus(
  id: string,
  status: KnowledgeDocumentRow['status'],
  patch: { error?: string | null; parseMeta?: Record<string, unknown> } = {},
): Promise<void> {
  await db()
    .update(knowledgeDocuments)
    .set({ status, error: patch.error ?? null, ...(patch.parseMeta ? { parseMeta: patch.parseMeta } : {}), updatedAt: new Date() })
    .where(eq(knowledgeDocuments.id, id))
}

/** 建档后回填 blobKey（键含 docId，需先有 id） */
export async function setDocBlobKey(id: string, blobKey: string): Promise<void> {
  await db().update(knowledgeDocuments).set({ blobKey, updatedAt: new Date() }).where(eq(knowledgeDocuments.id, id))
}

/** 工作版本 id：解析/切分/索引写入的目标版本（发布后即成正式版本号） */
export function workingVersionId(doc: KnowledgeDocumentRow): string {
  return `${doc.id}#${doc.version + 1}`
}

// ---- 切块 ----

/** 重解析覆盖工作版本切块（同 docVersionId 全删全插；已发布版本不受影响） */
export async function replaceChunks(
  doc: KnowledgeDocumentRow,
  chunks: KnowledgeChunk[],
): Promise<KnowledgeChunkRow[]> {
  const d = db()
  const docVersionId = workingVersionId(doc)
  const values: NewKnowledgeChunkRow[] = chunks.map((c) => ({
    docId: doc.id,
    docVersionId,
    chunkIndex: c.chunkIndex,
    kind: c.kind,
    text: c.text,
    pageNo: c.pageNo,
    figureId: c.figureId,
    headingPath: c.headingPath,
    terms: extractDocTerms([...c.headingPath, c.text].join('\n')).slice(0, 96),
    contentHash: c.contentHash,
  }))
  return d.transaction(async (tx) => {
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.docVersionId, docVersionId))
    if (values.length === 0) return []
    const inserted: KnowledgeChunkRow[] = []
    for (let i = 0; i < values.length; i += 200) {
      const part = await tx.insert(knowledgeChunks).values(values.slice(i, i + 200)).returning()
      inserted.push(...part)
    }
    return inserted
  })
}

/** 向量写入（仅 pgvector enabled 时调用）；按行 update，失败抛错由上层决定状态 */
export async function storeEmbeddings(rows: { id: string; vector: number[] }[]): Promise<void> {
  if (rows.length === 0) return
  const d = db()
  for (const r of rows) {
    const literal = `[${r.vector.map((n) => Number(n.toFixed(6))).join(',')}]`
    await d.execute(
      sql`update knowledge_chunks set embedding = ${literal}::vector where id = ${r.id}`,
    )
  }
}

export async function listChunksOfVersion(docVersionId: string): Promise<KnowledgeChunkRow[]> {
  return db()
    .select()
    .from(knowledgeChunks)
    .where(eq(knowledgeChunks.docVersionId, docVersionId))
    .orderBy(knowledgeChunks.chunkIndex)
}

export async function getChunkById(id: string): Promise<KnowledgeChunkRow | null> {
  const rows = await db().select().from(knowledgeChunks).where(eq(knowledgeChunks.id, id)).limit(1)
  return rows[0] ?? null
}

/** 邻接上下文：同版本内 chunkIndex 相邻的切块（方向不限，各取一条） */
export async function getAdjacentChunks(chunk: KnowledgeChunkRow): Promise<KnowledgeChunkRow[]> {
  const d = db()
  const rows = await d
    .select()
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.docVersionId, chunk.docVersionId),
        inArray(knowledgeChunks.chunkIndex, [chunk.chunkIndex - 1, chunk.chunkIndex + 1]),
      ),
    )
    .orderBy(knowledgeChunks.chunkIndex)
  return rows
}

// ---- 发布与知识版本 ----

export async function latestKnowledgeVersion(): Promise<KnowledgeVersionRow | null> {
  const rows = await db().select().from(knowledgeVersions).orderBy(desc(knowledgeVersions.createdAt)).limit(1)
  return rows[0] ?? null
}

export async function getKnowledgeVersion(id?: string): Promise<KnowledgeVersionRow | null> {
  if (id) {
    const rows = await db().select().from(knowledgeVersions).where(eq(knowledgeVersions.id, id)).limit(1)
    return rows[0] ?? null
  }
  return latestKnowledgeVersion()
}

/** 检索可见的 docVersionId 集合（指定版本或最新；无任何发布时为空数组） */
export async function publishedDocVersionIds(knowledgeVersionId?: string): Promise<string[]> {
  const v = await getKnowledgeVersion(knowledgeVersionId)
  return v?.docVersionIds ?? []
}

function nextVersionLabel(existing: KnowledgeVersionRow | null): string {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const prefix = `kv-${today}-`
  const last = existing?.label.startsWith(prefix)
    ? Number(existing.label.slice(prefix.length)) || 0
    : 0
  return `${prefix}${String(last + 1).padStart(2, '0')}`
}

export interface PublishResult {
  doc: KnowledgeDocumentRow
  knowledgeVersion: KnowledgeVersionRow
}

/**
 * 发布文档：bump doc.version（工作版本转正）→ 生成新的全局 knowledge_versions
 * （docVersionIds = 上一版集合 - 本文档旧版本 + 本文档新版本）。事务内完成；
 * 已开始的旧引用仍指向旧 docVersionId 的不可变切块。
 */
export async function publishDocument(
  docId: string,
  note: string,
  createdBy: string,
): Promise<PublishResult> {
  const d = db()
  return d.transaction(async (tx) => {
    const rows = await tx.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, docId)).limit(1)
    const doc = rows[0]
    if (!doc) throw Object.assign(new Error('文档不存在'), { statusCode: 404 })
    if (doc.status !== 'indexed') {
      throw Object.assign(new Error(`仅 indexed 状态可发布（当前 ${doc.status}）`), { statusCode: 400 })
    }
    const newVersion = doc.version + 1
    const newDocVersionId = `${doc.id}#${newVersion}`
    const chunkCount = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.docVersionId, newDocVersionId))
    if ((chunkCount[0]?.n ?? 0) === 0) {
      throw Object.assign(new Error('工作版本没有任何切块，拒绝发布'), { statusCode: 400 })
    }
    const updated = await tx
      .update(knowledgeDocuments)
      .set({ version: newVersion, status: 'published', updatedAt: new Date() })
      .where(eq(knowledgeDocuments.id, docId))
      .returning()
    const prevVersions = await tx.select().from(knowledgeVersions).orderBy(desc(knowledgeVersions.createdAt)).limit(1)
    const prev = prevVersions[0] ?? null
    const ids = new Set(prev?.docVersionIds ?? [])
    if (doc.version > 0) ids.delete(`${doc.id}#${doc.version}`)
    ids.add(newDocVersionId)
    const versionRows = await tx
      .insert(knowledgeVersions)
      .values({
        label: nextVersionLabel(prev),
        docVersionIds: [...ids],
        note,
        createdBy,
      })
      .returning()
    return { doc: updated[0], knowledgeVersion: versionRows[0] }
  })
}

// ---- manifest ----

/** 清单条目 upsert（按 id 覆盖；导入状态/错误保留） */
export async function upsertManifestEntries(entries: ManifestEntry[]): Promise<number> {
  if (entries.length === 0) return 0
  const d = db()
  for (const e of entries) {
    await d
      .insert(knowledgeManifestEntries)
      .values({
        id: e.id,
        url: e.url,
        type: e.type,
        title: e.title,
        topics: e.topics,
        access: e.access,
        sourceTier: e.sourceTier,
        importMethod: e.importMethod,
        enabled: e.enabled,
        notes: e.notes ?? null,
      })
      .onConflictDoUpdate({
        target: knowledgeManifestEntries.id,
        set: {
          url: e.url,
          type: e.type,
          title: e.title,
          topics: e.topics,
          access: e.access,
          sourceTier: e.sourceTier,
          importMethod: e.importMethod,
          enabled: e.enabled,
          notes: e.notes ?? null,
          updatedAt: new Date(),
        },
      })
  }
  return entries.length
}

export async function listManifestEntries(): Promise<KnowledgeManifestEntryRow[]> {
  return db().select().from(knowledgeManifestEntries).orderBy(knowledgeManifestEntries.id)
}

export async function setManifestEntryStatus(
  id: string,
  status: 'pending' | 'imported' | 'skipped' | 'failed',
  patch: { docId?: string | null; lastError?: string | null } = {},
): Promise<void> {
  await db()
    .update(knowledgeManifestEntries)
    .set({
      status,
      ...(patch.docId !== undefined ? { docId: patch.docId } : {}),
      lastError: patch.lastError ?? null,
      updatedAt: new Date(),
    })
    .where(eq(knowledgeManifestEntries.id, id))
}
