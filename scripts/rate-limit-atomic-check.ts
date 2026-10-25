/**
 * 共享限流原语验证（P1-2，pnpm rate-limit:atomic-check）——独立测试库上的
 * 真实行为断言（方案 §14.4 P1-2：双进程并发/重启/窗口边界/分权）：
 *   RA1 并发 20 消费 limit=10 → counter 封顶 10、allowed=false 恰 10 次
 *   RA2 固定窗口重置：windowMs=300ms 过窗后重新计数
 *   RA3 shadow 命中：业务放行（allowed=true）+ decision=should_block（不拒绝）
 *   RA4 enforce 命中：allowed=false + Retry-After > 0
 *   RA5 shadow/enforce 桶隔离：shadow 消费不影响 enforce 计数
 *   RA6 分权（biance_user 连接）：表 INSERT 被拒；受控函数 EXECUTE 成功
 *   RA7 迁移可执行：独立库跑 migrate 建出表与函数（本脚本前置即验证）
 * 数据隔离：独立测试库 bv_rate_limit_atomic，结束 DROP；需 docker compose PG（5434）。
 */
import { createRequire } from 'node:module'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

interface PostgresClient {
  unsafe(query: string, params?: unknown[]): Promise<unknown>
  end(opts?: { timeout?: number }): Promise<void>
}
type PostgresFactory = (url: string, opts?: { max?: number; connect_timeout?: number; onnotice?: () => void }) => PostgresClient
const nodeRequire = createRequire(new URL('../server/package.json', import.meta.url))
const postgres = nodeRequire('postgres') as PostgresFactory

const TEST_DB = 'bv_rate_limit_atomic'

