/**
 * 知识导入的三通道落库辅助（路由与 manifest 批量导入共用）：
 * 文件上传 / URL 抓取 / manifest 条目 → BlobStore 存原始内容 → 建文档（contentHash 去重）
 * → 入队解析。URL 导入遇访问限制（401/403/登录墙）如实失败，不绕过。
 */
import {
  createDocument,
  setDocBlobKey,
  setManifestEntryStatus,
  sha256hex,
} from './store.js'
import { getBlobStore } from './blobstore.js'
import { enqueueKnowledgeParse } from './jobs.js'
import { nativeFormatOf } from './parse.js'
import { isDoclingFile } from './pipeline.js'
import { kv, log } from '../logger.js'

export interface IngestInput {
  buffer: Buffer
  fileName: string
  title: string
  sourceType: 'file' | 'url' | 'manifest'
  sourceUrl?: string | null
  sourceTier?: 'official' | 'official_derivative' | 'community'
  access?: 'public' | 'purchase' | 'member'
  manifestEntryId?: string | null
  contentType?: string
}

export interface IngestResult {
  status: 'queued' | 'duplicate'
  docId: string
  title: string
  /** duplicate 时指向已有文档 */
  existingId: string | null
}

const MAX_BYTES = 50 * 1024 * 1024

export async function ingestBuffer(input: IngestInput): Promise<IngestResult> {
  if (input.buffer.byteLength === 0) throw Object.assign(new Error('内容为空'), { statusCode: 400 })
  if (input.buffer.byteLength > MAX_BYTES) {
    throw Object.assign(new Error(`内容超过上限 ${Math.round(MAX_BYTES / 1024 / 1024)}MB`), { statusCode: 400 })
  }
  const supported =
    isDoclingFile(input.fileName) || nativeFormatOf(input.fileName, input.contentType) !== null
  if (!supported) {
    throw Object.assign(
      new Error(`不支持的格式：${input.fileName || input.contentType || '未知'}（支持 pdf/docx/txt/md/html）`),
      { statusCode: 400 },
    )
  }
  const contentHash = sha256hex(input.buffer)
  const { doc, duplicateOf } = await createDocument({
    sourceType: input.sourceType,
    title: input.title,
    sourceUrl: input.sourceUrl ?? null,
    fileName: input.fileName,
    sourceTier: input.sourceTier,
    access: input.access,
    contentHash,
    manifestEntryId: input.manifestEntryId ?? null,
  })
  if (duplicateOf) {
    log.info('knowledge', '重复资料（contentHash 命中）', kv({ 标题: input.title, 已有: duplicateOf.id.slice(0, 8) }))
    if (input.manifestEntryId) {
      await setManifestEntryStatus(input.manifestEntryId, 'skipped', {
        docId: duplicateOf.id,
        lastError: 'contentHash 重复，已存在相同内容',
      })
    }
    return { status: 'duplicate', docId: duplicateOf.id, title: duplicateOf.title, existingId: duplicateOf.id }
  }
  await getBlobStore().put(`${doc.id}/${contentHash}/${input.fileName}`, input.buffer)
  // blobKey 落库（createDocument 先行是因为键里含 docId）
  await setDocBlobKey(doc.id, `${doc.id}/${contentHash}/${input.fileName}`)
  await enqueueKnowledgeParse(doc.id)
  return { status: 'queued', docId: doc.id, title: doc.title, existingId: null }
}

const URL_MAX_BYTES = 10 * 1024 * 1024

/** 从 URL 抓取内容（不绕过访问限制；失败如实抛错） */
export async function fetchUrlContent(
  url: string,
): Promise<{ buffer: Buffer; fileName: string; contentType: string }> {
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'user-agent': 'biance-vision-knowledge-import/1.0' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'follow',
    })
  } catch (err) {
    throw Object.assign(new Error(`抓取失败：${(err as Error).message}`), { statusCode: 502 })
  }
  if (res.status === 401 || res.status === 403 || res.status === 402) {
    throw Object.assign(
      new Error(`来源需要授权（HTTP ${res.status}）：URL 导入不绕过访问限制，请改用有使用权的文件上传`),
      { statusCode: 400 },
    )
  }
  if (!res.ok) throw Object.assign(new Error(`抓取失败：HTTP ${res.status}`), { statusCode: 502 })
  const contentType = res.headers.get('content-type') ?? ''
  if (/^text\/html|^text\/plain|markdown/.test(contentType) === false && !/pdf|word/.test(contentType)) {
    throw Object.assign(new Error(`不支持的内容类型：${contentType || '未知'}`), { statusCode: 400 })
  }
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > URL_MAX_BYTES) {
    throw Object.assign(new Error(`内容超过 URL 导入上限 ${Math.round(URL_MAX_BYTES / 1024 / 1024)}MB`), { statusCode: 400 })
  }
  let fileName = ''
  try {
    fileName = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')
  } catch {
    /* ignore */
  }
  if (!fileName || !/\.[a-z0-9]{2,5}$/i.test(fileName)) {
    const ext = contentType.includes('html') ? 'html' : contentType.includes('pdf') ? 'pdf' : contentType.includes('word') ? 'docx' : 'txt'
    fileName = fileName || `url-import-${Date.now()}.${ext}`
    if (!/\.[a-z0-9]{2,5}$/i.test(fileName)) fileName = `${fileName}.${ext}`
  }
  return { buffer: buf, fileName, contentType }
}
