/**
 * 主体哈希单点（P1-2）：限流/登录状态/租约桶键中的主体（IP/用户名）经
 * HMAC-SHA256 后存储——IP/用户名不落诊断存储（方案 §9.1）；HMAC 轮换保留
 * key 版本（BV_SUBJECT_HMAC_KEY_PREVIOUS）避免不同进程/时期口径不一致。
 * 生产缺 key → 相关安全状态不可用（503）；开发用固定派生 key（告警一次）。
 */
import crypto from 'node:crypto'
import { log } from '../logger.js'

let warned = false

function currentKey(): Buffer | null {
  const raw = process.env.BV_SUBJECT_HMAC_KEY
  if (raw !== undefined && raw.trim() !== '') {
    const buf = Buffer.from(raw.trim(), 'hex')
    if (buf.length >= 32) return buf
  }
  if (process.env.NODE_ENV === 'production') return null
  if (!warned) {
    warned = true
    log.warn('security', '未配置 BV_SUBJECT_HMAC_KEY：开发环境使用固定派生 key（生产必须配置 32B hex，否则限流状态不可用）')
  }
  return crypto.createHash('sha256').update('bv-dev-subject-key').digest()
}

export function subjectHashOf(subject: string): string {
  const key = currentKey()
  if (key === null) {
    throw Object.assign(new Error('安全状态暂不可用，请稍后重试'), { statusCode: 503, code: 'security_state_unavailable' })
  }
  return crypto.createHmac('sha256', key).update(subject).digest('hex')
}
