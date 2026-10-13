/**
 * 原生解析：TXT/Markdown/HTML 在 Node 侧直接转 blocks，不入 Docling 通道
 * （docs/specs/knowledge-rag.md「TXT/MD/HTML 走 Node 原生解析」）。
 * PDF/DOCX 由 pipeline 调 research-py 的 /tasks/parse-document。
 * 输出统一 ParsedBlock（kind/level/pageNo/figureId），供 chunk.ts 切分。
 */
import { createHash } from 'node:crypto'
import type { ParsedBlock } from './chunk.js'

export type NativeFormat = 'txt' | 'md' | 'html'

export interface NativeParseResult {
  blocks: ParsedBlock[]
  title: string | null
}

/** 按扩展名判断原生可解析格式；pdf/docx 返回 null（走 Docling） */
export function nativeFormatOf(fileName: string, contentType?: string): NativeFormat | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? ''
  if (ext === 'txt' || ext === 'md' || ext === 'markdown') return ext === 'txt' ? 'txt' : 'md'
  if (ext === 'html' || ext === 'htm' || (contentType ?? '').includes('text/html')) return 'html'
  if ((contentType ?? '').startsWith('text/plain')) return 'txt'
  if ((contentType ?? '').includes('markdown')) return 'md'
  return null
}

/** TXT：空行分段 */
function parseTxt(text: string): ParsedBlock[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => ({ kind: 'text' as const, text: p.replace(/\s*\n\s*/g, ' ') }))
}

/** Markdown：#/##… 识别标题层级，围栏代码块整体为 text block */
function parseMarkdown(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  const lines = text.split('\n')
  let buffer: string[] = []
  let inFence = false
  const flush = (): void => {
    const joined = buffer.join('\n').trim()
    if (joined !== '') blocks.push({ kind: 'text', text: joined })
    buffer = []
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      buffer.push(line)
      continue
    }
    if (!inFence) {
      const m = line.match(/^(#{1,6})\s+(.*)$/)
      if (m) {
        flush()
        blocks.push({ kind: 'heading', level: m[1].length, text: m[2].trim() })
        continue
      }
    }
    buffer.push(line)
  }
  flush()
  return blocks
}

/** HTML：h1-h6 → heading；script/style/noscript 剥离；img → figure（alt 为图注） */
function parseHtml(html: string): { blocks: ParsedBlock[]; title: string | null } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null
  const body = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  const blocks: ParsedBlock[] = []
  // 块级标签序列化：标题与图片单独成块，其余块级标签聚合为文本
  const tokenRe = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>|<img\b[^>]*>/gi
  let cursor = 0
  let match: RegExpExecArray | null
  const pushText = (raw: string): void => {
    const t = raw
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
    if (t !== '') blocks.push({ kind: 'text', text: t })
  }
  while ((match = tokenRe.exec(body)) !== null) {
    pushText(body.slice(cursor, match.index))
    if (match[1] !== undefined) {
      const level = Number(match[1][1])
      const text = match[2]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text !== '') blocks.push({ kind: 'heading', level, text })
    } else {
      const img = match[0]
      const alt = (img.match(/\balt=["']([^"']*)["']/i)?.[1] ?? '').trim()
      const src = img.match(/\bsrc=["']([^"']+)["']/i)?.[1] ?? ''
      blocks.push({ kind: 'figure', text: alt, figureId: src ? createHash('sha1').update(src).digest('hex').slice(0, 12) : undefined })
    }
    cursor = match.index + match[0].length
  }
  pushText(body.slice(cursor))
  return { blocks, title }
}

export function parseNative(format: NativeFormat, text: string): NativeParseResult {
  if (format === 'html') {
    const { blocks, title } = parseHtml(text)
    return { blocks, title }
  }
  if (format === 'md') {
    const firstHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim()
    return { blocks: parseMarkdown(text), title: firstHeading ?? null }
  }
  return { blocks: parseTxt(text), title: null }
}
