import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb } from '../db.js'
import { initUsers } from '../users.js'
import type { SessionRecord } from '../users.js'
import { getAiProfilesMasked, saveAiProfiles } from '../ai.js'
import { accessKey } from '../aiAccess.js'
import { recordAudit } from '../audit.js'
import { guardAdminMutation } from './mutationGuard.js'

const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode })

/**
 * 用户改名（2026-10-27）：业务表以用户名字符串为外键（users.id 从未被引用），
 * 改名 = 单事务内迁移全部关联。三条路径：真实 FK 子表走 0036 的 ON UPDATE CASCADE、
 * 无 FK 用户列走下方清单逐表 UPDATE、非表结构关联（app_settings 额度键 + ai-config
 * 档案绑定）单独迁移。清单即契约：
 *  - 数据库侧由 information_schema 实测比对，多出或缺失任一用户列即拒绝执行（fail-closed），
 *    新表带用户列必须同步登记此处与 scripts/user-rename-map-check.ts；
 *  - audit_records 有意不改写：操作审计是历史记录，保留改名前的用户名；
 *  - 非表结构关联两处同样迁移：app_settings 的 ai_access:<username> 额度键、
 *    ai-config.json 档案 allowedUsers 绑定（先行改绑、DB 失败补偿回滚，绑定到
 *    不存在的用户名不构成授权，见 provisionUsers.ts 同款补偿逻辑）。
 */
export const RENAME_COLUMN_MAP: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'auth_sessions', column: 'username' },
  { table: 'ai_conversations', column: 'username' },
  { table: 'ai_memories', column: 'username' },
  { table: 'conversations', column: 'user_id' },
  { table: 'research_runs', column: 'user_id' },
  { table: 'research_memories', column: 'user_id' },
  { table: 'event_quotes', column: 'user_id' },
  { table: 'portfolio_positions', column: 'user_id' },
  { table: 'predictions', column: 'user_id' },
  { table: 'trader_profiles', column: 'user_id' },
  { table: 'security_leases', column: 'owner' },
]

/**
 * 以真实外键引用 users(username) 的表（0036 迁移起 ON UPDATE CASCADE）：
 * 改名时只需 UPDATE users 本体，PG 自动级联这些子表，端点不手动迁移它们
 * （手动改会撞 FK 立即检查）。行数在级联前 SELECT 统计并随响应返回。
 */
export const CASCADE_FK_TABLES: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'membership_accounts', column: 'username' },
  { table: 'membership_usage', column: 'username' },
  { table: 'membership_reservations', column: 'username' },
  // 0037 起链式级联：users → accounts → grants/receipts/redemptions 一语句全迁
  { table: 'membership_grants', column: 'username' },
  { table: 'membership_receipts', column: 'username' },
  { table: 'membership_redemptions', column: 'username' },
]

/**
 * 清单中不经 drizzle ORM 定义（迁移建表 + 原生 SQL 维护）的表：
 * 静态门禁无法从 models.ts 验证它们，由改名时的 information_schema 实测兜底。
 * security_leases 当前零写入（多副本预留），owner 若未来存用户名同样会被正确迁移。
 */
export const NON_ORM_RENAME_TABLES: ReadonlySet<string> = new Set(['security_leases'])

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/
const renameInput = z.object({ to: z.string().regex(USERNAME_RE, '用户名需为 3~32 位字母 / 数字 / 下划线 / 连字符') }).strict()

/** ai-config 档案绑定迁移；返回是否有档案被触碰（用于失败补偿与审计） */
function rebindAiProfiles(from: string, to: string, operator: string): boolean {
  const profiles = getAiProfilesMasked()
  let touched = false
  const next = Object.fromEntries(
    Object.entries(profiles).map(([name, profile]) => {
      const allowed = profile.allowedUsers || []
      if (!allowed.includes(from)) return [name, profile]
      touched = true
      return [name, { ...profile, apiKey: profile.apiKeyMasked, allowedUsers: allowed.map(u => (u === from ? to : u)) }]
    }),
  )
  if (touched) saveAiProfiles({ profiles: next }, operator)
  return touched
}

