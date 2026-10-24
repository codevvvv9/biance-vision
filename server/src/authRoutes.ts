/**
 * 共享认证路由（W3-S3 提取自 index.ts）：登录/登出/会话查询 + 鉴权依赖，
 * 由 user-api（index.ts）与 admin-api（adminApi.ts）分别注册。
 *
 * 入口语义进程级定死（S3 起「入口=进程」，ADMIN_HOSTS 域名判定退役）：
 * - user-api 恒用户入口：superadmin 账号登录被拒（管理密码的验证入口不暴露给用户端爆破）；
 * - admin-api 恒管理入口：普通账号登录被拒；
 * 与 W3-S2 会话用途标记配套：user 会话在 admin-api 无效、admin 会话在 user-api 无效
 * （findSession 按 entryKind 校验 purpose）。
 *
 * 行为与 v0.15.2 的 index.ts 登录块一致：fail-closed / PG 限速（❗计数保存 await，
 * 并发 upsert 与 delete 竞态会丢锁定）/ 验证前预检（scrypt 之前拒错误入口）/
 * 入口纵深二次校验 / 统一失败出口同构 401。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { LOGIN_LOCK_FAILS, LOGIN_MAX_PER_WINDOW } from './env.js'
import { LOGIN_LOCK_MS, LOGIN_WINDOW_MS, clearLoginGuard, loginGuardOf, saveLoginGuard } from './loginGuard.js'
import { isDbAvailable } from './db.js'
import { log, kv, briefUa } from './logger.js'
import { endSessionAudit, recordFailedLogin, startSessionAudit } from './audit.js'
import {
  clearSessionCookie,
  createSession,
  destroySession,
  findSession,
  findLiveSession,
  initUsers,
  readSessionToken,
  roleOfUsername,
  sessionCookie,
  toPublic,
  verifyLogin,
} from './users.js'
import type { SessionPurpose, SessionRecord, UserRecord } from './users.js'

export interface AuthRouteContext {
  /** 进程级入口角色：user-api 传 'user'，admin-api 传 'admin' */
  entryKind: 'user' | 'admin'
  clientIp: (req: FastifyRequest) => string
}

export function unauthorized(): Error {
  return Object.assign(new Error('未登录或会话已过期'), { statusCode: 401 })
}

/**
 * 客户端 IP（W3-S3 共享）：XFF 末段（可被伪造的首段忽略）→ x-real-ip → 连接地址。
 * 两进程必须同口径——限速按 IP 计数在共享 PG 行上，口径漂移=计数分裂（实测踩坑）。
 */
