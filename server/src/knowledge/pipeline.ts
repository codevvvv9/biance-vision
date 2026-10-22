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
import type { PyParseBlock, PyParseEvent } from '../researchpy.js'
import { cancelParse, engineAvailability, inspectPdf, parseMineru, parseStatus, submitParseBatch } from '../researchpy.js'
import { cleanBlocks } from './clean.js'
import { qualityGate } from './qualityGate.js'
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
import { randomUUID } from 'node:crypto'
import { kv, log } from '../logger.js'

const DOCLING_EXTS = new Set(['pdf', 'docx', 'doc'])

export function isDoclingFile(fileName: string): boolean {
  return DOCLING_EXTS.has((fileName.toLowerCase().split('.').pop() ?? ''))
}

/** W1-B 异步分批参数（rag-pipeline §4.3）：20 页/批、批间 3s 轮询、总预算 15min */
const BATCH_PAGES = 20
const POLL_INTERVAL_MS = 3_000
const PARSE_BUDGET_MS = 15 * 60_000

function toParsedBlocks(py: PyParseBlock[]): ParsedBlock[] {
  return py
    .filter((b) => (b.text ?? '').toString().trim() !== '' || b.kind !== 'text')
    .map((b) => ({
      kind: b.kind,
      text: (b.text ?? '') || undefined,
      pageNo: b.pageNo ?? undefined,
      figureId: b.figureId ?? undefined,
      level: b.level ?? undefined,
    }))
}

