import { randomUUID } from 'node:crypto'
import { boolean, doublePrecision, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** 预警规则（type 对应 server/src/types.ts 的 RuleType） */
export const alertRules = pgTable('alert_rules', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  symbol: text('symbol').notNull(),
  type: text('type').notNull(),
  value: doublePrecision('value').notNull(),
  note: text('note').notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  /** 边缘触发布防状态：true 时条件满足才会触发 */
  armed: boolean('armed').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** 最后修改时间（毫秒语义），用于数据库恢复后与 JSON 镜像做新旧合并 */
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
})

/** 预警触发历史（保留最近 200 条，与 JSON 镜像一致） */
export const alertHistory = pgTable(
  'alert_history',
  {
    id: text('id').primaryKey(),
    ruleId: text('rule_id'),
    symbol: text('symbol').notNull(),
    type: text('type'),
    value: doublePrecision('value'),
    note: text('note'),
    message: text('message').notNull(),
    price: doublePrecision('price').notNull(),
    changePct: doublePrecision('change_pct').notNull(),
    triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('alert_history_triggered_at_idx').on(table.triggeredAt)],
)

/** 应用设置：key-value（jsonb），当前仅 webhook */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  insertedAt: timestamp('inserted_at', { withTimezone: true }).notNull().defaultNow(),
})

/** 登录用户（role 对应 server/src/users.ts 的 UserRole；密码只存 scrypt 哈希） */
export const users = pgTable('users', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
/**
 * 操作审计记录（会话聚合式）：一次登录 = 一条记录，登录后的全部操作
 * 追加在 actions JSON 里；登录失败是无会话的独立事件记录。
 * id 由应用生成，JSON 镜像与数据库共用；保留最近 AUDIT_KEEP 条。
 */
export const auditRecords = pgTable(
  'audit_records',
  {
    id: text('id').primaryKey(),
    /** 'session'：登录会话；'login_failed'：登录失败事件 */
    kind: text('kind').notNull(),
    /** 会话 token 的 sha256 前缀：重启后据此把新操作挂回原会话 */
    sessionKey: text('session_key').notNull().default(''),
    username: text('username').notNull(),
    ip: text('ip').notNull().default(''),
    userAgent: text('user_agent').notNull().default(''),
    /** 会话 = 登录时间；失败事件 = 发生时间 */
    at: timestamp('at', { withTimezone: true }).notNull(),
    /** 会话结束时间（登出）；null = 仍在进行或未封存 */
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** 会话内操作时间线（失败事件为空数组），按时间正序 */
    actions: jsonb('actions').$type<unknown[]>().notNull(),
    /** 最后活动时间：列表排序与裁剪依据 */
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('audit_records_last_active_at_idx').on(table.lastActiveAt)],
)

export type AlertRuleRow = typeof alertRules.$inferSelect
export type NewAlertRuleRow = typeof alertRules.$inferInsert
export type AlertHistoryRow = typeof alertHistory.$inferSelect
export type NewAlertHistoryRow = typeof alertHistory.$inferInsert
export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
export type AuditRecordRow = typeof auditRecords.$inferSelect
export type NewAuditRecordRow = typeof auditRecords.$inferInsert
