/**
 * 安全专项门禁（pnpm security:gate-check；--static 只跑无副作用断言）
 * ——《反爬、安全防护与可观测性实施方案》§15.1 的专项脚本，逐批增量添断言：
 *   当前覆盖：Q 快赢四项（Cookie 环境感知 / WS maxPayload / CORS 白名单 / health 收敛）；
 *   P0 起接入 release:gate，并按批次扩展来源/错误契约/限流/幂等等运行断言。
 * 全部断言不触业务库（Q 项无需 DB）；静态接线检查钉住「单点定义被真实接线」，
 * 防止只在模块里定义、入口未使用（假共享教训）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cookieSecure, clearSessionCookie, sessionCookie } from '../server/src/security/cookies.js'
import { allowedOrigins, corsOptions } from '../server/src/security/cors.js'
import { WS_MAX_PAYLOAD_BYTES } from '../server/src/security/limits.js'
import { clientIp, normalizeIp, trustProxyOption, trustedProxies } from '../server/src/security/trust.js'
import { buildApp } from '../server/src/fastifyApp.js'
import { csrfSeedCookie, csrfSeedSubjectOf, issueCsrfToken, sessionSubjectHash, verifyCsrfToken } from '../server/src/security/csrf.js'
import { registerSourceGuard } from '../server/src/security/sourceGuard.js'

let failed = 0
let checked = 0
function check(name: string, actual: unknown, expected: unknown = true): void {
  checked++
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `（期望 ${String(expected)}，实际 ${String(actual)}）`}`)
}

const staticOnly = process.argv.includes('--static')

// ---- Q-1 Cookie 环境感知（纯函数，双模式 + 显式覆盖 + 登录/清除一致）----
function q1Cookies(): void {
  const prevNodeEnv = process.env.NODE_ENV
  const prevBv = process.env.BV_COOKIE_SECURE
  try {
    delete process.env.NODE_ENV
    delete process.env.BV_COOKIE_SECURE
    const dev = sessionCookie('t')
    check('Q1a 开发（无 NODE_ENV）：HttpOnly + SameSite=Lax 保留、无 Secure',
      dev.includes('HttpOnly') && dev.includes('SameSite=Lax') && !dev.includes('Secure'), true)
    check('Q1b 开发：清除 Cookie 属性与登录一致（无 Secure，旧 Cookie 可清除）',
      clearSessionCookie().includes('HttpOnly') && clearSessionCookie().includes('SameSite=Lax') && !clearSessionCookie().includes('Secure'), true)
    process.env.NODE_ENV = 'production'
    check('Q1c 生产（NODE_ENV=production）：登录 Cookie 带 Secure', sessionCookie('t').includes('Secure'), true)
    check('Q1d 生产：清除 Cookie 同样带 Secure（属性一致）', clearSessionCookie().includes('Secure'), true)
    process.env.BV_COOKIE_SECURE = '0'
    check('Q1e BV_COOKIE_SECURE=0 显式覆盖生产 → 关闭 Secure', cookieSecure(), false)
    delete process.env.NODE_ENV
    process.env.BV_COOKIE_SECURE = '1'
    check('Q1f BV_COOKIE_SECURE=1 显式开启 Secure', cookieSecure(), true)
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNodeEnv
    if (prevBv === undefined) delete process.env.BV_COOKIE_SECURE
    else process.env.BV_COOKIE_SECURE = prevBv
  }
}

// ---- Q-3 CORS 白名单（纯函数：默认不反射 + 显式列举精确匹配）----
async function q3Cors(): Promise<void> {
  const prev = process.env.BV_ALLOWED_ORIGINS
  try {
    delete process.env.BV_ALLOWED_ORIGINS
    const ask = async (origin: string): Promise<boolean | Error> => {
      const opts = corsOptions()
      if (typeof opts.origin !== 'function') return new Error('origin 非函数')
      return new Promise((resolve) => {
        void (opts.origin as (o: string, cb: (e: Error | null, allow?: boolean) => void) => void)(
          origin,
          (err, allow) => resolve(err ?? allow ?? false),
        )
      })
    }
    check('Q3a 默认（未配置白名单）：任意来源不反射', await ask('https://evil.example'), false)
    process.env.BV_ALLOWED_ORIGINS = 'https://app.example.dev:5173, https://admin.example.dev'
    check('Q3b 白名单解析（去空格）', allowedOrigins().join('|'), 'https://app.example.dev:5173|https://admin.example.dev')
    check('Q3c 白名单内来源放行', await ask('https://app.example.dev:5173'), true)
    check('Q3d 白名单外来源拒绝（含端口不一致）', await ask('https://app.example.dev'), false)
    check('Q3e null/伪造来源不放行', await ask('null'), false)
  } finally {
    if (prev === undefined) delete process.env.BV_ALLOWED_ORIGINS
    else process.env.BV_ALLOWED_ORIGINS = prev
  }
}

// ---- Q-2 WS maxPayload（进程内真实 ws 握手：正常帧通、超大帧 1009 关闭）----
interface MinimalSocket {
  on(event: 'message', listener: (data: unknown) => void): void
  send(data: string): void
}
interface MinimalApp {
  register(plugin: unknown, opts?: unknown): Promise<void>
  get(path: string, opts: unknown, handler: (conn: { socket: MinimalSocket }) => void): void
  listen(opts: { port: number; host: string }): Promise<void>
  close(): Promise<void>
  server: { address: () => { port: number } }
}
interface MinimalWs {
  send(data: string): void
  close(): void
  on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: never[]) => void): void
}
const nodeRequire = createRequire(new URL('../server/package.json', import.meta.url))

async function q2Websocket(): Promise<void> {
  const Fastify = nodeRequire('fastify') as () => MinimalApp
  const fastifyWs = nodeRequire('@fastify/websocket')
  const WS = nodeRequire('ws') as new (url: string) => MinimalWs

  const app = Fastify()
  // 与 index.ts 生产注册完全同形：单点常量 + options.maxPayload
  await app.register(fastifyWs, { options: { maxPayload: WS_MAX_PAYLOAD_BYTES } })
  app.get('/ws', { websocket: true }, (conn) => {
    conn.socket.on('message', (raw) => conn.socket.send(String(raw)))
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const port = app.server.address().port

  try {
    const ws = new WS(`ws://127.0.0.1:${port}/ws`)
    const echoed = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 3000)
      ws.on('open', () => ws.send('{"type":"subscribe"}'))
      ws.on('message', (...args: unknown[]) => {
        clearTimeout(t)
        resolve(String(args[0]) === '{"type":"subscribe"}')
      })
      ws.on('error', () => { clearTimeout(t); resolve(false) })
      ws.on('close', () => { clearTimeout(t); resolve(false) })
    })
    check('Q2a 正常小帧（订阅消息大小级）正常收发', echoed, true)
    ws.close()

    const big = new WS(`ws://127.0.0.1:${port}/ws`)
    const closedWith = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 3000)
      big.on('open', () => big.send('x'.repeat(WS_MAX_PAYLOAD_BYTES + 1)))
      big.on('close', (...args: unknown[]) => {
        clearTimeout(t)
        resolve(typeof args[0] === 'number' ? (args[0] as number) : -1)
      })
      big.on('error', () => { /* 服务端关闭可能先触发 error */ })
    })
    check('Q2b 超过 16 KiB 的帧被拒绝（close 1009 message too big）', closedWith, 1009)
    big.close()
  } finally {
    await app.close()
  }
}

