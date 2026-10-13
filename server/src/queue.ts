/**
 * pg-boss 队列单例：app 与 worker 共用同一 PostgreSQL，队列表在独立 schema（QUEUE_SCHEMA）。
 * app 侧本阶段只入队不消费；DB 不可用时返回 null 并 warn，不阻断 app 启动。
 */
import PgBoss from 'pg-boss'
import { DATABASE_URL, isDbAvailable } from './db.js'
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

const ALL_QUEUES = [Q_INGEST, Q_BACKFILL, Q_FUNDING, Q_OI, Q_SWEEP_FAST, Q_SWEEP_SLOW, Q_KNOWLEDGE_PARSE, Q_RESEARCH_RUN, Q_EVENT_SETTLE, Q_EVAL_RUN, Q_MODEL_TRAIN]

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
    for (const name of ALL_QUEUES) await b.createQueue(name)
    boss = b
    log.ok('queue', `pg-boss 已启动`, kv({ schema: QUEUE_SCHEMA, 队列: ALL_QUEUES.length }))
    return b
  } catch (err) {
    log.warn('queue', 'pg-boss 启动失败（仅降级，不阻断进程）', kv({ 错误: (err as Error).message }))
    return null
  }
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
