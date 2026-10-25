/**
 * chatPolicy 成功用量原子累计验证（P1-3/C，pnpm chat:usage-atomic-check）
 * ——真实 PG 独立测试库上的并发断言（方案 §14.4.1 P1-3/C 必需断言）：
 *   A1 同用户 20 并发 recordChatMessage → 计数精确 = 20（旧读改写在并发下丢计）
 *   A2 跨用户交错并发（u1/u2 各 20）→ 两个计数各自精确（不互相覆盖）
 *   A3 跨日重置与递增同语句：改 date 为昨日后再计数 → 计数从 1 重新起算
 *   A4 管理端读数（getChatUsageToday）与写入一致
 * 数据隔离：独立测试库 bv_chat_usage_atomic，结束 DROP；需 docker compose PG（5434）。
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

const TEST_DB = 'bv_chat_usage_atomic'

let failed = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `（期望 ${String(expected)}，实际 ${String(actual)}）`}`)
}

function baseDatabaseUrl(): URL {
  return new URL(process.env.DATABASE_URL ?? 'postgresql://biance_app:biance_app@127.0.0.1:5434/biance_vision')
}

const base = baseDatabaseUrl()
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
process.env.BV_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'bv-chat-usage-'))

const { initDb } = await import('../server/src/db.js')
if (!(await initDb({ migrate: true }))) throw new Error('测试库迁移失败')
const { recordChatMessage, getChatUsageToday } = await import('../server/src/chatPolicy.js')
const { getDb, sql } = await import('../server/src/db.js')

// A1 同用户并发
await Promise.all(Array.from({ length: 20 }, () => recordChatMessage('u-atomic-1')))
check('A1 同用户 20 并发 → 计数精确 20（原子递增不丢）', await getChatUsageToday('u-atomic-1'), 20)

// A2 跨用户交错并发
await Promise.all(Array.from({ length: 40 }, (_, i) => recordChatMessage(i % 2 === 0 ? 'u-atomic-2' : 'u-atomic-3')))
check('A2a 跨用户交错并发 u-atomic-2 → 20', await getChatUsageToday('u-atomic-2'), 20)
check('A2b 跨用户交错并发 u-atomic-3 → 20（整份覆盖互踩已消除）', await getChatUsageToday('u-atomic-3'), 20)

// A3 跨日重置与递增同语句：把 date 改成昨天，再计数 → 从 1 起算且 date 归今天
await getDb()!.execute(sql`UPDATE app_settings SET value = jsonb_set(value, '{date}', to_jsonb('2000-01-01'::text)) WHERE key = 'chat_usage'`)
check('A3a 改昨日后读数为 0', await getChatUsageToday('u-atomic-1'), 0)
await Promise.all([recordChatMessage('u-atomic-1'), recordChatMessage('u-atomic-1'), recordChatMessage('u-atomic-1')])
check('A3b 跨日后并发 3 次 → 新一天计数 3（重置+递增同语句）', await getChatUsageToday('u-atomic-1'), 3)
check('A3c 其他用户计数不因跨日残留（重置整体归零）', await getChatUsageToday('u-atomic-2'), 0)

// 清理
const cleanup = postgres(admin.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} })
await cleanup.unsafe(`drop database if exists ${TEST_DB} with (force)`)
await cleanup.end({ timeout: 1 })

console.log(failed === 0 ? '\nchatPolicy 原子累计验证全部通过 ✔' : `\n失败 ${failed} 项 ✖`)
process.exit(failed === 0 ? 0 : 1)
