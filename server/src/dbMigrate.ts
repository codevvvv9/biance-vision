/**
 * 独立迁移入口（W3-S2，docs/admin-isolation-plan.md §3.2）：
 * 生产 compose 的 migrate 一次性容器执行本文件（`node server/dist/dbMigrate.js`），
 * app/worker 以 BV_AUTO_MIGRATE=0 启动不再承担 DDL——为 S3/S4 双进程铺路。
 * 本地开发/脚本直接跑 initDb() 仍自动迁移（缺省行为不变）。
 */
import './env.js'
import { log, kv } from './logger.js'
import { databaseUrl, initDb } from './db.js'
import { syncDbUserRole } from './dbGrants.js'
import { initUsers } from './users.js'

const ok = await initDb({ migrate: true })
if (!ok) {
  log.error('migrate', '数据库不可用，迁移失败（退出码 1，compose 视为失败阻止后续启动）')
  process.exit(1)
}
log.ok('migrate', '数据库迁移完成')

// W3-S4：user-api 最小权限账号同步（幂等；密码经 BV_DB_USER_PASSWORD 注入）。
// 用原生连接执行 DCL（drizzle execute 面向参数化 DML，不适配这里的批量 GRANT）
try {
  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const nodeRequire = createRequire(fileURLToPath(import.meta.url))
  const postgres = nodeRequire('postgres') as typeof import('postgres')
  const { databaseUrl } = await import('./db.js')
  // DCL（CREATE ROLE/GRANT）需要 CREATEROLE——用超管连接，仅存在于本迁移容器进程内；
  // 显式 env 优先（BV_DCL_DATABASE_URL），缺省从 DATABASE_URL 推导（同库换 postgres 账号）
  const dclUrl = (() => {
    if (process.env.BV_DCL_DATABASE_URL !== undefined) return process.env.BV_DCL_DATABASE_URL
    const u = new URL(databaseUrl())
    u.username = 'postgres'
    u.password = process.env.PG_SUPER_PASSWORD ?? 'postgres'
    return u.toString()
  })()
  const client = postgres(dclUrl, { max: 1, onnotice: () => {} })
  try {
    const n = await syncDbUserRole(client)
    log.ok('migrate', '数据库账号分权已同步（biance_user 白名单）', kv({ 语句: n }))
  } finally {
    await client.end({ timeout: 1 })
  }
} catch (err) {
  log.error('migrate', '账号分权同步失败（退出码 1）', (err as Error))
  process.exit(1)
}

// W3-S4：内置账号种子移入迁移容器（首启表空时写 seed；app/admin-api 只加载不种子）
try {
  await initUsers({ seed: true })
} catch (err) {
  log.error('migrate', '内置账号种子写入失败（退出码 1）', (err as Error))
  process.exit(1)
}
