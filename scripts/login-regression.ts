/**
 * 登录回归测试（pnpm login:regression）——HTTP 端到端，钉住 2026-10-21 审查 P1 修复：
 *
 * 与 admin-gate-check 的分工：gate-check D 组测 loginEntryPolicy 策略函数本体；
 * 本脚本起真实 server 子进程（真实 scrypt 验证 / 失败计数 / IP 锁定 / 会话签发），
 * 断言三组行为：
 *   R1-R4 入口同构：主站对管理员提交正确/错误密码，响应（状态码+响应体+无会话）完全一致，
 *        401/403 差异曾被用于探测管理员密码是否命中；
 *   R5   管理域名正常路径：管理员登录 200 + 签发会话 cookie；
 *   R6-R8 失败计数与锁定：连续失败达到阈值后按 IP 锁定（含管理域名正确密码也被 429），
 *        锁定按 IP 而非按账号/入口。
 *
 * 环境要求（与本地开发同栈）：docker compose 起的 postgres(5434)/minio，server/data
 * 有 seed-users.json（admin 账号）。阈值经 env 注入小值（每分钟上限 100 / 3 次锁定），
 * 全程 8 个请求、数秒完成。CI 无状态环境不跑本脚本（release-gate 本地门禁）。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { request } from 'node:http'

const PORT = 3201
const ADMIN_HOST = 'login-regression.test'
const MAIN_HOST = 'www.main.test'
const BASE = `http://127.0.0.1:${PORT}`

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

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      // 启动中，继续等
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// ---- 前置：端口未占用 ----
try {
  const probe = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) })
  if (probe.ok) {
    console.error(`✖ 端口 ${PORT} 已有服务在跑（可能是本地 dev server），请先停止或改 PORT`)
    process.exit(1)
  }
} catch {
  // 端口空闲，正常
}

// ---- 起真实 server 子进程：注入 ADMIN_HOSTS 与小阈值（默认语义不变） ----
const child = spawn('npx', ['tsx', 'src/index.ts'], {
  cwd: new URL('../server/', import.meta.url).pathname,
  env: {
    ...process.env,
    PORT: String(PORT),
    ADMIN_HOSTS: ADMIN_HOST,
    LOGIN_MAX_PER_WINDOW: '100',
    LOGIN_LOCK_FAILS: '3',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const serverLog: string[] = []
createInterface({ input: child.stdout }).on('line', (l) => serverLog.push(l))
createInterface({ input: child.stderr }).on('line', (l) => serverLog.push(l))

try {
  if (!(await waitForHealth(30_000))) {
    console.error('✖ server 子进程 30s 内未就绪，启动日志尾部：')
    console.error(serverLog.slice(-10).join('\n'))
    process.exit(1)
  }

  // 请求顺序有讲究：先走一次成功登录（R1）把失败计数清零，随后 R2/R3/R5 的三次失败
  // 恰好达到注入的锁定阈值 3，R7/R8 验证锁定生效与按 IP 语义
  const r1 = await login(ADMIN_HOST, 'admin', 'ADMIN')
  check('R1 管理域名 + 管理员正确密码 → 200', r1.status, 200)
  check('R1 签发会话 cookie（bv_session）', (r1.setCookie ?? '').includes('bv_session='), true)

  const r2 = await login(MAIN_HOST, 'admin', 'wrong-password')
  check('R2 主站 + 管理员错误密码 → 401', r2.status, 401)

  const r3 = await login(MAIN_HOST, 'admin', 'ADMIN')
  check('R3 主站 + 管理员正确密码 → 401（修复前为 403，可探测密码命中）', r3.status, 401)
  check('R3 不签发会话', r3.setCookie, undefined)
  check('R4 R2/R3 响应体逐字节一致（对外完全同构）', r3.body === r2.body, true)

  // 第 3 次失败：入口正确但用户不存在，同样计满阈值 → 触发锁定
  const r5 = await login(ADMIN_HOST, 'no-such-user', 'whatever')
  check('R5 管理域名 + 不存在用户 → 401（同构补充）', r5.status, 401)

  const r6 = await login(MAIN_HOST, 'admin', 'wrong-again')
  check('R6 达到失败阈值后再试 → 429 锁定拦截', r6.status, 429)
  check('R6 锁定文案含「锁定」', r6.body.includes('锁定'), true)

  const r7 = await login(ADMIN_HOST, 'admin', 'ADMIN')
  check('R7 锁定期内管理域名正确密码同样 429（按 IP 锁定，不分入口/密码）', r7.status, 429)
} finally {
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise<boolean>((r) => child.on('exit', () => r(true))),
    new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
  ])
  if (!exited) child.kill('SIGKILL')
}

if (failed > 0) {
  console.error(`\n登录回归未通过 ✖（${failed} 项失败）`)
  process.exit(1)
}
console.log('\n登录回归全部通过 ✔（8 项：入口同构 / 会话签发 / 失败计数 / IP 锁定）')