// ---- P0-2 可信代理与统一 IP（单元 + 进程内 inject 行为）----
interface IpApp {
  get(path: string, handler: (req: { ip: string }) => unknown): void
  inject(req: { method: string; url: string; headers?: Record<string, string>; remoteAddress?: string }): Promise<{ statusCode: number; body: string }>
  close(): Promise<void>
}

function trustUnit(): void {
  const prev = process.env.BV_TRUSTED_PROXIES
  try {
    delete process.env.BV_TRUSTED_PROXIES
    check('T0a 未配置 → 不信任任何代理（trustProxy=false）', trustProxyOption(), false)
    process.env.BV_TRUSTED_PROXIES = '172.16.0.0/12, 127.0.0.1'
    check('T0b 配置解析（列表 + 去空格）', trustedProxies().join('|'), '172.16.0.0/12|127.0.0.1')
  } finally {
    if (prev === undefined) delete process.env.BV_TRUSTED_PROXIES
    else process.env.BV_TRUSTED_PROXIES = prev
  }
  check('T0c IPv4-mapped IPv6 规范化', normalizeIp('::ffff:198.51.100.9'), '198.51.100.9')
}

async function trustBehavior(): Promise<void> {
  const mkFastify = nodeRequire('fastify') as (opts: { logger: boolean; trustProxy: boolean | string[] }) => IpApp
  const untrusted = mkFastify({ logger: false, trustProxy: false })
  untrusted.get('/ip', (req) => req.ip)
  const r1 = await untrusted.inject({
    method: 'GET', url: '/ip', remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': '1.2.3.4,9.9.9.9', 'x-real-ip': '8.8.8.8' },
  })
  check('T1 不可信代理：伪造 XFF/X-Real-IP 无效（req.ip=socket 对端）', r1.body, '127.0.0.1')
  await untrusted.close()

  const trusted = mkFastify({ logger: false, trustProxy: ['127.0.0.1'] })
  trusted.get('/ip', (req) => clientIp(req as never))
  const r2 = await trusted.inject({ method: 'GET', url: '/ip', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.7' } })
  check('T2 可信回环代理：XFF 真实客户端生效（统一 clientIp）', r2.body, '203.0.113.7')
  const r3 = await trusted.inject({ method: 'GET', url: '/ip', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '::ffff:198.51.100.9' } })
  check('T3 统一 clientIp 做 IPv4-mapped 规范化（计数不分裂）', r3.body, '198.51.100.9')
  await trusted.close()
}

// ---- P0-2b CSRF 令牌（单元：往返/主体/用途/篡改/轮换）----
function csrfUnit(): void {
  const prevKey = process.env.BV_CSRF_KEY
  const prevPrev = process.env.BV_CSRF_KEY_PREVIOUS
  const prevNode = process.env.NODE_ENV
  const KEY_A = 'a'.repeat(64)
  const KEY_B = 'b'.repeat(64)
  try {
    delete process.env.NODE_ENV
    delete process.env.BV_CSRF_KEY_PREVIOUS
    process.env.BV_CSRF_KEY = KEY_A
    const t = issueCsrfToken('sub-1', 'user')
    if (t === null) throw new Error('签发失败')
    check('C1 签发+验证往返（当前 key）', verifyCsrfToken(t.token, 'sub-1', 'user'), true)
    check('C2 主体不符拒绝（换会话失效语义）', verifyCsrfToken(t.token, 'sub-2', 'user'), false)
    check('C3 用途不符拒绝（user/admin 隔离）', verifyCsrfToken(t.token, 'sub-1', 'admin'), false)
    check('C4 篡改签名拒绝', verifyCsrfToken(`${t.token.slice(0, -4)}AAAA`, 'sub-1', 'user'), false)
    process.env.BV_CSRF_KEY = KEY_B
    check('C5 轮换后无 previous → 旧 key token 拒绝', verifyCsrfToken(t.token, 'sub-1', 'user'), false)
    process.env.BV_CSRF_KEY_PREVIOUS = KEY_A
    check('C6 previous 窗口内旧 key token 仍验证', verifyCsrfToken(t.token, 'sub-1', 'user'), true)
    const seed = csrfSeedCookie()
    check('C7 种子 Cookie HttpOnly+SameSite=Lax', seed.setCookie.includes('HttpOnly') && seed.setCookie.includes('SameSite=Lax'), true)
    check('C8 种子哈希与 Cookie 值对应（csrfSeedSubjectOf 反解一致）', csrfSeedSubjectOf(seed.setCookie.split(';')[0]), seed.seedHash)
    check('C9 会话主体哈希稳定', sessionSubjectHash('abc') === sessionSubjectHash('abc') && sessionSubjectHash('abc') !== sessionSubjectHash('abd'), true)
  } finally {
    if (prevKey === undefined) delete process.env.BV_CSRF_KEY
    else process.env.BV_CSRF_KEY = prevKey
    if (prevPrev === undefined) delete process.env.BV_CSRF_KEY_PREVIOUS
    else process.env.BV_CSRF_KEY_PREVIOUS = prevPrev
    if (prevNode === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNode
  }
}

// ---- P0-2b 来源守卫（inject 行为：Origin 硬校验 + token verify 模式）----
async function sourceGuardBehavior(): Promise<void> {
  process.env.BV_CSRF_KEY = 'c'.repeat(64)
  try {
    const app = buildApp({ cors: true })
    registerSourceGuard(app, { verify: (_req, token) => verifyCsrfToken(token, 'seed-sub', 'user') })
    app.post('/api/echo', async () => ({ ok: true }))
    app.get('/api/echo', async () => ({ ok: true }))
    const host = 'api.local'
    const post = async (headers: Record<string, string>): Promise<number> =>
      (await app.inject({ method: 'POST', url: '/api/echo', headers: { host, ...headers } })).statusCode
    check('G1 跨源 Origin 写请求 → 403', await post({ origin: 'https://evil.example' }), 403)
    check('G2 null Origin 写请求 → 403', await post({ origin: 'null' }), 403)
    check('G3 同源 Origin 无 token → 放行（verify 兼容阶段）', await post({ origin: `http://${host}` }), 200)
    check('G4 同源携带无效 token → 403', await post({ origin: `http://${host}`, 'x-csrf-token': 'garbage' }), 403)
    const issued = issueCsrfToken('seed-sub', 'user')
    check('G5 同源携带有效 token → 放行', issued !== null && await post({ origin: `http://${host}`, 'x-csrf-token': issued.token }), 200)
    check('G6 无 Origin（curl/脚本）→ 放行', await post({}), 200)
    check('G7 GET 不受守卫拦截（含跨源）', (await app.inject({ method: 'GET', url: '/api/echo', headers: { host, origin: 'https://evil.example' } })).statusCode, 200)
    await app.close()
  } finally {
    delete process.env.BV_CSRF_KEY
  }
}

// ---- P0-3 JSON 日志 / 安全投影 / requestId / 错误契约 ----
import * as loggerModule from '../server/src/logger.js'
import { sanitizeForLog as sanitizeForLogObj, toBoundedText } from '../server/src/security/logProjection.js'

function loggerJsonMode(): void {
  const prevJson = process.env.BV_LOG_JSON
  const prevNode = process.env.NODE_ENV
  const lines: unknown[] = []
  const origLog = console.log
  const origWarn = console.warn
  console.log = (...args: unknown[]): void => { lines.push(args[0]) }
  console.warn = (...args: unknown[]): void => { lines.push(args[0]) }
  try {
    process.env.BV_LOG_JSON = '1'
    delete process.env.NODE_ENV
    loggerModule.record({ level: 'warn', tag: 'gate', message: 'hello', attributes: { password: 'super-secret', note: 'ok' } })
    const parsed = JSON.parse(String(lines[lines.length - 1])) as { level: string; tag: string; message: string; attributes?: string }
    check('L1 生产 JSON 模式：单行 JSON 含 level/tag/message',
      parsed.level === 'warn' && parsed.tag === 'gate' && parsed.message === 'hello', true)
    check('L2 JSON 模式属性经安全投影（password 不落原文）',
      (parsed.attributes ?? '').includes('***') && !(parsed.attributes ?? '').includes('super-secret'), true)
  } finally {
    console.log = origLog
    console.warn = origWarn
    if (prevJson === undefined) delete process.env.BV_LOG_JSON
    else process.env.BV_LOG_JSON = prevJson
    if (prevNode === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = prevNode
  }
}

function projectionUnit(): void {
  const projected = sanitizeForLogObj({ password: 'p@ss', apiKey: 'k', note: 'hello', nested: { authToken: 't', ok: 1 } }) as Record<string, unknown>
  const nested = projected.nested as Record<string, unknown>
  check('L3 共享投影：敏感键打码（password/apiKey/token），非敏感保留',
    projected.password === '***' && projected.apiKey === '***' && nested.authToken === '***' && projected.note === 'hello' && nested.ok === 1, true)
  const truncated = sanitizeForLogObj({ text: 'x'.repeat(300) }) as { text: string }
  check('L4 长字符串截断（160 字，标注原始长度）', truncated.text.length < 200 && truncated.text.includes('共300字'), true)
  const bounded = toBoundedText({ secret: 'top', a: 1 })
  check('L5 toBoundedText：对象投影敏感键', bounded.includes('***') && !bounded.includes('top') && bounded.includes('"a":1'), true)
  check('L6 toBoundedText：字符串上限截断', toBoundedText('y'.repeat(5000), { maxText: 100 }).length <= 101, true)
}

async function requestIdBehavior(): Promise<void> {
  const app = buildApp({ cors: true })
  app.get('/api/ok', async () => ({ ok: true }))
  app.get('/api/boom', async () => {
    throw Object.assign(new Error('业务错误'), { statusCode: 400, code: 'validation_failed' })
  })
  app.get('/api/wait', async () => {
    throw Object.assign(new Error('稍后再试'), { statusCode: 429, code: 'rate_limited', retryAfterSeconds: 7 })
  })
  app.get('/api/crash', async () => {
    throw Object.assign(new Error('PG SQLSTATE 42P01 内部细节'), { statusCode: 500, code: '42P01' })
  })
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const r1 = await app.inject({ method: 'GET', url: '/api/ok' })
  const id1 = r1.headers['x-request-id']
  const r2 = await app.inject({ method: 'GET', url: '/api/ok' })
  check('R1 每响应返还 x-request-id（UUID）', typeof id1 === 'string' && UUID_RE.test(id1), true)
  check('R2 请求间 ID 唯一（双进程关联基础）', id1 !== r2.headers['x-request-id'], true)
  const forged = await app.inject({ method: 'GET', url: '/api/ok', headers: { 'x-request-id': 'fake-client-id' } })
  check('R3 伪造 x-request-id 请求头无效（服务端 UUID）', forged.headers['x-request-id'] !== 'fake-client-id' && UUID_RE.test(String(forged.headers['x-request-id'])), true)
  const boom = await app.inject({ method: 'GET', url: '/api/boom' })
  const boomBody = JSON.parse(boom.body) as { code?: string; requestId?: string }
  check('R4 错误体含 requestId 且与响应头一致', boomBody.requestId === boom.headers['x-request-id'], true)
  check('R5 错误体透传 4xx code', boomBody.code, 'validation_failed')
  const wait = await app.inject({ method: 'GET', url: '/api/wait' })
  check('R6 retryAfterSeconds 透传（429）', (JSON.parse(wait.body) as { retryAfterSeconds?: number }).retryAfterSeconds, 7)
  const crash = await app.inject({ method: 'GET', url: '/api/crash' })
  const crashBody = JSON.parse(crash.body) as { code?: string; message?: string }
  check('R7 5xx 不透 code 不回显内部 message', crashBody.code === undefined && crashBody.message === 'Internal Server Error', true)
  await app.close()
}

// ---- P1-1 SSE 紧急硬限（单元：4/用户、20/IP、100/进程 + 释放幂等）----
import { acquireSse, releaseSse, sseCounts, SSE_LIMITS } from '../server/src/security/sseGuards.js'

function sseGuardUnit(): void {
  const t1 = acquireSse('sg-user', '10.1.1.1')
  const t2 = acquireSse('sg-user', '10.1.1.2')
  const t3 = acquireSse('sg-user', '10.1.1.3')
  const t4 = acquireSse('sg-user', '10.1.1.4')
  check('SG1 同用户第 5 条 SSE 被拒（4/用户）', acquireSse('sg-user', '10.1.1.5').ok, false)
  const stray: NonNullable<ReturnType<typeof acquireSse>['ticket']>[] = []
  const other = acquireSse('sg-user-b', '10.1.1.6')
  check('SG2 其他用户不受影响（IP 未超）', other.ok, true)
  if (other.ticket) stray.push(other.ticket)
  releaseSse(t4.ticket!) // 释放 1 条后可再连
  const regained = acquireSse('sg-user', '10.1.1.7')
  check('SG3 释放后额度恢复（可重连语义）', regained.ok, true)
  if (regained.ticket) stray.push(regained.ticket)
  releaseSse(t4.ticket!) // 幂等：重复释放不再减
  const c1 = sseCounts().total
  releaseSse(t1.ticket!)
  releaseSse(t2.ticket!)
  releaseSse(t3.ticket!)
  check('SG4 释放幂等（重复 release 不产生负计数/多扣）', sseCounts().total === c1 - 3, true)
  // IP 上限：从干净状态用同 IP 多用户打满
  const tickets: Array<ReturnType<typeof acquireSse>> = []
  for (let i = 0; i < SSE_LIMITS.MAX_PER_IP; i++) tickets.push(acquireSse(`sg-ip-u${i}`, '10.9.9.9'))
  check('SG5 同 IP 第 21 条被拒（20/IP）', acquireSse('sg-ip-fresh', '10.9.9.9').ok, false)
  check('SG6 拒绝时给出范围与 Retry-After', (() => { const r = acquireSse('sg-ip-fresh2', '10.9.9.9'); return r.ok === false && r.scope === 'ip' && (r.retryAfterSeconds ?? 0) > 0 })(), true)
  for (const t of tickets) if (t.ticket) releaseSse(t.ticket)
  for (const t of stray) releaseSse(t)
  check('SG7 全部释放后计数归零', sseCounts().total, 0)
}

// ---- 接线静态检查（单点定义被入口真实使用；防「模块存在但未接线」）----
function wiringChecks(): void {
  const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
  const index = read('../server/src/index.ts')
  const app = read('../server/src/fastifyApp.ts')
  check('W1 index.ts WS 注册携带单点常量 maxPayload（Q-2 接线）', index.includes('maxPayload: WS_MAX_PAYLOAD_BYTES'), true)
  check("W2 index.ts health 收敛为 { ok, entry }（Q-4 接线）", index.includes("app.get('/api/health', async () => ({ ok: true, entry: 'user-api' }))"), true)
  check('W3 CORS 反射 origin:true 已在两构造点废除（Q-3 接线）', !index.includes('origin: true') && !app.includes('origin: true'), true)
  check('W4 CORS 注册仅在共享构造点（index.ts 不再自注册 cors）', !index.includes('register(cors'), true)
  check('W5 Cookie 属性单点（users.ts 无第二份属性定义）', !read('../server/src/users.ts').includes('SameSite=Lax; Max-Age'), true)
  // P0-1：真共享骨架——两入口均经 buildApp；index.ts 不再自建 Fastify 实例/错误处理器
  check('W6 user-api 经 buildApp 构造（P0-1 真共享）', index.includes("buildApp({ cors: true })") && !index.includes('const app = Fastify(') && !index.includes('app.setErrorHandler'), true)
  check('W7 admin-api 经 buildApp 构造', read('../server/src/adminApi.ts').includes('buildApp({ cors: false })'), true)
  // ARCH-01：契约包纯度——不 import server/web/Node 内置、无相对逃逸（浏览器可安全引用）
  const contracts = read('../packages/platform-contracts/src/index.ts')
  const contractImports = [...contracts.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  check('W8 platform-contracts 零运行时依赖（无 node:/server/web/相对导入）',
    contractImports.every((s) => !s.startsWith('node:') && !s.startsWith('../') && !s.includes('server') && !s.includes('web')), true)
  // P0-2：可信代理接线
  const vpsCaddy = read('../deploy/vps/Caddyfile')
  const oracleCaddy = read('../deploy/oracle/Caddyfile')
  check('W9 两份 Caddyfile 终端/backend/admin 块均覆盖 XFF/X-Real-IP（各 3 块）',
    vpsCaddy.split('header_up X-Forwarded-For {remote_host}').length - 1 === 3 &&
    oracleCaddy.split('header_up X-Forwarded-For {remote_host}').length - 1 === 3 &&
    vpsCaddy.includes('header_up X-Real-IP {remote_host}') && oracleCaddy.includes('header_up X-Real-IP {remote_host}'), true)
  check('W10 两份 compose override 注入 BV_TRUSTED_PROXIES',
    read('../deploy/vps/compose.override.yml').includes('BV_TRUSTED_PROXIES') &&
    read('../deploy/oracle/compose.override.yml').includes('BV_TRUSTED_PROXIES'), true)
  check('W11 buildApp 经 trustProxyOption（废除 trustProxy:true 反射）', app.includes('trustProxy: trustProxyOption()') && !app.includes('trustProxy: true'), true)
  check('W12 clientIpOf 不再手工读转发头（统一信任链）', !read('../server/src/authRoutes.ts').includes("'x-forwarded-for'"), true)
  // P0-2b：CSRF 与白名单收敛接线
  check('W13 两入口 /api/auth 白名单收敛为精确集合（AUTH_ANON_ALLOW）',
    index.includes('AUTH_ANON_ALLOW.has(url)') && read('../server/src/adminApi.ts').includes('AUTH_ANON_ALLOW.has(url)') &&
    !index.includes("startsWith('/api/auth/')") && !read('../server/src/adminApi.ts').includes("startsWith('/api/auth/')"), true)
  check('W14 csrf 端点注册于共享 authRoutes（两端获得）+ no-store',
    read('../server/src/authRoutes.ts').includes("app.get('/api/auth/csrf'") && read('../server/src/authRoutes.ts').includes('no-store'), true)
  // P1-1：SSE 硬限接线（写头前拒绝 + 释放成对 + 串行轮询 + 每轮验权）
  const sse = read('../server/src/research/runs/routes.ts')
  check('W15 SSE 准入在 writeHead 之前（超额 429 先于流建立）',
    sse.indexOf('acquireSse(') < sse.indexOf("reply.raw.writeHead(200", sse.indexOf('events')) && sse.includes('retry-after'), true)
  check('W16 SSE 释放与 acquire 成对（cleanup 内 releaseSse）', sse.includes('releaseSse(ticket)') && sse.includes('let cleaned = false'), true)
  check('W17 SSE 串行轮询（polling 守卫防 async interval 重叠）', sse.includes('if (polling) return') && sse.includes('polling = false'), true)
  check('W18 SSE 每轮复查存活会话（不再复用初始 SessionRecord）', sse.includes('findLiveSession(readSessionToken(req.headers.cookie)'), true)
  // P1-4：HTTP 配额（shadow）+ WS 加固 + 输入边界
  check('W19 两入口注册 registerHttpQuotaGuard（读/写/上传/管理写路由组）',
    index.includes('registerHttpQuotaGuard') && read('../server/src/adminApi.ts').includes('registerHttpQuotaGuard'), true)
  wsChecks()
}

function wsChecks(): void {
  const index = readFileSync(new URL('../server/src/index.ts', import.meta.url), 'utf8')
  check('W20a WS Origin 校验（isSameOrigin + 4003 origin_rejected）',
    index.includes("isSameOrigin(wsOrigin, req.headers.host") && index.includes("'origin_rejected'"), true)
  check('W20b WS 消息限速（10/s 突发 20 令牌桶 + 4008）', index.includes('4008') && index.includes('msgBucket'), true)
  check('W20c WS K 线订阅上限 20', index.includes('state.klines.size >= 20'), true)
  check('W20d WS 发送背压（>1MiB 跳过快照、>4MiB terminate）',
    index.includes('4 * 1024 * 1024') && index.includes('1024 * 1024') && index.includes('terminate()'), true)
  check('W21 JSON bodyLimit 256KiB（共享构造点）', readFileSync(new URL('../server/src/fastifyApp.ts', import.meta.url), 'utf8').includes('256 * 1024'), true)
  check('W22 URL 上限 8KiB（414 拒绝）', index === '' ? true : readFileSync(new URL('../server/src/security/httpQuota.ts', import.meta.url), 'utf8').includes('URI Too Long'), true)
}

// ---- main ----
q1Cookies()
await q3Cors()
trustUnit()
csrfUnit()
loggerJsonMode()
projectionUnit()
sseGuardUnit()
wiringChecks()
if (!staticOnly) {
  await q2Websocket()
  await trustBehavior()
  await sourceGuardBehavior()
  await requestIdBehavior()
}

console.log(`\n${failed === 0 ? '✔' : '✖'} security-gate-check：${checked - failed}/${checked} 通过${staticOnly ? '（--static 模式：运行断言未执行）' : ''}`)
process.exit(failed === 0 ? 0 : 1)
