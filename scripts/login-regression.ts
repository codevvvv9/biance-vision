/**
 * 登录回归测试（pnpm login:regression）——HTTP 端到端，钉住 2026-10-21 审查 P1 修复，
 * 并满足三轮审查的数据隔离要求。
 *
 * 与 admin-gate-check 的分工：gate-check D 组测 loginEntryPolicy 策略函数本体；
 * 本脚本起真实 server 子进程（真实 scrypt 验证 / 失败计数 / IP 锁定 / 会话签发）：
 *   R0        server 实际连接独立测试库（未降级 JSON 存储）
 *   R1-R8     入口同构（主站正确/错误密码 401 逐字节一致）/ 正常签发（管理域名 200+cookie）
 *             / 失败计数与按 IP 锁定（锁定期内管理域名正确密码也 429）
 *   C1-C3     限速 env 非法值（如 'abc'→NaN）拒绝启动且错误信息指明变量、
 *             崩溃子进程对数据目录零写入（校验位于 env.ts，先于一切模块副作用）——
 *             防止安全阈值被静默关闭
 *
 * 数据隔离（不触碰业务数据，可与开发服务并行）：
 *   - BV_DATA_DIR=mkdtemp 临时目录：users/sessions/secrets 等文件态全部隔离，结束即删；
 *     专用测试超管账号由脚本写入 seed-users.json（随机强密码，不依赖 admin/ADMIN）
 *   - DATABASE_URL=独立测试库 bv_login_regression：用超户（PG_SUPER_PASSWORD，
 *     默认 postgres，即本地 compose 口令）DROP+CREATE（owner=biance_app），
 *     迁移由 initDb 启动时自动执行；审计/用户表写测试库，结束 DROP
 *
 * 环境要求：docker compose 的 postgres（宿主 5434）在跑。CI 无状态环境不跑本脚本
 * （release-gate 本地门禁，GATE_SKIP_DB 可跳过）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { request } from 'node:http'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'

// postgres 驱动在 server 包依赖里（根 package 不依赖），经 server/package.json 定位。
// 类型用最小手写接口：根 tsconfig 的类型解析不包含 server 的 node_modules，
// `typeof import('postgres')` 会在 typecheck 报 TS2307（运行时经 createRequire 正常）
interface PostgresClient {
  unsafe(query: string): Promise<unknown>
  end(opts?: { timeout?: number }): Promise<void>
}
type PostgresFactory = (
  url: string,
  opts?: { max?: number; connect_timeout?: number; onnotice?: () => void },
) => PostgresClient
const nodeRequire = createRequire(new URL('../server/package.json', import.meta.url))
const postgres = nodeRequire('postgres') as PostgresFactory

const PORT = 3201
const ADMIN_HOST = 'login-regression.test'
const MAIN_HOST = 'www.main.test'
const TEST_DB = 'bv_login_regression'
const SERVER_DIR = new URL('../server/', import.meta.url).pathname

let failed = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `（期望 ${String(expected)}，实际 ${String(actual)}）`}`)
  if (!ok) failed++
}

interface LoginRes {
  status: number
  body: string
  setCookie: string | undefined
}

/** 必须用 node:http：Undici fetch 会忽略自定义 host 头（实测被替换为 URL authority），
 * 导致入口策略恒判为用户域名——host 头是本测试的核心变量 */
function login(host: string, username: string, password: string): Promise<LoginRes> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username, password })
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        method: 'POST',
        path: '/api/auth/login',
        headers: {
          'content-type': 'application/json',
          host,
          'content-length': String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c: Buffer) => (data += c.toString()))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: data,
            setCookie: (res.headers['set-cookie'] ?? [])[0],
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** 与 server/src/db.ts 同语义地取基础 DATABASE_URL：环境变量 → server/.env → 默认值。
 * （env 必须最优先：隔离环境用 DATABASE_URL 覆盖端口/实例时，否则测试库会建到
 * .env 指向的实例上——曾实测 6543 覆盖被忽略、仍操作 5434） */
