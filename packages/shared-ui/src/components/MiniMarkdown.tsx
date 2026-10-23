/**
 * MiniMarkdown：全站统一富文本渲染组件（知识证据/预览/聊天助手消息）。
 * 渲染管线对齐 lumen rag/web 的 ChunkMarkdown（react-markdown + remark-gfm +
 * remark-breaks + remark-math/rehype-katex），预处理按需移植并叠加本项目语料形态。
 *
 * 安全边界：内容来自文档解析与 LLM 输出，属不可信输入——
 * - 不启用 rehype-raw，内嵌 HTML 一律转义不执行；
 * - 链接强制新窗口 + noreferrer；katex 输出为纯排版标记（trust 默认关闭）。
 *
 * 预处理（纯函数，见下）：
 * - 本项目书摘形态：整表压成单行（|| 分隔行）展开为标准表格；单行围栏代码块
 *   （```code```）与围栏开行带内容（CommonMark 会当 info string 丢弃）拆为多行；
 * - lumen 移植：LLM 数学定界符 \(...\)/\[...\] 归一为 $...$/$$...$$（normalizeMathDelimiters）、
 *   文档解析产出的畸形加粗定界符修复（normalizeChunkEmphasis）、段落紧贴列表/标题补空行
 *   （normalizeMarkdownBlocks）。
 */
import { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

// ---- 预处理（移植自 lumen rag/web/src/markdown.ts，策略一致） ----

/**
 * LLM 常用 \(...\) / \[...\] 定界符归一为 remark-math 认识的 $...$ / $$...$$；
 * 单行 $$...$$ 再拆为 fence 形式（$$/体/$$ 各一行）——remark-math v6 的块级公式
 * 只认 fence 形式，单行闭合会被解析成行内 math（失去 display 排版）。围栏代码块内不动。
 */
function normalizeMathDelimiters(text: string): string {
  const prelim = text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$${body}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body}$`)
  const out: string[] = []
  let inFence = false
  for (const line of prelim.split('\n')) {
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (!inFence) {
      const m = /^[ \t]*\$\$(.+)\$\$[ \t]*$/.exec(line)
      if (m !== null && m[1].trim() !== '') {
        out.push('$$', m[1], '$$')
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/
const HEADING_RE = /^#{1,6}\s/
const FENCE_RE = /^(```|~~~)/

/**
 * 段落与列表/标题之间无空行时 CommonMark 会当作段落延续（配合 remark-breaks 表现为
 * 带 <br> 的纯文本行）：在块起始行前补空行使其可靠成块；`$$` 块级公式行前后同样补空行
 * （紧贴段落时 remark-math 会降级为行内解析，失去 display 排版）。代码围栏内的行原样保留。
 */
