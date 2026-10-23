/**
 * 独立迁移入口（W3-S2，docs/admin-isolation-plan.md §3.2）：
 * 生产 compose 的 migrate 一次性容器执行本文件（`node server/dist/dbMigrate.js`），
 * app/worker 以 BV_AUTO_MIGRATE=0 启动不再承担 DDL——为 S3/S4 双进程铺路。
 * 本地开发/脚本直接跑 initDb() 仍自动迁移（缺省行为不变）。
 */
import './env.js'
import { log } from './logger.js'
import { initDb } from './db.js'

const ok = await initDb({ migrate: true })
if (!ok) {
  log.error('migrate', '数据库不可用，迁移失败（退出码 1，compose 视为失败阻止后续启动）')
  process.exit(1)
}
log.ok('migrate', '数据库迁移完成')
