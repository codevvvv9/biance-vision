/**
 * pg-boss 队列单例：app 与 worker 共用同一 PostgreSQL，队列表在独立 schema（QUEUE_SCHEMA）。
 * app 侧本阶段只入队不消费；DB 不可用时返回 null 并 warn，不阻断 app 启动。
 */
import { sql } from 'drizzle-orm'
import PgBoss from 'pg-boss'
import { DATABASE_URL, getDb, isDbAvailable } from './db.js'
import { kv, log } from './logger.js'

export const QUEUE_SCHEMA = process.env.QUEUE_SCHEMA ?? 'pgboss'

/** 队列名常量（worker 消费；sweep 是周期调度的扇出入口） */
export const Q_INGEST = 'market:ingest'
export const Q_BACKFILL = 'market:backfill'
export const Q_FUNDING = 'market:funding'
export const Q_OI = 'market:oi'
export const Q_SWEEP_FAST = 'market:sweep-fast'
export const Q_SWEEP_SLOW = 'market:sweep-slow'
export const Q_KNOWLEDGE_PARSE = 'knowledge:parse'
export const Q_RESEARCH_RUN = 'research:run'
export const Q_EVENT_SETTLE = 'event:settle'
export const Q_EVAL_RUN = 'eval:run'
export const Q_MODEL_TRAIN = 'model:train'

const ALL_QUEUES = [Q_INGEST, Q_BACKFILL, Q_FUNDING, Q_OI, Q_SWEEP_FAST, Q_SWEEP_SLOW, Q_KNOWLEDGE_PARSE, Q_RESEARCH_RUN, Q_EVENT_SETTLE, Q_EVAL_RUN, Q_MODEL_TRAIN,
  // P2a/P2b 内部观测调度队列（boss.schedule 外键要求队列先建；createQueue 幂等）
  'observability:cleanup', 'observability:aggregate', 'observability:alert']

/**
 * 队列级配置（单一数据源，属主知识在本文件）：
 * market:* 是「冗余指令型」队列——sweep 周期性按 singleton 时间桶重下发同 key 指令，
 * 陈旧 created 任务过期作废零损失（2026-10-25 教训：market:ingest 停摆 16h 积压 3.7 万条，
 * pg-boss fetch 吞错导致无告警静默堆积）。retentionMinutes 由 pg-boss maintenance 兜底：
 * created 超 keep_until 自动归档、completed 行及时出队列表；行情数据完整性不受影响
 * （游标续采 + 缺口回补独立兜底，停摆 8h 已实测零缺口恢复）。
 * 知识库/研究/评测/训练队列的任务珍贵（一任务=一份用户工作），绝不配置自动过期。
 */
export const QUEUE_OPTIONS: Record<string, { retentionMinutes: number }> = {
  [Q_INGEST]: { retentionMinutes: 30 },
  [Q_BACKFILL]: { retentionMinutes: 60 },
  [Q_FUNDING]: { retentionMinutes: 90 },
  [Q_OI]: { retentionMinutes: 90 },
  [Q_SWEEP_FAST]: { retentionMinutes: 15 },
  [Q_SWEEP_SLOW]: { retentionMinutes: 15 },
}

/** 允许手动清理积压的队列白名单 = 冗余指令型集合（服务端强制；珍贵队列清理入口一律拒绝） */
export function purgeableQueues(): string[] {
  return Object.keys(QUEUE_OPTIONS)
}

let boss: PgBoss | null = null

export function getBoss(): PgBoss | null {
  return boss
}

/** 启动队列并确保队列存在（幂等）；失败返回 null（仅 warn） */
export async function startQueue(): Promise<PgBoss | null> {
  if (boss) return boss
  if (!isDbAvailable()) {
    log.warn('queue', 'PostgreSQL 不可用，队列不启动')
    return null
  }
  try {
    const b = new PgBoss({
      connectionString: DATABASE_URL,
      schema: QUEUE_SCHEMA,
      retryLimit: 2,
      retryBackoff: true,
      retryDelay: 30,
    })
    b.on('error', (err: Error) => log.error('queue', 'pg-boss error:', err))
    await b.start()
    for (const name of ALL_QUEUES) {
      await b.createQueue(name)
      // createQueue 对已存在队列是 ON CONFLICT DO NOTHING（选项被忽略），配置生效必须走 updateQueue（COALESCE 仅更新给出字段）
      const options = QUEUE_OPTIONS[name]
      if (options) await b.updateQueue(name, { name, ...options })
    }
    boss = b
    log.ok('queue', `pg-boss 已启动`, kv({ schema: QUEUE_SCHEMA, 队列: ALL_QUEUES.length }))
    return b
  } catch (err) {
    log.warn('queue', 'pg-boss 启动失败（仅降级，不阻断进程）', kv({ 错误: (err as Error).message }))
    return null
  }
}

