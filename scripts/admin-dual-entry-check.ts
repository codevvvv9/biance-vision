/**
 * 双入口切分自测（W3-S3，docs/admin-isolation-plan.md §3.5 验收项落地）：
 * 在独立测试库上同时拉起 user-api（index.ts）与 admin-api（adminApi.ts）两个进程，
 * 断言管理能力在 user-api 物理不存在、在 admin-api 可用，以及登录入口分离与
 * 会话用途隔离的进程级语义。
 *
 * 运行：pnpm admin:dual-check（独立 PG 测试库，结束 DROP；不读写开发/生产数据）
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { request } from 'node:http'

const nodeRequire = createRequire(new URL('../server/package.json', import.meta.url))
// `typeof import('postgres')` 会在 typecheck 报 TS2307（运行时经 createRequire 正常，
// 与 login-regression.ts 同款处理）
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const postgres = nodeRequire('postgres') as { (url: string, opts?: Record<string, unknown>): PgLike; }
interface PgLike {
  unsafe(sql: string): Promise<unknown[]>
  end(opts?: { timeout?: number }): Promise<void>
}

const SERVER_DIR = new URL('../server/', import.meta.url).pathname
const TEST_DB = 'bv_dual_entry_check'
const USER_PORT = 3961
const ADMIN_PORT = 3962

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `（期望 ${String(expected)}，实际 ${String(actual)}）`}`)
  if (!ok) failures++
}

interface Res {
  status: number
  body: string
  setCookie: string | undefined
}

function req(port: number, method: string, pathName: string, opts: { body?: unknown; cookie?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    const r = request(
      { host: '127.0.0.1', port, method, path: pathName,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
          ...(opts.cookie !== undefined ? { cookie: opts.cookie } : {}),
          'x-forwarded-for': '10.77.0.9', // 独立 IP：避开与其他测试的限速计数合并
        } },
      (res) => {
        let data = ''
        res.on('data', (c: Buffer) => (data += c.toString()))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, setCookie: (res.headers['set-cookie'] ?? [])[0] }))
      },
    )
    r.on('error', reject)
    r.end(body)
  })
}

function baseDatabaseUrl(): URL {
  let url: string | undefined = process.env.DATABASE_URL
  if (!url) {
    try {
      const text = readFileSync(path.join(SERVER_DIR, '.env'), 'utf8')
      const m = text.match(/^DATABASE_URL=(.+)$/m)
      if (m) url = m[1].trim().replace(/^["']|["']$/g, '')
    } catch { /* 无 .env 用默认 */ }
  }
  return new URL(url ?? 'postgresql://biance_app:biance_app@127.0.0.1:5434/biance_vision')
}

function startServer(entry: string, port: number, dbUrl: string, dataDir: string): { child: ChildProcess; log: string[] } {
  const child = spawn('npx', ['tsx', entry], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), BV_DATA_DIR: dataDir, DATABASE_URL: dbUrl, BV_AUTO_MIGRATE: entry === 'src/index.ts' ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const log: string[] = []
  child.stdout?.on('data', (d) => log.push(d.toString()))
  child.stderr?.on('data', (d) => log.push(d.toString()))
  return { child, log }
}

async function waitHealth(port: number, timeoutMs = 30_000): Promise<boolean> {
  for (let i = 0; i < timeoutMs / 500; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) })
      if (res.ok) return true
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 4000)
    child.once('exit', () => { clearTimeout(t); resolve() })
  })
}

const base = baseDatabaseUrl()
const dataDir = await mkdtemp(path.join(tmpdir(), 'bv-dual-check-'))
const adminUser = 'dual-admin'
const adminPass = randomBytes(12).toString('hex')
const normalUser = 'dual-user'
const normalPass = randomBytes(12).toString('hex')

