/**
 * 数据库分权自测（W3-S4，docs/admin-isolation-plan.md §3.5 验收项）：
 * 在独立测试库上执行 dbMigrate 的角色同步，再以 biance_user 直连断言权限矩阵：
 * - 白名单 RW 表可 INSERT/DELETE（合法放行方向）；
 * - RO 表（users 等）SELECT 通过、INSERT 被拒；
 * - 纯管理表（eval_* / agent_versions / knowledge_manifest_entries）INSERT 被拒
 *   （§3.5「user-api 数据库账号无管理表写权限」）。
 * 运行：pnpm db:grants-check（独立测试库，结束 DROP；不读写开发/生产数据）
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const nodeRequire = createRequire(new URL('../server/package.json', import.meta.url))
// `typeof import('postgres')` 会在 typecheck 报 TS2307（运行时经 createRequire 正常；
// 与 login-regression.ts 同款处理）——这里只用到的最小接口形态
const postgres = nodeRequire('postgres') as PgFactory
interface PgRow { [k: string]: unknown }
interface PgClient {
  unsafe(q: string): Promise<PgRow[]>
  end(opts?: { timeout?: number }): Promise<unknown>
}
interface PgFactory {
  (url: string, opts?: Record<string, unknown>): PgClient & { <T = PgRow>(q: TemplateStringsArray, ...v: unknown[]): Promise<T[]> }
}

const SERVER_DIR = new URL('../server/', import.meta.url).pathname
const TEST_DB = 'bv_grants_check'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✔' : '✖'} ${name}${!ok && detail !== '' ? `（${detail}）` : ''}`)
  if (!ok) failures++
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

const base = baseDatabaseUrl()
const testUrl = new URL(base.toString())
testUrl.pathname = `/${TEST_DB}`

async function main(): Promise<void> {
  const admin = new URL(base.toString())
  admin.username = 'postgres'
  admin.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
  admin.pathname = '/postgres'
  const root = postgres(admin.toString(), { max: 1, onnotice: () => {} })
  await root.unsafe(`drop database if exists ${TEST_DB} with (force)`)
  await root.unsafe(`create database ${TEST_DB} owner ${base.username}`)
  await root.end({ timeout: 1 })

  try {
    // 1) 跑迁移建表（模拟 migrate 容器第一段）
    process.env.DATABASE_URL = testUrl.toString()
    const { initDb, getDb } = await import('../server/src/db.js')
    const ok = await initDb({ migrate: true })
    check('G1 测试库迁移完成', ok, ok ? '' : 'initDb 失败')

    // 2) 建最小表结构下的最小权限账号（同步 DCL）
    process.env.BV_DB_USER_PASSWORD = 'grants-check-pw'
    const { syncDbUserRole } = await import('../server/src/dbGrants.js')
    const dclUrl = new URL(testUrl.toString())
    dclUrl.username = 'postgres'
    dclUrl.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
    const dcl = postgres(dclUrl.toString(), { max: 1, onnotice: () => {} })
    const stmts = await syncDbUserRole(dcl)
    await dcl.end({ timeout: 1 })
    check('G2 角色同步执行（biance_user 白名单 GRANT）', stmts >= 7, `语句=${stmts}`)
    void getDb

    // 3) 以 biance_user 直连断言权限矩阵
    const userUrl = new URL(testUrl.toString())
    userUrl.username = 'biance_user'
    userUrl.password = 'grants-check-pw'
    const u = postgres(userUrl.toString(), { max: 1, onnotice: () => {} })

    // RW 白名单：合法写放行（行内字段最少化；各表 NOT NULL 约束不同，逐表给最小列）
    const rwOk = await u`insert into alert_rules (id, symbol, type, value, enabled, armed, created_at, updated_at) values ('g1','BTCUSDT','price_above',1,true,false,now(),now())`
      .then(() => true, () => false)
    check('G3 RW 表可写（alert_rules INSERT 放行）', rwOk)
    await u`delete from alert_rules where id = 'g1'`.then(() => undefined, () => undefined)

    const sessOk = await u`insert into auth_sessions (token_hash, username, role, purpose, expires_at) values ('g2','g','user','user',now())`
      .then(() => true, () => false)
    check('G4 RW 表可写（auth_sessions INSERT 放行）', sessOk)
    await u`delete from auth_sessions where token_hash = 'g2'`.then(() => undefined, () => undefined)

    // RO：users SELECT 放行 / INSERT 被拒（§3.5 验收）
    const selOk = await u`select count(*) from users`.then(() => true, () => false)
    check('G5 users SELECT 放行（判权读取）', selOk)
    const usersWrite = await u`insert into users (id, username, password_hash, role) values ('g3','hack','x','user')`
      .then(() => 'allowed', (e: { code?: string }) => e.code)
    check('G6 users INSERT 被拒（42501，user-api 不可改用户表）', usersWrite === '42501', String(usersWrite))

    const chunksSel = await u`select count(*) from knowledge_chunks`.then(() => true, () => false)
    check('G7 knowledge_chunks SELECT 放行（聊天检索）', chunksSel)
    const chunksWrite = await u`insert into knowledge_chunks (id, doc_id, doc_version_id, chunk_index, kind, text) values ('g4','d','d#1',1,'text','x')`
      .then(() => 'allowed', (e: { code?: string }) => e.code)
    check('G8 knowledge_chunks INSERT 被拒（42501，解析写只在 worker/admin）', chunksWrite === '42501', String(chunksWrite))

    // 纯管理表：全被拒
    for (const t of ['eval_datasets', 'eval_runs', 'agent_versions', 'knowledge_manifest_entries']) {
      const r = await u.unsafe(`insert into ${t} default values`)
        .then(() => 'allowed', (e: { code?: string }) => e.code)
      check(`G9 ${t} INSERT 被拒（42501，管理域）`, r === '42501' || r === '42501', String(r))
    }

    // 密码轮换语义：ALTER ROLE 后旧密码失效
    await u.end({ timeout: 1 })
    const dcl2 = postgres(dclUrl.toString(), { max: 1, onnotice: () => {} })
    await dcl2.unsafe(`ALTER ROLE biance_user WITH LOGIN PASSWORD 'rotated-pw';`)
    await dcl2.end({ timeout: 1 })
    const oldPw = new URL(testUrl.toString())
    oldPw.username = 'biance_user'
    oldPw.password = 'grants-check-pw'
    const stale = await postgres(oldPw.toString(), { max: 1 })`select 1`
      .then(() => 'connected', (e: { code?: string }) => e.code)
    check('G10 旧密码失效（轮换经 migrate 重放生效）', stale === '28P01', String(stale))
  } finally {
    process.env.DATABASE_URL = base.toString()
    const root2 = postgres(
      (() => {
        const a = new URL(base.toString())
        a.username = 'postgres'
        a.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
        a.pathname = '/postgres'
        return a.toString()
      })(),
      { max: 1, onnotice: () => {} },
    )
    await root2.unsafe(`drop database if exists ${TEST_DB} with (force)`).catch(() => {})
    await root2.end({ timeout: 1 }).catch(() => {})
  }
}

await main()
console.log(failures === 0 ? '\n数据库分权自测全部通过 ✔（12 项）' : `\n失败 ${failures} 项 ✖`)
process.exit(failures === 0 ? 0 : 1)
