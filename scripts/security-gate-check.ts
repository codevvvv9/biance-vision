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
}

// ---- main ----
q1Cookies()
await q3Cors()
wiringChecks()
if (!staticOnly) await q2Websocket()

console.log(`\n${failed === 0 ? '✔' : '✖'} security-gate-check：${checked - failed}/${checked} 通过${staticOnly ? '（--static 模式：运行断言未执行）' : ''}`)
process.exit(failed === 0 ? 0 : 1)
