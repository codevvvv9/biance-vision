/**
 * 幂等原语验证（P1-5，pnpm idempotency:atomic-check）——独立测试库：
 *   ID1 首次 claim（带键）→ fresh
 *   ID2 处理中并发同键 → in_progress（409 idempotency_in_progress 语义）
 *   ID3 完成后同键同内容重放 → replay（返回原 202/响应体）
 *   ID4 同键不同内容 → conflict（不执行副作用的 409 语义）
 *   ID5 未带键 → passthrough（兼容 rollout：键可选阶段）
 *   ID6 主体隔离：不同用户同键互不干扰
 *   ID7 分权：biance_user 对 request_idempotency INSERT 被拒、受控函数 EXECUTE 成功
 * 需 docker compose PG（5434）；独立库 bv_idem_atomic 结束 DROP。
 */
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

interface PostgresClient {
  unsafe(query: string): Promise<unknown>
  end(opts?: { timeout?: number }): Promise<void>
}
type PostgresFactory = (url: string, opts?: { max?: number; connect_timeout?: number; onnotice?: () => void }) => PostgresClient
const nodeRequire = createRequire(new URL('../server/package.json', import.meta.url))
const postgres = nodeRequire('postgres') as PostgresFactory

const TEST_DB = 'bv_idem_atomic'
let failed = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `（期望 ${String(expected)}，实际 ${String(actual)}）`}`)
}

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
process.env.BV_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'bv-idem-'))
process.env.BV_SUBJECT_HMAC_KEY = 'b'.repeat(64)

const { initDb } = await import('../server/src/db.js')
if (!(await initDb({ migrate: true }))) throw new Error('迁移失败（0029）')
const { claimIdempotency, completeIdempotency } = await import('../server/src/security/idempotency.js')

// 最小请求替身（claimIdempotency 只用 method/body/headers）
const mkReq = (body: unknown, key?: string): { method: string; body: unknown; headers: Record<string, string> } => ({
  method: 'POST', body, headers: key === undefined ? {} : { 'idempotency-key': key },
}) as never

const R = '/api/research/runs'
const r1 = await claimIdempotency(mkReq({ symbol: 'BTCUSDT', product: 'a' }, 'key-1') as never, R, 'user', 'alice')
check('ID1 首次同键 claim → fresh', r1.kind, 'fresh')
const r2 = await claimIdempotency(mkReq({ symbol: 'BTCUSDT', product: 'a' }, 'key-1') as never, R, 'user', 'alice')
check('ID2 处理中并发同键 → in_progress', r2.kind, 'in_progress')
await completeIdempotency(mkReq({ symbol: 'BTCUSDT', product: 'a' }, 'key-1') as never, R, 'user', 'alice', 202, { runId: 'run-xyz' })
const r3 = await claimIdempotency(mkReq({ symbol: 'BTCUSDT', product: 'a' }, 'key-1') as never, R, 'user', 'alice')
check('ID3 完成后同键同内容重放 → replay 原响应体',
  r3.kind === 'replay' && r3.statusCode === 202 && JSON.stringify((r3 as { body: unknown }).body) === JSON.stringify({ runId: 'run-xyz' }), true)
const r4 = await claimIdempotency(mkReq({ symbol: 'ETHUSDT', product: 'a' }, 'key-1') as never, R, 'user', 'alice')
check('ID4 同键不同内容 → conflict', r4.kind, 'conflict')
const r5 = await claimIdempotency(mkReq({ symbol: 'BTCUSDT' }) as never, R, 'user', 'alice')
check('ID5 未带键 → passthrough（兼容阶段）', r5.kind, 'passthrough')
const r6 = await claimIdempotency(mkReq({ symbol: 'BTCUSDT', product: 'a' }, 'key-1') as never, R, 'user', 'bob')
check('ID6 主体隔离（bob 同键 → fresh）', r6.kind, 'fresh')

// 分权
process.env.BV_DB_USER_PASSWORD = 'idem-check-pw'
const { syncDbUserRole } = await import('../server/src/dbGrants.js')
// 超户身份连测试库（非 postgres 库——GRANT 引用的表在本库）
const dcl = postgres(testUrl.toString().replace(`//${testUrl.username}:${testUrl.password}@`, `//postgres:${process.env.PG_SUPER_PASSWORD ?? 'postgres'}@`), { max: 1, connect_timeout: 3, onnotice: () => {} })
await syncDbUserRole(dcl as unknown as { unsafe: (q: string) => Promise<unknown[]> })
await dcl.end({ timeout: 1 })
const userUrl = new URL(testUrl.toString())
userUrl.username = 'biance_user'
userUrl.password = 'idem-check-pw'
const u = postgres(userUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
let denied = false
try {
  await u.unsafe(`INSERT INTO request_idempotency (purpose, subject_hash, method, route, key, fingerprint, expires_at) VALUES ('x','y','POST','/r','k','f',now())`)
} catch {
  denied = true
}
check('ID7a biance_user 对 request_idempotency INSERT 被拒', denied, true)
const fn = await u.unsafe(`SELECT security_idempotency_claim('t','s','POST','/r','fn-key','fp',30000) AS v`)
check('ID7b 受控函数 EXECUTE 成功', Array.isArray(fn) && (fn as Array<{ v: unknown }>)[0] !== undefined, true)
await u.end({ timeout: 1 })

const cleanup = postgres(admin.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
await cleanup.unsafe(`drop database if exists ${TEST_DB} with (force)`)
await cleanup.end({ timeout: 1 })
console.log(failed === 0 ? '\n幂等原语验证全部通过 ✔' : `\n失败 ${failed} 项 ✖`)
process.exit(failed === 0 ? 0 : 1)