async function assertSchemaMatchesMap(): Promise<void> {
  const db = getDb()
  if (!db) throw bad('账号存储不可用', 503)
  const rows = await db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('user_id', 'username', 'owner')
      AND table_name NOT IN ('users', 'audit_records')`)
  const discovered = new Set(rows.map(r => `${r.table_name}.${r.column_name}`))
  const expected = new Set([...RENAME_COLUMN_MAP, ...CASCADE_FK_TABLES].map(e => `${e.table}.${e.column}`))
  const unknown = [...discovered].filter(key => !expected.has(key))
  const stale = [...expected].filter(key => !discovered.has(key))
  if (unknown.length || stale.length) {
    const parts: string[] = []
    if (unknown.length) parts.push(`未登记：${unknown.join('、')}`)
    if (stale.length) parts.push(`已失效：${stale.join('、')}`)
    throw bad(`用户关联清单与数据库不一致，改名已阻止（${parts.join('；')}）。请更新 RENAME_COLUMN_MAP`, 503)
  }
}

export async function renameUser(from: string, to: string, operator: string): Promise<{ migrated: Record<string, number>; reboundProfiles: boolean }> {
  const db = getDb()
  if (!db) throw bad('账号存储不可用', 503)
  await assertSchemaMatchesMap()
  const reboundProfiles = rebindAiProfiles(from, to, operator)
  let migrated: Record<string, number> = {}
  try {
    migrated = await db.transaction(async tx => {
      // 双名互锁：与 provisionUser 的建号锁同名空间，避免并发建号/改名撞车
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provision:${from.toLowerCase()}`}, 0))`)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provision:${to.toLowerCase()}`}, 0))`)
      const dup = await tx.execute(sql`SELECT id FROM users WHERE lower(username) = ${to.toLowerCase()} LIMIT 1`)
      if (dup.length) throw bad('目标用户名已存在，请使用其他用户名', 409)
      const target = await tx.execute<{ role: string }>(sql`SELECT role FROM users WHERE username = ${from} LIMIT 1`)
      if (!target.length || target[0].role !== 'user') throw bad('仅可改名普通用户', 404)
      const counts: Record<string, number> = {}
      // FK 子表由 UPDATE users 的 ON UPDATE CASCADE 级联；先计行数供响应与校验
      for (const { table, column } of CASCADE_FK_TABLES) {
        const pre = await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${from}`)
        counts[`${table}.${column}`] = pre.length
      }
      await tx.execute(sql`UPDATE users SET username = ${to}, updated_at = now() WHERE username = ${from} AND role = 'user'`)
      for (const { table, column } of CASCADE_FK_TABLES) {
        const moved = await tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${to}`)
        if (moved.length !== counts[`${table}.${column}`]) throw bad(`级联迁移校验失败：${table}`, 500)
      }
      for (const { table, column } of RENAME_COLUMN_MAP) {
        const result = await tx.execute(
          sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${to} WHERE ${sql.identifier(column)} = ${from} RETURNING 1`,
        )
        counts[`${table}.${column}`] = result.length
      }
      const access = await tx.execute(
        sql`UPDATE app_settings SET key = ${accessKey(to)} WHERE key = ${accessKey(from)} RETURNING 1`,
      )
      counts['app_settings.ai_access'] = access.length
      return counts
    })
  } catch (error) {
    if (reboundProfiles) try { rebindAiProfiles(to, from, operator) } catch { /* 绑定不构成授权，留待人工核对 */ }
    throw error
  }
  await initUsers({ seed: false })
  return { migrated, reboundProfiles }
}

export function registerRenameUserRoutes(app: FastifyInstance, deps: { requireSuperadmin: (req: FastifyRequest) => SessionRecord }): void {
  app.post('/api/admin/users/:username/rename', { bodyLimit: 1024 }, async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    guardAdminMutation(req, session.username, 'rename-user', 5)
    const username = (req.params as { username: string }).username
    const parsed = renameInput.safeParse(req.body)
    if (!parsed.success) throw bad('新用户名需为 3~32 位字母 / 数字 / 下划线 / 连字符')
    const { migrated, reboundProfiles } = await renameUser(username, parsed.data.to, session.username)
    const touched = Object.entries(migrated).filter(([, n]) => n > 0)
    recordAudit(session, {
      action: 'settings_update',
      target: parsed.data.to,
      detail: `用户 ${username} 改名为 ${parsed.data.to}；迁移关联 ${touched.reduce((sum, [, n]) => sum + n, 0)} 行（${touched.map(([t, n]) => `${t}:${n}`).join('、') || '无'}）${reboundProfiles ? '；已迁移 AI 档案绑定' : ''}`,
    })
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache')
    return { from: username, to: parsed.data.to, migrated }
  })
}