function baseDatabaseUrl(): URL {
  let url: string | undefined = process.env.DATABASE_URL
  if (!url) {
    try {
      const text = readFileSync(path.join(SERVER_DIR, '.env'), 'utf8')
      const m = text.match(/^DATABASE_URL=(.+)$/m)
      if (m) url = m[1].trim().replace(/^["']|["']$/g, '')
    } catch {
      /* 无 .env 用默认 */
    }
  }
  return new URL(url ?? 'postgresql://biance_app:biance_app@127.0.0.1:5434/biance_vision')
}

function startServer(overrides: Record<string, string>): { child: ChildProcess; log: string[] } {
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const serverLog: string[] = []
  createInterface({ input: child.stdout }).on('line', (l) => serverLog.push(l))
  createInterface({ input: child.stderr }).on('line', (l) => serverLog.push(l))
  return { child, log: serverLog }
}

async function stopServer(child: ChildProcess): Promise<void> {
  // exitCode 仅覆盖正常退出：被信号终止的进程 exitCode=null、signalCode='SIGTERM'/
  // 'SIGKILL'——只查 exitCode 会对已终止的进程再等一次（不会再到来的）exit 事件而
  // 永久挂起（隔离复现确认）
  if (child.exitCode !== null || child.signalCode !== null) return
  // 一次 exit 监听 + 定时升级 SIGKILL：进程只会 emit 一次 exit，
  // 分两段各挂一个 await 会在第一段消费掉事件后让第二段永等（实测挂死）
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('exit', () => {
      clearTimeout(killTimer)
      resolve()
    })
    child.kill('SIGTERM')
  })
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      // 启动中，继续等
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** 超户重建测试库（owner=应用账号，凭据沿用 DATABASE_URL）；库名/owner 为脚本常量，无注入面 */
async function recreateTestDb(base: URL): Promise<URL> {
  const admin = new URL(base.toString())
  admin.username = 'postgres'
  admin.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
  admin.pathname = '/postgres'
  const sql = postgres(admin.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
  try {
    await sql.unsafe(`drop database if exists ${TEST_DB} with (force)`)
    await sql.unsafe(`create database ${TEST_DB} owner ${base.username}`)
  } finally {
    await sql.end({ timeout: 1 })
  }
  const testUrl = new URL(base.toString())
  testUrl.pathname = `/${TEST_DB}`
  return testUrl
}

async function dropTestDb(base: URL): Promise<void> {
  const admin = new URL(base.toString())
  admin.username = 'postgres'
  admin.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
  admin.pathname = '/postgres'
  const sql = postgres(admin.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
  try {
    await sql.unsafe(`drop database if exists ${TEST_DB} with (force)`)
  } catch (e) {
    console.error(`⚠ 测试库清理失败（不影响结论，可手工 DROP DATABASE ${TEST_DB}）：${(e as Error).message}`)
  } finally {
    await sql.end({ timeout: 1 })
  }
}

// ---- 前置：端口未占用 ----
try {
  const probe = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1000) })
  if (probe.ok) {
    console.error(`✖ 端口 ${PORT} 已有服务在跑（可能是本地 dev server），请先停止或改 PORT`)
    process.exit(1)
  }
} catch {
  // 端口空闲，正常
}

// ---- 主流程：隔离环境起真实 server，跑入口同构/计数/锁定断言 ----
const base = baseDatabaseUrl()
let testUrl: URL | null = null
const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-login-reg-'))
const adminUser = 'login-reg-admin'
const adminPass = randomBytes(12).toString('hex')