function normalizeMarkdownBlocks(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (!inFence) {
      const prev = out.length > 0 ? out[out.length - 1] : ''
      if (prev !== '') {
        const isListItem = LIST_ITEM_RE.test(line)
        const isHeading = HEADING_RE.test(line)
        const prevIsListItem = LIST_ITEM_RE.test(prev)
        const isIndented = /^\s+\S/.test(line)
        const isMathBlock = line.trimStart().startsWith('$$')
        const prevIsMathBlock = prev.trimStart().startsWith('$$')
        if (isHeading || isMathBlock) {
          out.push('')
        } else if (isListItem && !prevIsListItem) {
          out.push('')
        } else if ((!isListItem && prevIsListItem && !isIndented && line.trim() !== '') || (prevIsMathBlock && !isMathBlock)) {
          out.push('')
        }
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

/** ≥2 个连续 `*` 视为一个加粗定界符 run（长度 3+ 是解析噪声，一律按 `**` 处理）。 */
const BOLD_DELIM_RE = /\*{2,}/g

/**
 * 修复文档解析/LLM 输出的畸形加粗定界符（`**标签： **` 闭合前带空格、`****` 熔连、
 * 多段错乱配对级联吞字）。逐行按 run 配对重建：3 个视为熔连删中间；奇数(≥5)丢末尾落单；
 * 区间内侧空白与残余定界符清除；末尾标点移出闭合处（CommonMark 右侧定界符规则）。
 * 代码围栏内的行不动。
 */
function normalizeChunkEmphasis(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (FENCE_RE.test(line.trim())) {
      inFence = !inFence
      out.push(line)
      continue
    }
    out.push(inFence ? line : repairLineEmphasis(line))
  }
  return out.join('\n')
}

/** 单行加粗定界符修复（纯文本重建，配对策略见 normalizeChunkEmphasis）。 */
function repairLineEmphasis(line: string): string {
  const runs = [...line.matchAll(BOLD_DELIM_RE)]
  if (runs.length < 2) {
    return runs.length === 1 && runs[0]![0].length >= 3 ? line.replace(runs[0]![0], '') : line
  }
  const dropped = new Set<number>()
  if (runs.length === 3) dropped.add(1)
  else if (runs.length % 2 === 1) dropped.add(runs.length - 1)
  const kept = runs.map((_run, i) => i).filter((i) => !dropped.has(i))

  let result = ''
  let cursor = 0
  for (let p = 0; p + 1 < kept.length; p += 2) {
    const open = runs[kept[p]!]!
    const close = runs[kept[p + 1]!]!
    const inner = line
      .slice(open.index! + open[0].length, close.index!)
      .replace(BOLD_DELIM_RE, '')
      .trim()
    if (inner === '') {
      cursor = close.index! + close[0].length
      continue
    }
    let body = inner
    let suffix = ''
    const afterClose = line[close.index! + close[0].length] ?? ''
    if (afterClose !== '' && /[^\s\p{P}]/u.test(afterClose)) {
      const trailing = inner.match(/\p{P}+$/u)
      if (trailing !== null && trailing[0].length < inner.length) {
        body = inner.slice(0, -trailing[0].length)
        suffix = trailing[0]
      }
    }
    result += `${line.slice(cursor, open.index!)}**${body}**${suffix}`
    cursor = close.index! + close[0].length
  }
  let tail = line.slice(cursor)
  for (const i of dropped) {
    const run = runs[i]!
    if (run.index! >= cursor) tail = tail.replace(run[0], '')
  }
  return result + tail
}

// ---- 本项目书摘形态标准化 ----

/**
 * 单行围栏代码块拆为多行：
 * - "```code```tail"（整块压缩成一行）→ "```\ncode\n```" + tail 行；
 * - "```code"（围栏开行带内容）→ 内容移入代码体——CommonMark 会把 fence 同行内容
 *   当 info string 丢弃，书摘里该内容是代码本体。
 */
function normalizeSingleLineFences(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('```')) {
      out.push(line)
      continue
    }
    const rest = line.slice(3)
    if (rest === '') {
      out.push(line)
      continue
    }
    const close = rest.indexOf('```')
    if (close >= 0) {
      out.push('```', rest.slice(0, close), '```')
      const tail = rest.slice(close + 3)
      if (tail.trim() !== '') out.push(tail)
    } else {
      out.push('```', rest)
    }
  }
  return out.join('\n')
}

/** 按竖线切段，跳过反引号行内代码里的竖线（如 `|c-o|`）；sep 为 '|' 或 '||'。 */
function splitPipes(raw: string, sep: string): string[] {
  const parts: string[] = []
  let cur = ''
  let inCode = false
  for (let j = 0; j < raw.length; j++) {
    const ch = raw[j]
    if (ch === '`') inCode = !inCode
    if (!inCode && ch === '|' && (sep === '|' || (raw[j + 1] === '|' && (j += 1)))) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  parts.push(cur)
  return parts.map((p) => p.trim())
}

/**
 * 整表压成单行的压缩表格（本仓书摘形态：行内 `||` 分隔表格行）展开为标准多行表格。
 * 仅在段中确实存在分隔行（---/:--: 形态）时才视为压缩表，避免误伤标准表格中
 * `| a || b |` 的空单元格语义。
 */
function normalizeSingleLineTables(text: string): string {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('|')) {
      const parts = splitPipes(t, '||')
      const isCompressed =
        parts.length > 1 && parts.some((p) => p !== '' && /^[-:\s|]+$/.test(p.replace(/^\|/, '').replace(/\|$/, '')))
      if (isCompressed) {
        for (const seg of parts) {
          if (seg === '' || seg === '|') continue
          let row = seg.startsWith('|') ? seg : `|${seg}`
          if (!row.endsWith('|')) row += '|'
          out.push(row)
        }
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

/** 预处理管线：围栏拆行 → 压缩表展开 → 块分隔 → 加粗修复 → 数学定界符归一。 */
function preprocess(text: string): string {
  return normalizeMathDelimiters(
    normalizeChunkEmphasis(normalizeMarkdownBlocks(normalizeSingleLineTables(normalizeSingleLineFences(text)))),
  )
}

/** 全站统一富文本渲染：对外 API 仅 text/className，调用方无需感知管线升级。 */
const MiniMarkdown = memo(function MiniMarkdown({ text, className = '' }: { text: string; className?: string }): JSX.Element {
  const processed = useMemo(() => preprocess(text), [text])
  return (
    <div className={`md-view ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          table: ({ children }) => <div className="md-table-wrap"><table>{children}</table></div>,
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
})

export default MiniMarkdown
