/**
 * 知识文档处理管线（worker 侧执行，docs/specs/knowledge-rag.md 流程 1-4）：
 * uploaded → parsing →（PDF/DOCX：research-py Docling；TXT/MD/HTML：原生解析）
 * → parsed（存 blocks 元信息）→ chunked（chunkBlocks 结构化切分）
 * → indexed（terms[] 词项 + embedding 向量（可用时））。
 * 任一步失败 → failed + 原因（reparse 可重试）；embedding 不可用时显式记
 * embeddingSkipped，索引不阻塞（向量召回届时禁用），状态机仍可达 indexed。
 */
import type { ParsedBlock } from './chunk.js'
import { chunkBlocks } from './chunk.js'
import { nativeFormatOf, parseNative } from './parse.js'
import type { PyParseBlock } from '../researchpy.js'
import { parseDocument } from '../researchpy.js'
import { getBlobStore } from './blobstore.js'
import { getCapabilities } from '../admin/capabilities.js'
import { resolveEmbeddingClient } from './embeddings.js'
import { probeVectorSupport, vectorSupportSync } from './vector.js'
import {
  getDocument,
  listChunksOfVersion,
  replaceChunks,
  setDocStatus,
  sha256hex,
  storeEmbeddings,
  workingVersionId,
} from './store.js'
import type { KnowledgeDocumentRow } from '../models.js'
import { kv, log } from '../logger.js'

const DOCLING_EXTS = new Set(['pdf', 'docx', 'doc'])

export function isDoclingFile(fileName: string): boolean {
  return DOCLING_EXTS.has((fileName.toLowerCase().split('.').pop() ?? ''))
}

function toParsedBlocks(py: PyParseBlock[]): ParsedBlock[] {
  return py
    .filter((b) => (b.text ?? '').toString().trim() !== '' || b.kind !== 'text')
    .map((b) => ({
      kind: b.kind,
      text: (b.text ?? '') || undefined,
      pageNo: b.pageNo ?? undefined,
      figureId: b.figureId ?? undefined,
    }))
}

/** 解析一步：读原始内容 → blocks；返回标题与元信息 */
async function parseStep(doc: KnowledgeDocumentRow): Promise<{ blocks: ParsedBlock[]; meta: Record<string, unknown> }> {
  const store = getBlobStore()
  const buf = doc.blobKey ? await store.get(doc.blobKey) : null
  if (!buf) throw new Error(`原始内容不可读（blobKey=${doc.blobKey ?? 'null'}），请重新导入`)
  if (isDoclingFile(doc.fileName)) {
    const res = await parseDocument({
      docId: doc.id,
      fileName: doc.fileName,
      contentBase64: buf.toString('base64'),
    })
    if (res.status !== 'ok') throw new Error(`Docling 解析失败：${res.error ?? '未知原因'}`)
    return {
      blocks: toParsedBlocks(res.blocks),
      meta: {
        parser: 'docling',
        pageCount: res.pageCount ?? null,
        blockCount: res.blocks.length,
        figureCount: res.blocks.filter((b) => b.kind === 'figure').length,
      },
    }
  }
  const format = nativeFormatOf(doc.fileName)
  if (!format) throw new Error(`不支持的文件格式：${doc.fileName}（支持 pdf/docx/txt/md/html）`)
  const { blocks, title } = parseNative(format, buf.toString('utf8'))
  if (blocks.length === 0) throw new Error('解析结果为空（文件损坏或内容为空）')
  return {
    blocks,
    meta: { parser: `native-${format}`, blockCount: blocks.length, title },
  }
}

/** 索引一步：terms 在 replaceChunks 时已写入；此处按能力补 embedding */
async function indexStep(doc: KnowledgeDocumentRow): Promise<Record<string, unknown>> {
  await probeVectorSupport()
  const embedder = resolveEmbeddingClient(getCapabilities().embedding)
  if (vectorSupportSync() !== 'enabled') {
    return { embeddingSkipped: true, vectorSupport: 'disabled' }
  }
  if (!embedder) {
    return { embeddingSkipped: true, reason: 'embedding 能力未配置（待配置）' }
  }
  const versionId = workingVersionId(doc)
  const chunks = await listChunksOfVersion(versionId)
  const textChunks = chunks.filter((c) => c.text.trim() !== '')
  const vectors = await embedder.embed(textChunks.map((c) => c.text))
  if (vectors.length !== textChunks.length) throw new Error('embedding 返回数量不一致')
  const pairs = textChunks
    .map((c, i) => ({ id: c.id, vector: vectors[i] }))
    .filter((p): p is { id: string; vector: number[] } => p.vector !== undefined)
  await storeEmbeddings(pairs)
  return { embedded: textChunks.length, dims: embedder.dims }
}

/** 全流程处理一个文档（worker 任务入口；也可被导入路由同步调用/自测脚本调用） */
export async function processDocument(docId: string): Promise<KnowledgeDocumentRow> {
  let doc = await getDocument(docId)
  if (!doc) throw new Error(`文档不存在：${docId}`)
  if (doc.status === 'parsing') throw new Error('文档正在解析中')
  try {
    await setDocStatus(docId, 'parsing')
    doc = (await getDocument(docId))!
    const startedAt = Date.now()

    const { blocks, meta } = await parseStep(doc)
    await setDocStatus(docId, 'parsed', { parseMeta: { ...doc.parseMeta, ...meta } })

    const chunks = chunkBlocks(blocks)
    if (chunks.length === 0) throw new Error('切分结果为空')
    await replaceChunks(doc, chunks)
    await setDocStatus(docId, 'chunked')

    doc = (await getDocument(docId))!
    const indexMeta = await indexStep(doc)
    const mergedMeta = { ...(await getDocument(docId))!.parseMeta, ...indexMeta, chunkCount: chunks.length }
    await setDocStatus(docId, 'indexed', { parseMeta: mergedMeta })

    const done = await getDocument(docId)
    log.ok(
      'knowledge',
      '文档处理完成（待审核发布）',
      kv({
        id: docId.slice(0, 8),
        标题: doc.title,
        切块: chunks.length,
        向量: 'embeddingSkipped' in indexMeta ? '跳过' : (indexMeta.embedded as number),
        耗时ms: Date.now() - startedAt,
      }),
    )
    return done!
  } catch (err) {
    const message = (err as Error).message
    await setDocStatus(docId, 'failed', { error: message }).catch(() => {})
    log.warn('knowledge', '文档处理失败', kv({ id: docId.slice(0, 8), 原因: message }))
    throw err
  }
}

/** 内容指纹（导入路由用）：文件字节 / 抓取正文的 sha256 */
export { sha256hex }