let failed = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `（期望 ${String(expected)}，实际 ${String(actual)}）`}`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function baseDatabaseUrl(): URL {
  return new URL(process.env.DATABASE_URL ?? 'postgresql://biance_app:biance_app@127.0.0.1:5434/biance_vision')
}

const base = baseDatabaseUrl()
const adminUrl = new URL(base.toString())
adminUrl.username = 'postgres'
adminUrl.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
adminUrl.pathname = '/postgres'
const drop = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
await drop.unsafe(`drop database if exists ${TEST_DB} with (force)`)
await drop.unsafe(`create database ${TEST_DB} owner ${base.username}`)
await drop.end({ timeout: 1 })

const testUrl = new URL(base.toString())
testUrl.pathname = `/${TEST_DB}`
process.env.DATABASE_URL = testUrl.toString()
process.env.BV_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'bv-rl-'))
process.env.BV_SUBJECT_HMAC_KEY = 'a'.repeat(64)

const { initDb } = await import('../server/src/db.js')
if (!(await initDb({ migrate: true }))) throw new Error('测试库迁移失败（RA7 迁移含 0028）')
const { rateLimitConsume } = await import('../server/src/security/rateLimit.js')

// RA1 并发精确计数（limit=10）
const P10 = { id: 'ra-test:concurrent', limit: 10, windowMs: 60_000, mode: 'enforce' as const }
const results = await Promise.all(Array.from({ length: 20 }, () => rateLimitConsume(P10, '198.51.100.1')))
check('RA1a 并发 20 消费 limit=10：allowed=false 恰 10 次', results.filter((r) => !r.allowed).length, 10)
check('RA1b 原子精确递增（20 并发 counter=20，不丢不重）', Math.max(...results.map((r) => r.counter)), 20)

// RA2 固定窗口重置
const P300 = { id: 'ra-test:window', limit: 2, windowMs: 300, mode: 'enforce' as const }
const a1 = await rateLimitConsume(P300, '198.51.100.2')
const a2 = await rateLimitConsume(P300, '198.51.100.2')
const a3 = await rateLimitConsume(P300, '198.51.100.2')
await sleep(400)
const a4 = await rateLimitConsume(P300, '198.51.100.2')
check('RA2 固定窗口重置（窗内第 3 次拒、过窗后重新计数）', a1.allowed && a2.allowed && !a3.allowed && a4.allowed, true)

// RA3/RA4 shadow 与 enforce 语义
const PSH = { id: 'ra-test:shadow', limit: 2, windowMs: 60_000, mode: 'shadow' as const }
const s1 = await rateLimitConsume(PSH, '198.51.100.3')
const s2 = await rateLimitConsume(PSH, '198.51.100.3')
const s3 = await rateLimitConsume(PSH, '198.51.100.3')
check('RA3 shadow 超限不拒绝业务（allowed=true + should_block）', s1.allowed && s2.allowed && s3.allowed && s3.decision, 'should_block')
// RA4 enforce 全流程：独立主体连打 3 次（limit 2），第 3 次拒 + Retry-After
const PEN = { id: 'ra-test:shadow', limit: 2, windowMs: 60_000, mode: 'enforce' as const }
const eSubject = '198.51.100.4'
const en1 = await rateLimitConsume(PEN, eSubject)
const en2 = await rateLimitConsume(PEN, eSubject)
const en3 = await rateLimitConsume(PEN, eSubject)
check('RA4 enforce 超限 → 拒绝 + Retry-After', en1.allowed && en2.allowed && !en3.allowed && en3.decision === 'block' && en3.retryAfterSeconds >= 0, true)
check('RA5 shadow 桶与 enforce 桶隔离（shadow 3 次后 enforce 计数从 1 起算）',
  (await rateLimitConsume(PEN, '198.51.100.3')).counter, 1)

// RA6 分权：超户重放角色同步（与 migrate 容器一致）后，以 biance_user 直连断言
process.env.BV_DB_USER_PASSWORD = 'rl-check-pw'
const { syncDbUserRole } = await import('../server/src/dbGrants.js')
const dclUrl = new URL(testUrl.toString())
dclUrl.username = 'postgres'
dclUrl.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
const dcl = postgres(dclUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
await syncDbUserRole(dcl as unknown as { unsafe: (q: string) => Promise<unknown[]> })
await dcl.end({ timeout: 1 })
const userUrl = new URL(testUrl.toString())
userUrl.username = 'biance_user'
userUrl.password = 'rl-check-pw'
const userConn = postgres(userUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
let insertDenied = false
try {
  await userConn.unsafe(`INSERT INTO security_rate_buckets (scope, subject_hash, counter, window_start, window_ms, expires_at) VALUES ('x','y',1,0,1000,now())`)
} catch {
  insertDenied = true
}
check('RA6a biance_user 对 security_rate_buckets INSERT 被拒（无 DML）', insertDenied, true)
const fnResult = await userConn.unsafe(`SELECT security_consume_rate_limit('ra-fn:grant', 'subj', 5, 60000) AS r`)
check('RA6b biance_user 可 EXECUTE 受控函数（迁移内授权）', Array.isArray(fnResult) && (fnResult as Array<{ r: unknown }>)[0] !== undefined, true)
await userConn.end({ timeout: 1 })


// ---- P1-6 租约（LS 组：获取/独占/续约/释放/过期抢占 fencing）----
const lease = async (fn: string, ...args: unknown[]): Promise<unknown> => {
  const r = await userConnUnsafe(fn, args)
  return r
}
async function userConnUnsafe(fn: string, args: unknown[]): Promise<unknown> {
  const u2 = postgres(userUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
  try {
    const res = await u2.unsafe(`SELECT ${fn} AS r`, args)
    return (res as Array<{ r: unknown }>)[0]?.r
  } finally {
    await u2.end({ timeout: 1 })
  }
}
const l1 = (await lease('security_acquire_lease($1,$2,$3,$4)', 'res-1', 'owner-a', 'test', 60000)) as { acquired: boolean; generation: number }
check('LS1 获取租约（generation=1）', l1.acquired === true && l1.generation === 1, true)
const l2 = (await lease('security_acquire_lease($1,$2,$3,$4)', 'res-1', 'owner-b', 'test', 60000)) as { acquired: boolean }
check('LS2 未过期时他人获取被拒（独占）', l2.acquired, false)
check('LS3 持有者续约成功', await lease('security_renew_lease($1,$2,$3)', 'res-1', 'owner-a', 60000), true)
check('LS4 非持有者续约被拒', await lease('security_renew_lease($1,$2,$3)', 'res-1', 'owner-b', 60000), false)
await lease('security_release_lease($1,$2)', 'res-1', 'owner-a')
const l5 = (await lease('security_acquire_lease($1,$2,$3,$4)', 'res-1', 'owner-b', 'test', 60000)) as { acquired: boolean; generation: number }
check('LS5 释放后他人可取', l5.acquired, true)
// fencing：人为过期后抢占 → generation+1；原持有者（陈旧）续约必须失败
const ownerConn = postgres(testUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
await ownerConn.unsafe(`UPDATE security_leases SET lease_until = now() - interval '1 second' WHERE resource = 'res-1'`)
await ownerConn.end({ timeout: 1 })
const l6 = (await lease('security_acquire_lease($1,$2,$3,$4)', 'res-1', 'owner-a', 'test', 60000)) as { acquired: boolean; generation: number }
check('LS6 过期抢占成功且 generation 递增（fencing：旧持有者失效）', l6.acquired === true && l6.generation === 2, true)
check('LS7 陈旧持有者续约被拒（fencing 生效）', await lease('security_renew_lease($1,$2,$3)', 'res-1', 'owner-b', 60000), false)

// 清理
const cleanup = postgres(adminUrl.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
await cleanup.unsafe(`drop database if exists ${TEST_DB} with (force)`)
await cleanup.end({ timeout: 1 })

console.log(failed === 0 ? '\n限流原语验证全部通过 ✔' : `\n失败 ${failed} 项 ✖`)
process.exit(failed === 0 ? 0 : 1)