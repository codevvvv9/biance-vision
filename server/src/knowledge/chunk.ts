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
 * 表格二切（W1-B 缺口 B）：markdown 表 >maxRows 数据行时按行组二切，
 * 每块重挂表头行（脱离表头的表格块不可读）；返回 [子表文本, 行范围] 或 null（无需切）。
 */
function splitTable(md: string, maxRows = 20): { text: string; rows: [number, number] }[] | null {
  const lines = md.split('\n').filter((l) => l.trim() !== '')
  if (lines.length < 3) return null
  // markdown 表结构：表头行 + 分隔行 + 数据行
  const sepIdx = lines.findIndex((l) => /^\|?[\s:-]+\|/.test(l) && l.includes('-'))
  if (sepIdx !== 1) return null
  const header = lines[0]
  const dataRows = lines.slice(2)
  if (dataRows.length <= maxRows) return null
  const out: { text: string; rows: [number, number] }[] = []
  for (let i = 0; i < dataRows.length; i += maxRows) {
    const slice = dataRows.slice(i, i + maxRows)
    out.push({
      text: [header, lines[1], ...slice].join('\n'),
      rows: [i + 1, i + slice.length],
    })
  }
  return out
}

/**
 * 切分 blocks 为 chunks：
 * - heading 维护标题路径（不入正文 chunk）；
 * - figure 独立成 chunk；table markdown >20 行二切+表头重挂（W1-B 缺口 B）；
 * - 连续 text 合并到 maxChars（CJK×1/ASCII×0.5 加权——纯中文块上限即 maxChars 汉字，
 *   纯 ASCII 约 2×maxChars），按句界切分，尾部重叠 overlapChars 带入下一 chunk；
 * - 每个 chunk 记录首个 block 的 pageNo。
 */
export function chunkBlocks(blocks: ParsedBlock[], options: ChunkOptions = {}): KnowledgeChunk[] {
  const maxChars = options.maxChars ?? 1200
  const overlapChars = options.overlapChars ?? 150
  const chunks: KnowledgeChunk[] = []
  const headingStack: string[] = []
  let buffer = ''
  let bufferPage: number | null = null

  /** 加权长度（W1-B §5.1）：CJK 记 1，其余记 0.5 */
  const weightedLen = (s: string): number => {
    let w = 0
    for (const ch of s) w += /[\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch) ? 1 : 0.5
    return w
  }

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
      if (b.kind === 'table') {
        // W1-B 缺口 B：超长表格二切+表头重挂（脱离表头的表块不可读）
        const split = splitTable(caption)
        if (split !== null) {
          for (const part of split) {
            chunks.push({
              chunkIndex: chunks.length,
              kind: 'table',
              text: part.text,
              pageNo: b.pageNo ?? null,
              figureId: null,
              headingPath: headingPath(),
              contentHash: hash(`table:${part.rows[0]}-${part.rows[1]}:${part.text.slice(0, 80)}`),
            })
          }
          continue
        }
      }
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
    if (weightedLen(buffer) >= maxChars) {
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