/** 解析一步：读原始内容 → blocks；返回标题与元信息 */
async function parseStep(
  doc: KnowledgeDocumentRow,
  attemptId: string,
): Promise<{ blocks: ParsedBlock[]; meta: Record<string, unknown> }> {
  const store = getBlobStore()
  const buf = doc.blobKey ? await store.get(doc.blobKey) : null
  if (!buf) throw new Error(`原始内容不可读（blobKey=${doc.blobKey ?? 'null'}），请重新导入`)
  if (isDoclingFile(doc.fileName)) {
    const contentBase64 = buf.toString('base64')
    const allBlocks: ParsedBlock[] = []
    const events: PyParseEvent[] = []
    let pageCount: number | null = null
    const deadline = Date.now() + PARSE_BUDGET_MS

    // R2 双引擎路由（rag-pipeline §4.1 升级版）：
    // - 扫描版 → MinerU 直接路由（内置 OCR，比 Docling+RapidOCR 更强，不限页数）
    // - 数字版 → Docling 异步分批（当前主路径）
    // - Docling 结果质量差 → 自动 MinerU fallback（质量门触发）
    let engineChoice: 'docling' | 'mineru' = 'docling'
    if (doc.fileName.toLowerCase().endsWith('.pdf')) {
      try {
        const inspect = await inspectPdf(contentBase64)
        events.push({ seq: 1, stage: 'inspect', message: `pageCount=${inspect.pageCount} textRatio=${inspect.textCharRatio} encrypted=${inspect.encrypted}`, atMs: Date.now() })
        if (inspect.encrypted) {
          throw new Error('该 PDF 已加密，无法解析（请提供未加密版本）')
        }
        if (inspect.textCharRatio < 0.3) {
          // 扫描版：优先 MinerU（可用时），不可用则 Docling+RapidOCR
          const engines = await engineAvailability()
          if (engines.mineru) {
            engineChoice = 'mineru'
            events.push({ seq: events.length + 1, stage: 'route', message: `扫描版（textRatio=${inspect.textCharRatio}）→ MinerU 路由`, atMs: Date.now() })
          } else {
            events.push({ seq: events.length + 1, stage: 'route', message: `扫描版但 MinerU 不可用，走 Docling+OCR`, atMs: Date.now() })
          }
        }
      } catch (err) {
        if ((err as Error).message.includes('加密')) throw err
        events.push({ seq: events.length + 1, stage: 'inspect', message: `预检失败（继续常规解析）：${(err as Error).message}`, atMs: Date.now() })
      }
    }

    // ---- MinerU 路径（同步端点，内置 OCR，不限页数）----
    if (engineChoice === 'mineru') {
      const { parseMineru } = await import('../researchpy.js')
      events.push({ seq: events.length + 1, stage: 'parsing', message: `MinerU 解析开始`, atMs: Date.now() })
      const res = await parseMineru({ docId: doc.id, fileName: doc.fileName, contentBase64 })
      if (res.status !== 'ok') {
        throw new Error(`MinerU 解析失败：${res.error ?? '未知原因'}`)
      }
      events.push({ seq: events.length + 1, stage: 'completed', message: `MinerU ${res.blocks.length} blocks, ${res.pageCount ?? '?'} pages`, atMs: Date.now() })
      return {
        blocks: toParsedBlocks(res.blocks),
        meta: {
          parser: 'mineru',
          pageCount: res.pageCount ?? null,
          blockCount: res.blocks.length,
          headingCount: res.blocks.filter((b) => b.kind === 'heading').length,
          figureCount: res.blocks.filter((b) => b.kind === 'figure').length,
          attemptId,
          events: events.slice(-100),
        },
      }
    }

    // ---- Docling 路径（异步分批，数字版主路径）----
    // 整书 OOM 正是异步分批要修的（v0.11.1 Brooks 验收发现）；总页数从第一批
    // 结果拿（Python docling 的 pages 元数据在 page_range 模式下仍然返回全档页数）
    let pageFrom = 1
    let pageTo = BATCH_PAGES
    for (;;) {
      const taskId = `${attemptId}:${pageFrom}`
      await submitParseBatch({ taskId, docId: doc.id, fileName: doc.fileName, contentBase64, pageFrom, pageTo })
      events.push({ seq: events.length + 1, stage: 'parsing', message: `batch ${taskId} submitted (pages ${pageFrom}-${pageTo})`, atMs: Date.now() })
      let snap = await parseStatus(taskId)
      while (snap.status === 'pending' || snap.status === 'running') {
        if (Date.now() > deadline) {
          void cancelParse(taskId).catch(() => {})
          throw new Error('解析超时（15 分钟预算；页数过多或服务器繁忙）')
        }
        // 迟到防护：轮询期间文档已被新一轮解析接手 → 立即取消本批并抛错
        const current = await getDocument(doc.id)
        if (!current || (current.parseMeta as Record<string, unknown>).attemptId !== attemptId) {
          void cancelParse(taskId).catch(() => {})
          throw new Error('解析轮次已失效（新轮次已接管），旧轮次终止')
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        snap = await parseStatus(taskId)
      }
      // 任务到达终态：completed 时需要重新拉取结果（轮询默认不含 blocks——
      // v0.11.5「未知原因」根因：completed 但 blocks=null 误判为解析失败）
      if (snap.status === 'completed') {
        snap = await parseStatus(taskId, true)
      }
      events.push(...snap.events.slice(-20))
      if (snap.status !== 'completed' || !snap.blocks) {
        throw new Error(`Docling 批解析失败（pages ${pageFrom}-${pageTo}）：${snap.error ?? '未知原因'}`)
      }
      allBlocks.push(...toParsedBlocks(snap.blocks))
      pageCount = snap.pageCount ?? pageCount
      // 第一批结果确定总页数；本批已到尾页 → 全书完成
      if (pageCount === null || pageTo >= pageCount) break
      pageFrom = pageTo + 1
      pageTo = Math.min(pageFrom + BATCH_PAGES - 1, pageCount)
    }
    if (allBlocks.every((b) => (b.text ?? '').trim() === '')) {
      throw new Error('解析结果文本为空（疑似扫描版无文本层，暂不支持 OCR，请更换数字版文件）')
    }
    return {
      blocks: allBlocks,
      meta: {
        parser: 'docling-async',
        pageCount,
        blockCount: allBlocks.length,
        figureCount: allBlocks.filter((b) => b.kind === 'figure').length,
        headingCount: allBlocks.filter((b) => b.kind === 'heading').length,
        attemptId,
        events: events.slice(-100),
      },
    }
  }
  const format = nativeFormatOf(doc.fileName)
  if (!format) throw new Error(`不支持的文件格式：${doc.fileName}（支持 pdf/docx/txt/md/html）`)
  const { blocks, title } = parseNative(format, buf.toString('utf8'))
  if (blocks.length === 0) throw new Error('解析结果为空（文件损坏或内容为空）')
  return {
    blocks,
    meta: { parser: `native-${format}`, blockCount: blocks.length, title, attemptId, events: [] },
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
    // W1-B attemptId：每次处理生成新轮次；旧轮次的迟到结果（轮询校验）被拒绝落库
    const attemptId = randomUUID()
    await setDocStatus(docId, 'parsing', { parseMeta: { ...doc.parseMeta, attemptId, events: [] } })
    doc = (await getDocument(docId))!
    const startedAt = Date.now()

    const parsed = await parseStep(doc, attemptId)
    // 迟到防护：解析期间轮次被替换（手动重解析/删除重传）→ 丢弃本结果
    if ((await getDocument(docId))?.parseMeta.attemptId !== attemptId) {
      throw new Error('解析轮次已失效（新轮次已接管），结果丢弃')
    }

    // W1-B 清洗（§4.5）+ 质量门（§4.7 empty_text 硬门）
    let cleaned = cleanBlocks(parsed.blocks)
    let gate = qualityGate(cleaned.blocks, parsed.blocks)

    // R2 双引擎质量 fallback：Docling 结果差（blocked 或 headingPath 全空 + 警告≥2）
    // → 自动用 MinerU 重解析（用户无感知，多路径兜底的核心逻辑）
    const needsFallback =
      gate.blocked ||
      (gate.warnings.filter((w) => w.includes('no_headings')).length > 0 && gate.warnings.length >= 2)
    if (needsFallback && (parsed.meta.parser as string)?.includes('docling')) {
      const engines = await engineAvailability()
      if (engines.mineru) {
        log.info('knowledge', 'Docling 质量差，自动 fallback 到 MinerU', kv({
          id: docId.slice(0, 8),
          blocked: gate.blocked,
          warnings: gate.warnings.length,
        }))
        try {
          const store = getBlobStore()
          const buf2 = doc.blobKey ? await store.get(doc.blobKey) : null
          if (buf2) {
            const { parseMineru } = await import('../researchpy.js')
            const retryRes = await parseMineru({
              docId: doc.id,
              fileName: doc.fileName,
              contentBase64: buf2.toString('base64'),
            })
            if (retryRes.status === 'ok' && retryRes.blocks.length > 0) {
              const retryBlocks = toParsedBlocks(retryRes.blocks)
              const retryCleaned = cleanBlocks(retryBlocks)
              const retryGate = qualityGate(retryCleaned.blocks, retryBlocks)
              if (!retryGate.blocked) {
                log.ok('knowledge', 'MinerU fallback 成功，替代 Docling 结果', kv({
                  id: docId.slice(0, 8),
                  blocks: retryRes.blocks.length,
                  headings: retryRes.blocks.filter((b) => b.kind === 'heading').length,
                }))
                cleaned = retryCleaned
                gate = retryGate
                parsed.blocks = retryBlocks
                parsed.meta = {
                  ...parsed.meta,
                  parser: 'mineru-fallback',
                  blockCount: retryRes.blocks.length,
                  headingCount: retryRes.blocks.filter((b) => b.kind === 'heading').length,
                }
              }
            }
          }
        } catch (fbErr) {
          log.warn('knowledge', 'MinerU fallback 失败（保持 Docling 结果）', kv({ 原因: (fbErr as Error).message }))
        }
      }
    }

    if (gate.blocked) throw new Error(gate.blockReason ?? '质量门拦截')
    await setDocStatus(docId, 'parsed', {
      parseMeta: {
        ...doc.parseMeta,
        ...parsed.meta,
        cleanStats: cleaned.stats,
        qualityWarnings: gate.warnings,
      },
    })

    const chunks = chunkBlocks(cleaned.blocks)
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
