/**
 * CSRF 令牌单点（P0-2b）：服务端 HMAC 签名、主体绑定的双用途 token。
 *
 * 机制（方案 §3.2）：
 * - 签名内容含版本、用途（purpose=user/admin）、主体、过期时间、随机量；密钥
 *   仅服务端持有（BV_CSRF_KEY，32B hex），不下发浏览器；支持 BV_CSRF_KEY_PREVIOUS
 *   短期重叠轮换（旧 key 只验不签）。
 * - 主体绑定：已登录 = 会话 token 的 SHA-256（换会话即失效）；登录前 = 随机种子
 *   Cookie（bv_csrf_seed，HttpOnly/SameSite=Lax，10 分钟）的哈希。种子仅用于
 *   CSRF 绑定，不授予任何权限。
 * - 有效期 30 分钟（且不超过会话有效期由绑定语义天然保证——会话换 token 即失效）。
 * - GET /api/auth/csrf 签发；SDK 存内存并带 X-CSRF-Token，不写 URL。
 *
 * 分阶段（先服务端支持，再 SDK 强制）：本阶段 verify 模式——携带 token 的写请求
 * 必须验证通过，未携带则放行（兼容旧客户端/脚本）；Origin 跨源校验始终生效。
 * 强制阶段（enforce）在观察窗口后另行切换，不在本模块内判断。
 *
 * 密钥缺失语义：开发（非 production）用固定派生 key 并告警（可端到端联调）；
 * 生产缺 key → 签发/验证均不可用（调用方按安全状态不可用拒绝，503），拒绝启动
 * 整个进程过于激进——端点级就绪拒绝已满足「拒绝相关服务就绪」。
 */
import crypto from 'node:crypto'
import { log } from '../logger.js'
import { cookieSecure } from './cookies.js'
import type { SessionPurpose } from '../users.js'

const CSRF_TOKEN_TTL_MS = 30 * 60 * 1000
const CSRF_SEED_COOKIE = 'bv_csrf_seed'
const CSRF_SEED_TTL_MS = 10 * 60 * 1000

/** 密钥对：current 签发+验证；previous 仅验证（轮换窗口） */
interface CsrfKeys {
  current: Buffer
  previous: Buffer | null
}

let devKeyWarned = false

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function loadKeys(): CsrfKeys | null {
  const parse = (raw: string | undefined): Buffer | null => {
    if (raw === undefined || raw.trim() === '') return null
    const buf = Buffer.from(raw.trim(), 'hex')
    return buf.length >= 32 ? buf : null
  }
  const cur = parse(process.env.BV_CSRF_KEY)
  if (cur !== null) return { current: cur, previous: parse(process.env.BV_CSRF_KEY_PREVIOUS) }
  if (process.env.NODE_ENV === 'production') return null // 生产缺 key：不可用（调用方拒绝）
  if (!devKeyWarned) {
    devKeyWarned = true
    log.warn('csrf', '未配置 BV_CSRF_KEY：开发环境使用固定派生 key（生产必须配置 32B hex，否则 csrf 端点拒绝服务）')
  }
  return { current: crypto.createHash('sha256').update('bv-dev-csrf-key').digest(), previous: null }
}

/** keys 可用性（生产缺 key = false；authRoutes 据此 503）。每次即时读 env：
 *  轮换（current→previous）在进程重启后生效，无需长驻缓存 */
export function csrfKeysAvailable(): boolean {
  return loadKeys() !== null
}

interface CsrfPayload {
  v: 1
  purpose: SessionPurpose
  sub: string // 主体（会话 tokenHash 或种子哈希，hex）
  exp: number
  n: string // 随机量
}

const b64u = (buf: Buffer): string => buf.toString('base64url')
const unB64u = (s: string): Buffer => Buffer.from(s, 'base64url')

function sign(payloadJson: string, key: Buffer): string {
  return b64u(crypto.createHmac('sha256', key).update(payloadJson).digest())
}

/** 签发：绑定主体（会话 tokenHash 或种子哈希）与用途；返回 token 与过期时刻 */
export function issueCsrfToken(subjectHash: string, purpose: SessionPurpose): { token: string; expiresAt: number } | null {
  const keys = loadKeys()
  if (keys === null) return null
  const expiresAt = Date.now() + CSRF_TOKEN_TTL_MS
  const payload: CsrfPayload = { v: 1, purpose, sub: subjectHash, exp: expiresAt, n: crypto.randomBytes(8).toString('hex') }
  const json = JSON.stringify(payload)
  return { token: `${b64u(Buffer.from(json))}.${sign(json, keys.current)}`, expiresAt }
}

/** 验证：签名（当前或轮换 key，对 payload 原文）+ 版本/用途/主体/过期全匹配才通过 */
export function verifyCsrfToken(token: string | undefined, subjectHash: string, purpose: SessionPurpose): boolean {
  if (token === undefined || token === '') return false
  const keys = loadKeys()
  if (keys === null) return false
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return false
  const raw = unB64u(token.slice(0, dot)).toString('utf8') // 签发时的 payload 原文（签名输入）
  let payload: CsrfPayload
  try {
    payload = JSON.parse(raw) as CsrfPayload
  } catch {
    return false
  }
  const sig = token.slice(dot + 1)
  const sigOk = sign(raw, keys.current) === sig || (keys.previous !== null && sign(raw, keys.previous) === sig)
  if (!sigOk) return false
  return payload.v === 1 && payload.purpose === purpose && payload.sub === subjectHash && payload.exp > Date.now()
}

/** 生成登录前种子 Cookie（值 + Set-Cookie 串）；种子哈希用于 token 主体绑定 */
export function csrfSeedCookie(): { seedHash: string; setCookie: string } {
  const seed = crypto.randomBytes(16).toString('hex')
  return {
    seedHash: sha256Hex(seed),
    setCookie: `${CSRF_SEED_COOKIE}=${seed}; Path=/; HttpOnly; SameSite=Lax${cookieSecure() ? '; Secure' : ''}; Max-Age=${Math.floor(CSRF_SEED_TTL_MS / 1000)}`,
  }
}

/** 读取种子 Cookie → 主体哈希（登录前请求的验证主体） */
export function csrfSeedSubjectOf(cookieHeader: string | undefined): string | null {
  if (cookieHeader === undefined) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === CSRF_SEED_COOKIE) {
      const v = part.slice(eq + 1).trim()
      return v === '' ? null : sha256Hex(v)
    }
  }
  return null
}

/** 会话主体哈希（token 绑定主体；换会话即失效） */
export function sessionSubjectHash(sessionToken: string): string {
  return sha256Hex(sessionToken)
}

export { CSRF_TOKEN_TTL_MS, CSRF_SEED_COOKIE }
