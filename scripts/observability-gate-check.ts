/**
 * 可观测专项门禁（pnpm observability:gate-check；--static 无 DB）
 * ——P2a 批次断言（方案 §15.1）：
 *   OG1 sink 初始状态（未启动/零丢弃）
 *   OG2 tryRecord → stop 强制 flush → observability_inbox 落库（source=server）
 *   OG3 错误指纹聚合 count 递增（受控函数）
 *   OG4 telemetry 属性白名单投影（危险键剔除/超长截断/非标量拒绝）
 *   OG5 管理端点仅 admin-api（user-api /api/admin/* 物理不存在）
 * 完整模式在独立测试库执行（bv_observability_gate）；浏览器生命周期等另附人工记录。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

let failed = 0
let checked = 0
function check(name: string, actual: unknown, expected: unknown = true): void {
  checked++
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `（期望 ${String(expected)}，实际 ${String(actual)}）`}`)
}

const staticOnly = process.argv.includes('--static')

// ---- OG5 静态：端点归属 ----
function staticChecks(): void {
  const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
  check('OG5a 观测三端点仅注册于 admin-api（user-api 无 /api/admin/* 路由）',
    read('../server/src/adminApi.ts').includes('registerObservabilityAdminRoutes') &&
    !read('../server/src/index.ts').includes('ObservabilityAdminRoutes'), true)
  check('OG5b telemetry 批端点两端注册（purpose 隔离）',
    read('../server/src/index.ts').includes("purpose: 'user', requireSession, clientIp") &&
    read('../server/src/adminApi.ts').includes("purpose: 'admin'"), true)
  check('OG5c 依赖方向：observability/ 不 import 路由入口',
    !read('../server/src/observability/diagnosticSink.ts').includes("from '../index.js'") &&
    !read('../server/src/observability/diagnosticSink.ts').includes("from '../adminApi.js'"), true)
}

staticChecks()

if (!staticOnly) {
  // 独立库：sink 落库 + 聚合（❗所有会间接加载 db.ts 的 import 必须在 env 设置后——
  // db.ts 模块顶层固化 DATABASE_URL，先 import 会连错库）
  const nodeRequire = createRequire(new URL('../server/package.json', import.meta.url))
  const postgres = nodeRequire('postgres') as (url: string, opts?: { max?: number; connect_timeout?: number; onnotice?: () => void }) => { unsafe(q: string): Promise<unknown>; end(o?: { timeout?: number }): Promise<void> }
  const TEST_DB = 'bv_observability_gate'
  const base = new URL(process.env.DATABASE_URL ?? 'postgresql://biance_app:biance_app@127.0.0.1:5434/biance_vision')
  const admin = new URL(base.toString())
  admin.username = 'postgres'
  admin.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
  admin.pathname = '/postgres'
  const drop = postgres(admin.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
  await drop.unsafe(`drop database if exists ${TEST_DB} with (force)`)
  await drop.unsafe(`create database ${TEST_DB} owner ${base.username}`)
  await drop.end({ timeout: 1 })
  const testUrl = new URL(base.toString())
  testUrl.pathname = `/${TEST_DB}`
  process.env.DATABASE_URL = testUrl.toString()
  process.env.BV_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'bv-obs-'))

  const { initDb } = await import('../server/src/db.js')
  if (!(await initDb({ migrate: true }))) throw new Error('迁移失败')
  const { tryRecord, stopDiagnosticSink, diagnosticSinkStats } = await import('../server/src/observability/diagnosticSink.js')
  const { projectTelemetryProps } = await import('../server/src/observability/telemetryRoute.js')
  const projected = projectTelemetryProps({ actionId: 'research-submit', password: 'x', nested: { a: 1 }, note: 'n'.repeat(300), count: 3 })
  check('OG4a 危险键剔除/对象拒绝/字符串截断 256/标量保留',
    projected !== null && !('password' in projected) && !('nested' in projected) &&
    (projected.note as string).length === 256 && projected.count === 3 && projected.actionId === 'research-submit', true)
  check('OG4b 非对象属性整体拒绝', projectTelemetryProps('x'), null)

  check('OG1 sink 初始状态（零丢弃）', diagnosticSinkStats().dropped, 0)
  tryRecord('user', '198.51.100.9', { kind: 'http_error', requestId: 'req-gate-1', payload: { statusCode: 500, code: null, message: null, method: 'GET', route: '/api/x' } }, { fingerprint: 'http:500:none' })
  tryRecord('user', '198.51.100.9', { kind: 'http_error', requestId: 'req-gate-1', payload: { statusCode: 500, code: null, message: null, method: 'GET', route: '/api/x' } }, { fingerprint: 'http:500:none' })
  await stopDiagnosticSink()
  const { getDb, sql } = await import('../server/src/db.js')
  const rows = await getDb()!.execute(sql`SELECT source, kind, request_id FROM observability_inbox WHERE request_id = 'req-gate-1'`)
  check('OG2 stop flush 后 inbox 落库（两条独立 event）', (rows as unknown as unknown[]).length, 2)
  const groups = await getDb()!.execute(sql`SELECT fingerprint, count FROM observability_error_groups WHERE fingerprint = 'http:500:none'`)
  const g = (groups as unknown as Array<{ count: number }>)[0]
  check('OG3 错误指纹聚合（同指纹 count=2）', g !== undefined && Number(g.count), 2)

  const cleanup = postgres(admin.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
  await cleanup.unsafe(`drop database if exists ${TEST_DB} with (force)`)
  await cleanup.end({ timeout: 1 })
}

console.log(`\n${failed === 0 ? '✔' : '✖'} observability-gate-check：${checked - failed}/${checked} 通过${staticOnly ? '（--static 模式）' : ''}`)
process.exit(failed === 0 ? 0 : 1)
