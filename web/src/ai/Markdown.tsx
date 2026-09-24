/**
 * 聊天富文本渲染管线（移植自 lumen RAG 评测的 RichTextMarkdown 方案）：
 * react-markdown + remark-gfm（表格/任务列表/删除线）+ remark-breaks（软换行）
 * + remark-math/rehype-katex（公式）。
 *
 * 安全边界：AI 输出属不可信输入——不启用 rehype-raw，HTML 一律转义不执行；
 * 链接走 react-markdown 默认协议白名单，新窗口打开；图片不自动加载，降级为链接。
 */

import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/
const HEADING_RE = /^#{1,6}\s/
const FENCE_RE = /^(```|~~~)/

/**
 * LLM 输出习惯把列表/标题紧跟段落（无空行），CommonMark 会当作段落延续而不成块。
 * 在块起始行前补空行使其可靠成块；代码围栏内原样保留。
 */
export function normalizeMarkdownBlocks(text: string): string {
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
        if (isHeading) {
          out.push('')
        } else if (isListItem && !prevIsListItem) {
          out.push('')
        } else if (!isListItem && prevIsListItem && !isIndented && line.trim() !== '') {
          out.push('')
        }
      }
    }
    out.push(line)
  }
  return out.join('\n')
}

/** LLM 常用 \(...\) / \[...\] 定界符归一为 remark-math 认识的 $...$ / $$...$$。 */
function normalizeMathDelimiters(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$${body}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body}$`)
}

const Markdown = memo(function Markdown({ content }: { content: string }): JSX.Element {
  return (
    <div className="rich-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) => {
            const url = typeof src === 'string' ? src : ''
            return (
              <a href={url} target="_blank" rel="noopener noreferrer">
                [图片：{alt || url}]
              </a>
            )
          },
        }}
      >
        {normalizeMathDelimiters(normalizeMarkdownBlocks(content))}
      </ReactMarkdown>
    </div>
  )
})

export default Markdown
