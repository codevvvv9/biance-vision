/**
 * 质量门（W1-B，rag-pipeline-design §4.7）：对清洗切分前的产物计算指标。
 * 不达标的写 warnings（UI 黄条）；唯一硬门=empty_text（阻塞，文档 failed）。
 */
import type { ParsedBlock } from './chunk.js'

export interface QualityGateResult {
  /** true = 阻塞（文档置 failed） */
  blocked: boolean
  blockReason?: string
  warnings: string[]
}

export function qualityGate(cleaned: ParsedBlock[], original: ParsedBlock[]): QualityGateResult {
  const warnings: string[] = []
  const textBlocks = cleaned.filter((b) => b.kind === 'text' || b.kind === 'heading')

  // 硬门：全空文本（含 figure-only 文档——图无 caption 不构成可检索内容）
  const withText = cleaned.filter((b) => (b.text ?? '').trim() !== '')
  if (withText.length === 0) {
    return {
      blocked: true,
      blockReason: 'empty_text：解析结果无有效文本（疑似扫描版无文本层，暂不支持 OCR，请更换数字版文件）',
      warnings,
    }
  }

  const avgLen = textBlocks.reduce((s, b) => s + (b.text ?? '').length, 0) / Math.max(1, textBlocks.length)
  if (avgLen < 80) warnings.push(`suspicious_avg_len：平均块长 ${avgLen.toFixed(0)} 字符（<80，疑似解析质量差）`)

  const nonPrintable = textBlocks.reduce((s, b) => {
    const t = b.text ?? ''
    const bad = t.replace(/[\x20-\x7E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF\n\r\t]/g, '')
    return s + bad.length
  }, 0)
  const totalChars = Math.max(1, textBlocks.reduce((s, b) => s + (b.text ?? '').length, 0))
  if (nonPrintable / totalChars > 0.05) {
    warnings.push(`encoding_suspect：不可打印字符占比 ${((nonPrintable / totalChars) * 100).toFixed(1)}%（>5%，疑似编码问题）`)
  }

  const figures = cleaned.filter((b) => b.kind === 'figure')
  const noCaption = figures.filter((b) => (b.text ?? '').trim() === '').length
  if (figures.length > 0 && noCaption / figures.length > 0.6) {
    warnings.push(`figures_no_caption：${noCaption}/${figures.length} 图示块无说明文字`)
  }

  const headings = original.filter((b) => b.kind === 'heading')
  if (headings.length === 0) {
    warnings.push('no_headings：文档无章节结构（或解析未识别标题层级）')
  }

  return { blocked: false, warnings }
}
