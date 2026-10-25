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
import { consumeLoginAttempt, recordLoginFailure, clearLoginFailuresOnSuccess } from './loginGuard.js'
import { clientIp } from './security/trust.js'
import { csrfKeysAvailable, csrfSeedCookie, csrfSeedSubjectOf, issueCsrfToken, sessionSubjectHash, verifyCsrfToken } from './security/csrf.js'
import { registerSourceGuard } from './security/sourceGuard.js'
import { RATE_POLICIES, rateLimitConsume, rateLimitedError } from './security/rateLimit.js'
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
 * 匿名可访问的精确路由集合（P0-2b 白名单收敛）：/api/auth/* 前缀不再整段放行，
 * 新增匿名端点必须在此显式列名（两入口共用；/api/auth/me 的鉴权在路由自身）。
 */
export const AUTH_ANON_ALLOW = new Set(['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/csrf'])

/**
 * 客户端 IP（P0-2 起统一走信任链解析）：不再手工读 XFF/X-Real-IP——由 Fastify 按
 * BV_TRUSTED_PROXIES（security/trust.ts）解析 req.ip；不可信来源的伪造头一律无效。
 * 两进程必须同口径——限速按 IP 计数在共享 PG 行上，口径漂移=计数分裂（实测踩坑）。
 * 保留导出名兼容两入口的既有引用（const clientIp = clientIpOf）。
 */
export const clientIpOf = clientIp

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

  // P0-2b 写操作来源守卫：跨源 Origin 硬拒绝 + 携带 token 必验（verify 兼容阶段）
  registerSourceGuard(app, {
    verify: (req, token) => {
      const raw = readSessionToken(req.headers.cookie)
      if (raw !== undefined && findSession(raw, sessionPurpose) !== null) {
        return verifyCsrfToken(token, sessionSubjectHash(raw), sessionPurpose)
      }
      const seed = csrfSeedSubjectOf(req.headers.cookie)
      return seed !== null && verifyCsrfToken(token, seed, sessionPurpose)
    },
  })

  /**
   * GET /api/auth/csrf（P0-2b）：签发会话/种子绑定的 HMAC token；no-store。
   * 已登录绑定会话（换会话失效）；未登录发放随机种子 Cookie 并绑定其哈希
   * （种子仅用于 CSRF，不授予权限）。生产缺 BV_CSRF_KEY → 503（相关服务就绪拒绝）。
   */
  app.get('/api/auth/csrf', async (req, reply) => {
    reply.header('cache-control', 'no-store')
    if (!csrfKeysAvailable()) {
      throw Object.assign(new Error('安全状态暂不可用，请稍后重试'), { statusCode: 503, code: 'security_state_unavailable' })
    }
    // P1-2 强制入口配额（30/分/IP，enforce）：防止无限签发
    const csrfPolicy = RATE_POLICIES['csrf.issue:ip']
    if (csrfPolicy !== undefined) {
      const verdict = await rateLimitConsume(csrfPolicy, ctx.clientIp(req))
      if (!verdict.allowed) throw rateLimitedError(verdict.retryAfterSeconds)
    }
    const raw = readSessionToken(req.headers.cookie)
    let subjectHash: string | null = null
    if (raw !== undefined && findSession(raw, sessionPurpose) !== null) {
      subjectHash = sessionSubjectHash(raw)
    } else {
      const seed = csrfSeedSubjectOf(req.headers.cookie)
      if (seed !== null) subjectHash = seed
      else {
        const seeded = csrfSeedCookie()
        subjectHash = seeded.seedHash
        reply.header('set-cookie', seeded.setCookie)
      }
    }
    const issued = issueCsrfToken(subjectHash, sessionPurpose)
    if (issued === null) {
      throw Object.assign(new Error('安全状态暂不可用，请稍后重试'), { statusCode: 503, code: 'security_state_unavailable' })
    }
    return { token: issued.token, expiresAt: new Date(issued.expiresAt).toISOString() }
  })

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
    // 限速（PG 持久化，跨域名合并计数，重启不丢）——P1-3/L 原子准入：
    // 锁定检查 + 窗口重置 + 计数递增单条 SQL 完成（双进程并发/窗口边界不丢不重；
    // 写失败 → 503 安全状态不可用，不执行密码计算）
    const admission = await consumeLoginAttempt(ip, LOGIN_MAX_PER_WINDOW)
    const now = Date.now()
    if (admission.locked) {
      log.warn('auth', '登录被锁定拦截', kv({ 用户: name.slice(0, 64) || '(未提供)', ip, 剩余秒: Math.ceil((admission.lockedUntilMs - now) / 1000) }))
      throw Object.assign(new Error('尝试过于频繁，账号已临时锁定，请稍后再试'), { statusCode: 429 })
    }
    if (!admission.allowed) {
      log.warn('auth', '登录限速拦截', kv({ 用户: name.slice(0, 64) || '(未提供)', ip, 本分钟次数: admission.windowCount }))
      throw Object.assign(new Error('尝试过于频繁，请一分钟后再试'), { statusCode: 429 })
    }
    // P1-3 主批多维准入：IP 总桶之后，
    // a) IP＋规范账号 5 次/分钟（enforce）——撞库单账号在单 IP 上也快速受限；
    //    账号存在与否同样计数（对外同构 401/429，不暴露账号存在性）
    // b) 账号跨 IP 异常 20 次/5 分钟（shadow）——只告警不建账号硬锁（方案 §4.2）
    const acctVerdict = await rateLimitConsume(RATE_POLICIES['login.acct:ip+acct'], `${ip}|${name.toLowerCase().slice(0, 64)}`)
    if (!acctVerdict.allowed) throw rateLimitedError(acctVerdict.retryAfterSeconds)
    void rateLimitConsume(RATE_POLICIES['login.acct:global'], name.toLowerCase().slice(0, 64)).catch(() => {})
    /**
     * 统一失败出口：计数/锁定/审计/401 一处收口——入口不匹配与密码错误对外完全同构。
     * P1-3/L：失败计数为原子 SQL（行锁串行累加，并发不丢）；写失败 → 503 拒绝
     * （不吞错后继续执行密码计算）。
     */
    async function failLogin(logMsg: string, detail: Record<string, unknown>): Promise<never> {
      await recordLoginFailure(ip, LOGIN_LOCK_FAILS)
      recordFailedLogin({ username: name.slice(0, 64), ip, userAgent: ua })
      log.warn('auth', logMsg, kv({ ...detail, 尝试序号: admission.attemptSeq }))
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

    const user = await verifyLogin(name, String(body.password ?? ''))
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
    // 成功登录：条件清理该 IP 的失败计数（按本次尝试序号——并发后发生的失败不清除；
    // 窗口尝试计数保留，IP 总尝试桶不因成功而重置）
    await clearLoginFailuresOnSuccess(ip, admission.attemptSeq)
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