export function clientIpOf(req: FastifyRequest): string {
  const last = (v: string | string[] | undefined): string => {
    const raw = Array.isArray(v) ? v.join(',') : v
    const parts = (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    return parts.length > 0 ? parts[parts.length - 1] : ''
  }
  const xf = last(req.headers['x-forwarded-for'])
  if (xf) return xf.slice(0, 64)
  const real = last(req.headers['x-real-ip'])
  if (real) return real.slice(0, 64)
  return String(req.ip ?? '')
}

/** 浏览器 / 客户端标识（截断，用于会话审计） */
function userAgent(req: FastifyRequest): string {
  return String(req.headers['user-agent'] ?? '').slice(0, 160)
}

export interface AuthRoutes {
  /** 当前进程的会话用途（user-api='user' / admin-api='admin'） */
  sessionPurpose: SessionPurpose
  requireSession(req: FastifyRequest): SessionRecord
  requireLiveSession(req: FastifyRequest): Promise<SessionRecord>
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AuthRouteContext): AuthRoutes {
  const adminEntry = ctx.entryKind === 'admin'
  const sessionPurpose: SessionPurpose = ctx.entryKind
  const entryLabel = adminEntry ? '管理端进程' : '用户端进程'

  function requireSession(req: FastifyRequest): SessionRecord {
    const session = findSession(readSessionToken(req.headers.cookie), sessionPurpose)
    if (!session) throw unauthorized()
    return session
  }

  async function requireLiveSession(req: FastifyRequest): Promise<SessionRecord> {
    const session = await findLiveSession(readSessionToken(req.headers.cookie), sessionPurpose)
    if (!session) throw unauthorized()
    return session
  }

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown }
    const name = String(body.username ?? '').trim()
    const ip = ctx.clientIp(req)
    const ua = userAgent(req)
    // 认证 fail-closed（W3-S2）：PG 不可用时拒绝登录（不降级 JSON 判权；限速计数也在 PG）
    if (!isDbAvailable()) {
      log.warn('auth', '认证存储不可用，登录被拒（fail-closed）', kv({ ip, 入口: entryLabel }))
      throw Object.assign(new Error('认证服务暂不可用，请稍后重试'), { statusCode: 503 })
    }
    // 限速（PG 持久化，跨域名合并计数，重启不丢）：锁定期内直接拒绝；滑动窗口每分钟最多 N 次尝试
    const guard = await loginGuardOf(ip)
    const now = Date.now()
    if (guard.lockedUntil > now) {
      log.warn('auth', '登录被锁定拦截', kv({ 用户: name.slice(0, 64) || '(未提供)', ip, 剩余秒: Math.ceil((guard.lockedUntil - now) / 1000) }))
      throw Object.assign(new Error('尝试过于频繁，账号已临时锁定，请稍后再试'), { statusCode: 429 })
    }
    if (now - guard.winStart >= LOGIN_WINDOW_MS) {
      guard.winStart = now
      guard.winCount = 0
    }
    guard.winCount++
    await saveLoginGuard(ip, guard)
    if (guard.winCount > LOGIN_MAX_PER_WINDOW) {
      log.warn('auth', '登录限速拦截', kv({ 用户: name.slice(0, 64) || '(未提供)', ip, 本分钟次数: guard.winCount }))
      throw Object.assign(new Error('尝试过于频繁，请一分钟后再试'), { statusCode: 429 })
    }
    /**
     * 统一失败出口：计数/锁定/审计/401 一处收口——入口不匹配与密码错误对外完全同构。
     * ❗计数保存必须 await：锁定状态在响应前落库（否则与成功登录的 delete 并行提交丢锁定）。
     */
    async function failLogin(logMsg: string, detail: Record<string, unknown>): Promise<never> {
      guard.fails++
      if (guard.fails >= LOGIN_LOCK_FAILS) {
        guard.lockedUntil = Date.now() + LOGIN_LOCK_MS
        guard.fails = 0
        log.warn('auth', '连续登录失败触发锁定', kv({ 用户: name.slice(0, 64) || '(未提供)', ip, 锁定分钟: LOGIN_LOCK_MS / 60_000 }))
      }
      await saveLoginGuard(ip, guard)
      recordFailedLogin({ username: name.slice(0, 64), ip, userAgent: ua })
      log.warn('auth', logMsg, kv({ ...detail, 累计失败: guard.fails }))
      throw Object.assign(new Error('用户名或密码错误'), { statusCode: 401 })
    }

    // 验证前预检（进程级入口，2026-10-21 三轮审查 P1 语义延续）：错误入口的账号在
    // 密码验证之前拒绝——server 端不执行 scrypt（消除用户端对管理员密码的爆破确认通道）。
    // 拒绝与密码错误完全同构；未知用户名放行至 verifyLogin 正常 401（不暴露账号存在性）。
    // Newly provisioned admin-api accounts must work immediately in user-api.
    // Refresh only after rate limiting, before role and password checks.
    await initUsers({ seed: false })
    const preRole = roleOfUsername(name)
    if (preRole !== null && (preRole === 'superadmin') !== adminEntry) {
      await failLogin('登录入口与账号角色不匹配被拒（验证前预检，密码校验未执行）', {
        用户: name.slice(0, 64),
        角色: preRole === 'superadmin' ? '超管' : '用户',
        入口: entryLabel,
        ip,
      })
    }

    const user = verifyLogin(name, String(body.password ?? ''))
    // 入口纵深二次校验：预检放行但 verifyLogin 结果角色不匹配时仍拒绝（防
    // roleOfUsername 与 verifyLogin 的用户名匹配语义漂移），同样走同构 failLogin
    if (user && (user.role === 'superadmin') !== adminEntry) {
      await failLogin('登录入口与账号角色不匹配被拒（对客户端与密码错误同构）', {
        用户: user.username,
        角色: user.role === 'superadmin' ? '超管' : '用户',
        入口: entryLabel,
        ip,
      })
    }
    // failLogin 恒抛出；`?? await` 兼作类型收窄（Promise<never> 不参与控制流分析）
    const verified: UserRecord = user ?? (await failLogin('登录失败', { 用户: name.slice(0, 64) || '(未提供)', ip, 客户端: briefUa(ua) }))
    // 成功登录清零该 IP 的失败计数（PG 行 + 缓存）
    await clearLoginGuard(ip)
    // 会话用途标记 = 进程入口（W3-S2/S3）：跨用途使用一律无效
    const session = await createSession(verified, sessionPurpose)
    startSessionAudit(session, { ip, userAgent: ua })
    log.ok('auth', '登录成功', kv({
      用户: verified.username,
      角色: verified.role === 'superadmin' ? '超管' : '用户',
      入口: entryLabel,
      ip,
      客户端: briefUa(ua),
    }))
    reply.header('set-cookie', sessionCookie(session.token))
    return { user: toPublic(verified) }
  })

  app.post('/api/auth/logout', async (req, reply) => {
    const token = readSessionToken(req.headers.cookie)
    const session = findSession(token, sessionPurpose)
    if (session) {
      endSessionAudit(session)
      log.info('auth', '已登出', kv({ 用户: session.username }))
    }
    await destroySession(token)
    reply.header('set-cookie', clearSessionCookie())
    return { ok: true }
  })

  app.get('/api/auth/me', async (req) => {
    const session = await requireLiveSession(req)
    return { user: { username: session.username, role: session.role } }
  })

  return { sessionPurpose, requireSession, requireLiveSession }
}
