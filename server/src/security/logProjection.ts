/**
 * 日志安全投影单点（P0-3）：任何进日志/诊断管道的值先经此脱敏+有界化。
 * 提炼自 index.ts 原 bodyForLog（局部实现）——「logger 没有全局脱敏」的缺口从
 * 这里开始收口：投影规则只定义一次，HTTP 访问日志、错误日志、后续诊断管道共用。
 *
 * 规则（方案 §9.1）：
 * - 敏感键（password/apiKey/secret/token/authorization 等）整值打码 ***；
 *   webhookUrl 只保留主机名；
 * - 字符串截断（默认 160 字）、数组截断（10 项）、深度有界（3 层）；
 * - 允许列表之外不保证完整保真——投影后的字段结构与数值类型保留。
 */

/** 敏感字段（键名匹配即整值打码） */
const SENSITIVE_KEY_RE = /password|passphrase|apikey|api_key|secret|token|authorization/i

const MAX_STRING = 160
const MAX_DEPTH = 3
const MAX_ARRAY = 10

/** 只保留 Webhook 的主机名（避免完整地址含密钥进日志） */
export function webhookHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '无效地址'
  }
}

/** 单值投影：字符串截断 / 数组有界 / 对象按键递归（敏感键打码） */
export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…(共${value.length}字)` : value
  }
  if (Array.isArray(value)) {
    return depth < MAX_DEPTH ? value.slice(0, MAX_ARRAY).map((v) => sanitizeForLog(v, depth + 1)) : '[…]'
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^webhookurl$/i.test(k) && typeof v === 'string' && v) {
        out[k] = `${webhookHost(v)}/***`
      } else if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = v === undefined || v === '' ? v : '***'
      } else {
        out[k] = sanitizeForLog(v, depth + 1)
      }
    }
    return out
  }
  return value
}

/** 任意值 → 有界安全文本（logger 的 parts 序列化入口）：Error 保 message/stack 截断 */
export function toBoundedText(value: unknown, opts: { maxText?: number; maxStack?: number } = {}): string {
  const maxText = opts.maxText ?? 2048
  const maxStack = opts.maxStack ?? 8192
  if (value instanceof Error) {
    const stack = value.stack === undefined ? '' : `\n${value.stack.slice(0, maxStack)}${value.stack.length > maxStack ? '…' : ''}`
    return `${value.message.slice(0, maxText)}${stack}`
  }
  if (typeof value === 'string') return value.length > maxText ? `${value.slice(0, maxText)}…` : value
  if (typeof value === 'object' && value !== null) {
    try {
      const text = JSON.stringify(sanitizeForLog(value))
      return text === undefined ? String(value) : text.length > 16_384 ? `${text.slice(0, 16_384)}…` : text
    } catch {
      return String(value)
    }
  }
  return String(value)
}
