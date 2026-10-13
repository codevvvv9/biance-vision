/**
 * 知识切分：把解析后的 block 序列切成可检索的 chunk。
 * 对应 docs/specs/knowledge-rag.md：保留页码/图号/原文/资料版本；图示与文字相邻关联；
 * 结构感知切分（标题路径、句界切分、重叠下文）。
 */

import { createHash } from 'node:crypto'

/** 解析层（Docling/原生）输出的统一 block 形态 */
export interface ParsedBlock {
  kind: 'text' | 'figure' | 'table' | 'heading'
  text?: string
  /** heading 级别（1-6），仅 kind=heading 时有值 */
  level?: number
  pageNo?: number
  figureId?: string
}

export interface KnowledgeChunk {
  chunkIndex: number
  kind: 'text' | 'figure' | 'table'
  text: string
  pageNo: number | null
  figureId: string | null
  /** 所属标题路径（如 ["第三章","双顶"]） */
  headingPath: string[]
  /** 内容指纹（去重/变更检测） */
  contentHash: string
}

export interface ChunkOptions {
  /** 单 chunk 目标最大字符数 */
  maxChars?: number
  /** 相邻 chunk 重叠的尾句字符数 */
  overlapChars?: number
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32)
}

/** 句界切分：中英文句号/分号/换行优先，超长时硬切 */
function splitSentences(text: string, maxChars: number): string[] {
  const parts = text.split(/(?<=[。！？；.!?;])\s*|\n+/)
  const out: string[] = []
  let cur = ''
  for (const p of parts) {
    if (p === '') continue
    if (cur.length + p.length <= maxChars) {
      cur += p
      continue
    }
    if (cur !== '') out.push(cur)
    if (p.length <= maxChars) {
      cur = p
      continue
    }
    // 单句超长：硬切
    for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars))
    cur = ''
  }
  if (cur !== '') out.push(cur)
  return out
}

/**
 * 切分 blocks 为 chunks：
 * - heading 维护标题路径（不入正文 chunk）；
 * - figure/table 独立成 chunk（text 为图注/表注，关联最近页码与标题路径）；
 * - 连续 text 合并到 maxChars，按句界切分，尾部重叠 overlapChars 带入下一 chunk；
 * - 每个 chunk 记录首个 block 的 pageNo。
 */
export function chunkBlocks(blocks: ParsedBlock[], options: ChunkOptions = {}): KnowledgeChunk[] {
  const maxChars = options.maxChars ?? 1200
  const overlapChars = options.overlapChars ?? 150
  const chunks: KnowledgeChunk[] = []
  const headingStack: string[] = []
  let buffer = ''
  let bufferPage: number | null = null

  const headingPath = (): string[] => [...headingStack]
  const pushText = (text: string): void => {
    if (text.trim() === '') return
    chunks.push({
      chunkIndex: chunks.length,
      kind: 'text',
      text: text.trim(),
      pageNo: bufferPage,
      figureId: null,
      headingPath: headingPath(),
      contentHash: hash(text),
    })
  }
  const flush = (): void => {
    if (buffer === '') return
    const pieces = splitSentences(buffer, maxChars)
    for (let i = 0; i < pieces.length; i++) {
      pushText(pieces[i])
    }
    buffer = ''
  }

  for (const b of blocks) {
    if (b.kind === 'heading' && b.text) {
      flush()
      const level = Math.max(1, Math.min(6, b.level ?? 1))
      headingStack.length = level - 1
      headingStack[level - 1] = b.text.trim()
      headingStack.length = level
      continue
    }
    if (b.kind === 'figure' || b.kind === 'table') {
      flush()
      const caption = (b.text ?? '').trim()
      chunks.push({
        chunkIndex: chunks.length,
        kind: b.kind,
        text: caption,
        pageNo: b.pageNo ?? null,
        figureId: b.figureId ?? null,
        headingPath: headingPath(),
        contentHash: hash(`${b.kind}:${b.figureId ?? ''}:${caption}`),
      })
      continue
    }
    if (!b.text || b.text.trim() === '') continue
    if (buffer === '') bufferPage = b.pageNo ?? null
    buffer += (buffer === '' ? '' : '\n') + b.text
    if (buffer.length >= maxChars) {
      const pieces = splitSentences(buffer, maxChars)
      // 最后一段可能很短，留在 buffer 与下一段合并；其余产出
      const tail = pieces.pop() ?? ''
      for (const p of pieces) pushText(p)
      // 重叠：把上一个 chunk 的尾部带入下一段开头
      const overlap = pieces.length > 0 ? pieces[pieces.length - 1].slice(-overlapChars) : ''
      buffer = overlap !== '' && tail !== '' ? `${overlap}\n${tail}` : tail !== '' ? tail : overlap
      if (buffer !== '') bufferPage = b.pageNo ?? bufferPage
    }
  }
  flush()
  return chunks
}
