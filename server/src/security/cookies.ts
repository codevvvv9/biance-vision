/**
 * 会话 Cookie 单点定义（Q-1）：登录与清除共用同一属性函数，环境感知 Secure。
 * - 生产（NODE_ENV=production，镜像内恒定）：追加 Secure——Cookie 仅经 HTTPS 传输；
 * - 本地开发（HTTP）：无 Secure，否则浏览器直接丢弃 Cookie 无法登录；
 * - BV_COOKIE_SECURE=1/0 显式覆盖（脚本/特殊部署用），不信任 X-Forwarded-Proto
 *   等客户端可伪造的请求头推断。
 * HttpOnly / SameSite=Lax / Path=/ 原样保留，登录与清除属性保持一致（旧 Cookie 可正常清除）。
 */

export const SESSION_COOKIE = 'bv_session'
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000

/** 每次调用即时读 env（轻量）：测试与脚本可在进程内切换模式断言两种属性 */
export function cookieSecure(): boolean {
  const explicit = process.env.BV_COOKIE_SECURE
  if (explicit === '1') return true
  if (explicit === '0') return false
  return process.env.NODE_ENV === 'production'
}

function cookieAttrs(): string {
  return `Path=/; HttpOnly; SameSite=Lax${cookieSecure() ? '; Secure' : ''}`
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttrs()}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttrs()}; Max-Age=0`
}
