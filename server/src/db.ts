import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { sql } from 'drizzle-orm'
import { alertHistory, alertRules, appSettings } from './models.js'
import type { NewAlertHistoryRow, NewAlertRuleRow } from './models.js'
import type { AlertEntry, AlertRule, RuleType, Settings } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_FOLDER = path.join(__dirname, '..', 'drizzle')

/** 轻量 .env 读取（server/.env 存在时生效，不引入 dotenv 依赖） */
function loadDotEnv(file: string): void {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  } catch {
    /* 无 .env 则使用默认值 */
  }
}
loadDotEnv('.env')

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://biance_app:biance_app@127.0.0.1:5434/biance_vision'

export const HISTORY_KEEP = 200

type Db = ReturnType<typeof drizzle>
let db: Db | null = null
let available = false

export function isDbAvailable(): boolean {
  return available
}

/** 连接 + 自动执行迁移；失败则降级为纯 JSON 存储 */
export async function initDb(): Promise<boolean> {
  let client: postgres.Sql | null = null
  try {
    client = postgres(DATABASE_URL, { max: 5, connect_timeout: 3, idle_timeout: 20 })
    await client`select 1`
    const conn = drizzle(client, { schema: { alertRules, alertHistory, appSettings } })
    await migrate(conn, { migrationsFolder: MIGRATIONS_FOLDER })
    db = conn
    available = true
    console.log(`[db] PostgreSQL 已连接：${DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')}`)
    return true
  } catch (err) {
    available = false
    db = null
    try {
      await client?.end({ timeout: 1 })
    } catch {
      /* noop */
    }    console.warn(
      `[db] PostgreSQL 不可用（${(err as Error).message}），降级为 JSON 文件存储；docker compose up -d 可启用`,
    )
    return false
  }
}

// ---- 领域对象 ↔ 表行 映射（领域层时间统一用毫秒时间戳） ----

const ruleToRow = (r: AlertRule): NewAlertRuleRow => ({
  id: r.id,
  symbol: r.symbol,
  type: r.type,
  value: r.value,
  note: r.note,
  enabled: r.enabled,
  armed: r.armed,
  createdAt: new Date(r.createdAt),
  updatedAt: new Date(r.updatedAt),
  lastTriggeredAt: r.lastTriggeredAt !== null ? new Date(r.lastTriggeredAt) : null,
})

const rowToRule = (row: {
  id: string
  symbol: string
  type: string
  value: number
  note: string
  enabled: boolean
  armed: boolean
  createdAt: Date
  updatedAt: Date
  lastTriggeredAt: Date | null
}): AlertRule => ({
  id: row.id,
  symbol: row.symbol,
  type: row.type as RuleType,
  value: row.value,
  note: row.note,
  enabled: row.enabled,
  armed: row.armed,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
  lastTriggeredAt: row.lastTriggeredAt !== null ? row.lastTriggeredAt.getTime() : null,
})

const entryToRow = (e: AlertEntry): NewAlertHistoryRow => ({
  id: e.id,
  ruleId: e.ruleId ?? null,
  symbol: e.symbol,
  type: e.type ?? null,
  value: e.value ?? null,
  note: e.note ?? null,
  message: e.message,
  price: e.price,
  changePct: e.changePct,
  triggeredAt: new Date(e.triggeredAt),
})

const rowToEntry = (row: {
  id: string
  ruleId: string | null
  symbol: string
  type: string | null
  value: number | null
  note: string | null
  message: string
  price: number
  changePct: number
  triggeredAt: Date
}): AlertEntry => ({
  id: row.id,
  ruleId: row.ruleId ?? undefined,
  symbol: row.symbol,
  type: (row.type as RuleType | null) ?? undefined,
  value: row.value ?? undefined,
  note: row.note ?? undefined,
  message: row.message,
  price: row.price,
  changePct: row.changePct,
  triggeredAt: row.triggeredAt.getTime(),
})

// ---- 数据访问（全部 fire-and-forget 友好，内部吞错并打日志） ----

const guard = (): Db | null => {
  if (!available || !db) return null
  return db
}

export async function loadAllFromDb(): Promise<{
  rules: AlertRule[]
  history: AlertEntry[]
  settings: Settings
} | null> {
  const conn = guard()
  if (!conn) return null
  const [ruleRows, historyRows, settingRows] = await Promise.all([
    conn.select().from(alertRules),
    conn.select().from(alertHistory).orderBy(sql`triggered_at desc`).limit(HISTORY_KEEP),
    conn.select().from(appSettings).where(sql`key = 'app'`),
  ])
  const settings: Settings =
    settingRows.length > 0 && typeof settingRows[0].value.webhookUrl === 'string'
      ? { webhookUrl: settingRows[0].value.webhookUrl }
      : { webhookUrl: '' }
  return {
    rules: ruleRows.map(rowToRule),
    history: historyRows.map(rowToEntry).reverse(), // 内存中按新→旧排列
    settings,
  }
}

/** 规则全量替换（规则量级小，简单可靠） */
export async function persistRules(rules: AlertRule[]): Promise<void> {
  const conn = guard()
  if (!conn) return
  await conn.transaction(async (tx) => {
    await tx.delete(alertRules)
    if (rules.length) await tx.insert(alertRules).values(rules.map(ruleToRow))
  })
}

/** 追加触发历史（按 id 幂等，重复无副作用） */
export async function appendHistory(entries: AlertEntry[]): Promise<void> {
  const conn = guard()
  if (!conn || entries.length === 0) return
  await conn.insert(alertHistory).values(entries.map(entryToRow)).onConflictDoNothing()
  await conn.execute(
    sql`delete from alert_history where id not in (select id from alert_history order by triggered_at desc limit ${HISTORY_KEEP})`,
  )
}

/** 把数据库缺失的历史补进去（数据库宕机期间写入 JSON 的部分） */
export async function mergeMissingHistory(entries: AlertEntry[]): Promise<void> {
  const conn = guard()
  if (!conn || entries.length === 0) return
  await conn.insert(alertHistory).values(entries.map(entryToRow)).onConflictDoNothing()
}

export async function persistSettings(s: Settings): Promise<void> {
  const conn = guard()
  if (!conn) return
  await conn
    .insert(appSettings)
    .values({ key: 'app', value: { webhookUrl: s.webhookUrl } })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: { webhookUrl: s.webhookUrl } } })
}