// ---------------------------------------------------------------------------
// 队列健康查询与受限清理（管理端 /api/admin/queue-health|queue-purge 专用；
// pgboss 表无 drizzle schema，走参数化原生 SQL，schema 名来自本文件常量不可注入）
// ---------------------------------------------------------------------------

export interface QueueHealthRow {
  name: string
  created: number
  active: number
  retry: number
  completed: number
  failed: number
  /** 最老 created 任务的滞留秒数（无积压为 null） */
  oldestCreatedAgeSeconds: number | null
  retentionMinutes: number | null
  purgeable: boolean
}

/** 全队列状态快照：queue 表（队列真源，含零任务队列）为底 + job 表计数叠加 */
export async function queueHealthSnapshot(): Promise<QueueHealthRow[]> {
  const db = getDb()
  if (!db) throw new Error('数据库不可用')
  const configs = await db.execute(sql`
    SELECT name, retention_minutes FROM ${sql.raw(QUEUE_SCHEMA)}.queue`)
  const jobs = await db.execute(sql`
    SELECT name,
      count(*) FILTER (WHERE state = 'created') AS created,
      count(*) FILTER (WHERE state = 'active') AS active,
      count(*) FILTER (WHERE state = 'retry') AS retry,
      count(*) FILTER (WHERE state = 'completed') AS completed,
      count(*) FILTER (WHERE state = 'failed') AS failed,
      extract(epoch FROM (now() - min(start_after) FILTER (WHERE state = 'created')))::int AS oldest_age
    FROM ${sql.raw(QUEUE_SCHEMA)}.job GROUP BY name`)
  const purgeable = new Set(purgeableQueues())
  const byName = new Map<string, QueueHealthRow>()
  for (const r of configs as unknown as Record<string, unknown>[]) {
    const retention = r.retention_minutes === null || r.retention_minutes === undefined ? null : Number(r.retention_minutes)
    byName.set(String(r.name), {
      name: String(r.name),
      created: 0, active: 0, retry: 0, completed: 0, failed: 0,
      oldestCreatedAgeSeconds: null,
      retentionMinutes: retention,
      purgeable: purgeable.has(String(r.name)),
    })
  }
  for (const r of jobs as unknown as Record<string, unknown>[]) {
    const row = byName.get(String(r.name))
    if (!row) continue // queue 表缺失的孤儿任务行不进管理视图
    row.created = Number(r.created); row.active = Number(r.active); row.retry = Number(r.retry)
    row.completed = Number(r.completed); row.failed = Number(r.failed)
    row.oldestCreatedAgeSeconds = r.oldest_age === null || r.oldest_age === undefined ? null : Number(r.oldest_age)
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 清理指定冗余队列的陈旧 created 积压（白名单在调用方强制）；返回删除条数 */
export async function purgeQueueBacklog(queue: string, olderThanMinutes: number): Promise<number> {
  const db = getDb()
  if (!db) throw new Error('数据库不可用')
  const result = await db.execute(sql`
    DELETE FROM ${sql.raw(QUEUE_SCHEMA)}.job
    WHERE name = ${queue} AND state = 'created'
      AND created_on < now() - make_interval(mins => ${Math.trunc(olderThanMinutes)})`)
  return Number((result as unknown as { count?: number }).count ?? 0)
}

/** 指定队列 created 积压数（worker 周期自检告警用） */
export async function countCreatedBacklog(queue: string): Promise<number> {
  const db = getDb()
  if (!db) return 0
  const rows = await db.execute(sql`
    SELECT count(*) AS n FROM ${sql.raw(QUEUE_SCHEMA)}.job
    WHERE name = ${queue} AND state = 'created'`)
  return Number((rows as unknown as Record<string, unknown>[])[0]?.n ?? 0)
}

export async function stopQueue(): Promise<void> {
  if (!boss) return
  try {
    await boss.stop({ graceful: true, timeout: 5000 })
  } catch (err) {
    log.warn('queue', 'pg-boss 停止异常', kv({ 错误: (err as Error).message }))
  }
  boss = null
}