let testUrl: URL | null = null
const procs: ChildProcess[] = []
try {
  // 独立测试库
  const admin = new URL(base.toString())
  admin.username = 'postgres'
  admin.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
  admin.pathname = '/postgres'
  const sql = postgres(admin.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
  await sql.unsafe(`drop database if exists ${TEST_DB} with (force)`)
  await sql.unsafe(`create database ${TEST_DB} owner ${base.username}`)
  await sql.end({ timeout: 1 })
  testUrl = new URL(base.toString())
  testUrl.pathname = `/${TEST_DB}`

  await writeFile(path.join(dataDir, 'seed-users.json'), JSON.stringify([
    { username: adminUser, password: adminPass, role: 'superadmin' },
    { username: normalUser, password: normalPass, role: 'user' },
  ]))

  const u = startServer('src/index.ts', USER_PORT, testUrl.toString(), dataDir)
  procs.push(u.child)
  if (!(await waitHealth(USER_PORT))) throw new Error(`user-api 未就绪：${u.log.slice(-6).join('\n')}`)
  check('D1 user-api 健康就绪', true, true)

  // user-api 先行跑迁移后 admin-api 以 BV_AUTO_MIGRATE=0 启动
  const a = startServer('src/adminApi.ts', ADMIN_PORT, testUrl.toString(), dataDir)
  procs.push(a.child)
  if (!(await waitHealth(ADMIN_PORT))) throw new Error(`admin-api 未就绪：${a.log.slice(-6).join('\n')}`)
  const adminHealth = await req(ADMIN_PORT, 'GET', '/api/health')
  check('D2 admin-api 健康（entry=admin-api）', adminHealth.body.includes('admin-api'), true)

  // ---- 管理能力在 user-api 物理不存在（404，非门禁 401/403）----
  const noAdminUsers = await req(USER_PORT, 'GET', '/api/admin/users')
  check('D3 user-api GET /api/admin/users → 404（路由不存在）', noAdminUsers.status, 404)
  const noAdminAi = await req(USER_PORT, 'GET', '/api/admin/ai/config')
  check('D4 user-api GET /api/admin/ai/config → 404', noAdminAi.status, 404)
  const noKnowledge = await req(USER_PORT, 'GET', '/api/admin/knowledge/documents')
  check('D5 user-api GET /api/admin/knowledge/documents → 404', noKnowledge.status, 404)
  const noAdminPage = await req(USER_PORT, 'GET', '/admin/knowledge')
  check('D6 user-api GET /admin/* → 404（不回退用户 SPA）', noAdminPage.status, 404)

  // ---- 登录入口分离（进程级）----
  const adminOnUser = await req(USER_PORT, 'POST', '/api/auth/login', { body: { username: adminUser, password: adminPass } })
  check('D7 user-api 超管登录被拒（401，管理认证只在 admin-api）', adminOnUser.status, 401)
  check('D8 被拒响应不签发会话', adminOnUser.setCookie, undefined)
  const normalOnUser = await req(USER_PORT, 'POST', '/api/auth/login', { body: { username: normalUser, password: normalPass } })
  check('D9 user-api 普通用户登录 → 200', normalOnUser.status, 200)
  const normalOnAdmin = await req(ADMIN_PORT, 'POST', '/api/auth/login', { body: { username: normalUser, password: normalPass } })
  check('D10 admin-api 普通用户登录被拒（401）', normalOnAdmin.status, 401)
  const adminOnAdmin = await req(ADMIN_PORT, 'POST', '/api/auth/login', { body: { username: adminUser, password: adminPass } })
  check('D11 admin-api 超管登录 → 200', adminOnAdmin.status, 200)
  const adminCookie = (adminOnAdmin.setCookie ?? '').split(';')[0]

  // ---- 会话用途隔离：user 会话在 admin-api 无效；admin 会话在 user-api 无效 ----
  const userCookie = (normalOnUser.setCookie ?? '').split(';')[0]
  const userSessOnAdmin = await req(ADMIN_PORT, 'GET', '/api/auth/me', { cookie: userCookie })
  check('D12 user 会话访问 admin-api → 401（用途不匹配）', userSessOnAdmin.status, 401)
  const adminSessOnUser = await req(USER_PORT, 'GET', '/api/auth/me', { cookie: adminCookie })
  check('D13 admin 会话访问 user-api → 401（用途不匹配）', adminSessOnUser.status, 401)
  const adminSessOk = await req(ADMIN_PORT, 'GET', '/api/auth/me', { cookie: adminCookie })
  check('D14 admin 会话在 admin-api → 200', adminSessOk.status, 200)

  // ---- admin-api 管理功能可用（登录后 200，非 404）----
  const adminUsers = await req(ADMIN_PORT, 'GET', '/api/admin/users', { cookie: adminCookie })
  check('D15 admin-api GET /api/admin/users → 200', adminUsers.status, 200)
  const aiConfig = await req(ADMIN_PORT, 'GET', '/api/admin/ai/config', { cookie: adminCookie })
  check('D16 admin-api GET /api/admin/ai/config → 200', aiConfig.status, 200)
  const knowledge = await req(ADMIN_PORT, 'GET', '/api/admin/knowledge/documents', { cookie: adminCookie })
  check('D17 admin-api GET /api/admin/knowledge/documents → 200', knowledge.status, 200)
  const adminPage = await req(ADMIN_PORT, 'GET', '/admin/knowledge')
  check('D18 admin-api GET /admin/* → 管理端 SPA（200/301）', [200, 301, 302].includes(adminPage.status), true)

  // ---- user-api 用户能力不受影响 ----
  const meOk = await req(USER_PORT, 'GET', '/api/auth/me', { cookie: userCookie })
  check('D19 user 会话在 user-api → 200', meOk.status, 200)
  const userAi = await req(USER_PORT, 'GET', '/api/ai/status')
  check('D20 user-api /api/ai/status 可用（无需会话白名单）', [200, 401].includes(userAi.status), true)

  // 日志证据：user-api 拒超管走预检（scrypt 未执行）
  check('D21 user-api 预检日志（密码校验未执行）', u.log.join('\n').includes('验证前预检，密码校验未执行'), true)
} finally {
  for (const c of procs) await stop(c)
  if (testUrl !== null) {
    const admin = new URL(base.toString())
    admin.username = 'postgres'
    admin.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
    admin.pathname = '/postgres'
    const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} })
    await sql.unsafe(`drop database if exists ${TEST_DB} with (force)`).catch(() => {})
    await sql.end({ timeout: 1 }).catch(() => {})
  }
}

console.log(failures === 0 ? '\n双入口切分自测全部通过 ✔（21 项）' : `\n失败 ${failures} 项 ✖`)
process.exit(failures === 0 ? 0 : 1)
