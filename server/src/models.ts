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

export type AlertRuleRow = typeof alertRules.$inferSelect
export type NewAlertRuleRow = typeof alertRules.$inferInsert
export type AlertHistoryRow = typeof alertHistory.$inferSelect
export type NewAlertHistoryRow = typeof alertHistory.$inferInsert