try {
  await writeFile(
    path.join(dataDir, 'seed-users.json'),
    JSON.stringify([{ username: adminUser, password: adminPass, role: 'superadmin' }]),
  )
  testUrl = await recreateTestDb(base)

  const { child, log: serverLog } = startServer({
    PORT: String(PORT),
    ADMIN_HOSTS: ADMIN_HOST,
    LOGIN_MAX_PER_WINDOW: '100',
    LOGIN_LOCK_FAILS: '3',
    BV_DATA_DIR: dataDir,
    DATABASE_URL: testUrl.toString(),
  })

  try {
    if (!(await waitForHealth(30_000))) {
      throw new Error(`server 子进程 30s 内未就绪，启动日志尾部：\n${serverLog.slice(-10).join('\n')}`)
    }
    check('R0 server 连接独立测试库（未降级 JSON 存储）', serverLog.join('\n').includes(TEST_DB), true)

    // 请求顺序有讲究：先走一次成功登录（R1）把失败计数清零，随后 R3/R4/R6 的三次失败
    // 恰好达到注入的锁定阈值 3，R7/R8 验证锁定生效与按 IP 语义
    const r1 = await login(ADMIN_HOST, adminUser, adminPass)
    check('R1 管理域名 + 测试超管正确密码 → 200', r1.status, 200)
    check('R2 签发会话 cookie（bv_session）', (r1.setCookie ?? '').includes('bv_session='), true)

    const r3 = await login(MAIN_HOST, adminUser, 'wrong-password')
    check('R3 主站 + 超管错误密码 → 401', r3.status, 401)

    const r4 = await login(MAIN_HOST, adminUser, adminPass)
    check('R4 主站 + 超管正确密码 → 401（修复前为 403，可探测密码命中）', r4.status, 401)
    check('R4 不签发会话', r4.setCookie, undefined)
    check('R5 R3/R4 响应体逐字节一致（对外完全同构）', r4.body === r3.body, true)

    // 第 3 次失败：入口正确但用户不存在，同样计满阈值 → 触发锁定
    const r6 = await login(ADMIN_HOST, 'no-such-user', 'whatever')
    check('R6 管理域名 + 不存在用户 → 401（同构补充）', r6.status, 401)

    const r7 = await login(MAIN_HOST, adminUser, 'wrong-again')
    check('R7 达到失败阈值后再试 → 429 锁定拦截', r7.status, 429)
    check('R7 锁定文案含「锁定」', r7.body.includes('锁定'), true)

    const r8 = await login(ADMIN_HOST, adminUser, adminPass)
    check('R8 锁定期内管理域名正确密码同样 429（按 IP 锁定，不分入口/密码）', r8.status, 429)
  } finally {
    await stopServer(child)
  }

  // ---- R4b：验证前预检生效的日志证据（serverLog 于 stopServer 后完整；
  //      「验证前预检，密码校验未执行」= 错误入口在 scrypt 之前被拒的直接证据，
  //      主站超管正确密码（R4）全程未产生第二次登录成功）----
  {
    const fullLog = serverLog.join('\n')
    check('R4b 预检路径生效（错误入口在密码校验之前拒绝）', fullLog.includes('验证前预检，密码校验未执行'), true)
    check('R4b 全程仅一次登录成功（R1 管理域；主站正确密码未成功）', fullLog.split('登录成功').length - 1, 1)
  }

  // ---- C 组：限速 env 非法值拒绝启动 ----
  // ❗必须同样传全套隔离 env：校验虽已上移到一切初始化之前，但不传隔离意味着
  // 回归一旦失效（校验被挪后）就会连业务库、写业务 data——测试不能依赖被测行为
  {
    const before = await readdir(dataDir).then((l) => l.sort().join(','))
    const { child, log } = startServer({
      PORT: String(PORT),
      LOGIN_LOCK_FAILS: 'abc',
      BV_DATA_DIR: dataDir,
      DATABASE_URL: testUrl.toString(),
    })
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL')
        resolve(null)
      }, 20_000)
      child.once('exit', (c) => {
        clearTimeout(t)
        resolve(c)
      })
    })
    check('C1 非法 LOGIN_LOCK_FAILS → 拒绝启动（非零退出，且未依赖业务数据）', code !== null && code !== 0, true)
    check('C2 错误信息指明变量名', log.join('\n').includes('LOGIN_LOCK_FAILS'), true)
    // C3 严格零写入：校验位于 env.ts（入口 import 首位），崩溃先于 alerts.ts 等任何
    // 顶层写盘——数据目录在崩溃前后文件清单必须完全一致（此前 alerts.ts 会留 rules.json）
    const after = await readdir(dataDir).then((l) => l.sort().join(','))
    check('C3 崩溃子进程零文件写入（校验先于一切模块副作用）', after, before)
  }
} catch (err) {
  console.error(`✖ ${(err as Error).message}`)
  failed++
} finally {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  if (testUrl) await dropTestDb(base)
}

if (failed > 0) {
  console.error(`\n登录回归未通过 ✖（${failed} 项失败）`)
  process.exit(1)
}
console.log('\n登录回归全部通过 ✔（16 项：测试库隔离 / 入口同构 / 会话签发 / 失败计数 / IP 锁定 / 非法配置拒绝启动+零写入）')
