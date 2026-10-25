/**
 * 诊断收件箱（P2a-1，方案 §9.2）：进程内有界缓冲 + 批量写 PG observability_inbox
 * 与错误聚合（observability_error_groups 经受控函数）。
 *
 * 可丢遥测边界（§3.0.3）：
 * - tryRecord 同步、有界、不抛错、不 await PG——诊断失败绝不改变业务结果；
 * - 队列上限 1,000 条 / 4 MiB，先到先丢（成功访问样本 → 行为埋点 → 重复错误的
 *   丢弃顺序在入队策略侧体现；本层先到先丢+重复指纹合并）；
 * - 每 5 秒或 100 条批量 flush，一次 PG 批处理；失败重试 2 次后熔断 30 秒；
 * - 丢弃计数与最后写入时间可查（P2a-4 管理端展示）；不上报"上报失败"事件防递归。
 * - stop() 幂等：flush 最多等 2 秒，未落盘记丢弃。
 */
import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb, isDbAvailable } from '../db.js'
import { sanitizeForLog } from '../security/logProjection.js'
import { record } from '../logger.js'

const MAX_QUEUE_ITEMS = 1000
const MAX_QUEUE_BYTES = 4 * 1024 * 1024
const FLUSH_INTERVAL_MS = 5_000
const FLUSH_BATCH = 100
const RETRY_LIMIT = 2
const CIRCUIT_MS = 30_000
const SAMPLE_MAX_BYTES = 4096

export interface DiagnosticEvent {
  kind: string
  requestId?: string
  originRequestId?: string
  payload: Record<string, unknown>
}

interface QueuedEvent extends DiagnosticEvent {
  eventId: string
  source: 'server' | 'browser'
  purpose: 'user' | 'admin'
  subjectHash: string
  fingerprint?: string
  bytes: number
}

export interface SinkStats {
  queued: number
  dropped: number
  lastFlushAt: number | null
  lastErrorAt: number | null
  circuitOpenUntil: number
}

let queue: QueuedEvent[] = []
let queueBytes = 0
let dropped = 0
let flushTimer: NodeJS.Timeout | null = null
let flushing = false
let circuitOpenUntil = 0
let lastErrorAt: number | null = null
let lastFlushAt: number | null = null
let started = false

function enqueue(evt: QueuedEvent): void {
  if (queue.length >= MAX_QUEUE_ITEMS || queueBytes + evt.bytes > MAX_QUEUE_BYTES) {
    dropped += 1
    return
  }
  queue.push(evt)
  queueBytes += evt.bytes
}

/**
 * 记录一条诊断（同步不抛）：kind 如 http_error/security_event/access_sample；
 * fingerprint 非空时同时聚合到 error_groups（服务端错误的指纹=公开 code+错误类型，
 * 由调用方构造——不含动态 ID/原始 message 变量，§9.4）。
 */
export function tryRecord(
  purpose: 'user' | 'admin',
  subject: string,
  evt: DiagnosticEvent,
  opts: { fingerprint?: string } = {},
): void {
  if (!started) start()
  const payloadText = JSON.stringify(sanitizeForLog(evt.payload))
  enqueue({
    ...evt,
    eventId: crypto.randomUUID(),
    source: 'server',
    purpose,
    // 诊断存储主体走哈希（与限流同一 HMAC 口径；IP/用户名不落原文，§9.1）
    subjectHash: `${subject.length}:${crypto.createHash('sha256').update(subject).digest('hex').slice(0, 32)}`,
    fingerprint: opts.fingerprint,
    bytes: payloadText.length > SAMPLE_MAX_BYTES ? SAMPLE_MAX_BYTES : payloadText.length,
  })
}

/**
 * 浏览器事件入口（P2a-3）：source='browser'，eventId 由客户端生成（去重键），
 * 服务端不重新生成——伪造 eventId 只能覆盖同 (source,purpose,subject,eventId)
 * 的自己记录，不能覆盖其他来源。payload 已由端点按白名单校验。
 */
export function tryRecordBrowser(
  purpose: 'user' | 'admin',
  subject: string,
  evt: DiagnosticEvent & { eventId: string },
): void {
  if (!started) start()
  const payloadText = JSON.stringify(sanitizeForLog(evt.payload))
  enqueue({
    ...evt,
    source: 'browser',
    purpose,
    subjectHash: `${subject.length}:${crypto.createHash('sha256').update(subject).digest('hex').slice(0, 32)}`,
    bytes: payloadText.length > SAMPLE_MAX_BYTES ? SAMPLE_MAX_BYTES : payloadText.length,
  })
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return
  if (Date.now() < circuitOpenUntil) return
  flushing = true
  const batch = queue.splice(0, FLUSH_BATCH)
  for (const e of batch) queueBytes -= e.bytes
  let attempt = 0
  while (true) {
    try {
      const db = getDb()
      if (db !== null && isDbAvailable()) {
        for (const e of batch) {
          await db.execute(sql`
            INSERT INTO observability_inbox (source, purpose, subject_hash, event_id, kind, request_id, origin_request_id, payload)
            VALUES ('server', ${e.purpose}, ${e.subjectHash}, ${e.eventId}, ${e.kind},
              ${e.requestId ?? null}, ${e.originRequestId ?? null},
              ${JSON.stringify(sanitizeForLog(e.payload))}::jsonb)
            ON CONFLICT DO NOTHING`)
          if (e.fingerprint !== undefined) {
            await db.execute(sql`SELECT observability_upsert_error_group(${e.fingerprint}, 'unknown', 'server', ${JSON.stringify(sanitizeForLog(e.payload))}::jsonb)`)
          }
        }
        lastFlushAt = Date.now()
      }
      break
    } catch {
      attempt += 1
      if (attempt > RETRY_LIMIT) {
        dropped += batch.length
        lastErrorAt = Date.now()
        circuitOpenUntil = Date.now() + CIRCUIT_MS
        record({ level: 'warn', tag: 'observability', message: '诊断写入失败（本批丢弃，熔断 30s）', attributes: { 批大小: batch.length } })
        break
      }
    }
  }
  flushing = false
}

/** 启动周期 flush（幂等）；组合根调用 */
export function startDiagnosticSink(): void {
  start()
}

function start(): void {
  if (started) return
  started = true
  flushTimer = setInterval(() => {
    void flush()
  }, FLUSH_INTERVAL_MS)
  flushTimer.unref()
}

/** 停止并尽力 flush（≤2s）；幂等。 */
export async function stopDiagnosticSink(): Promise<void> {
  if (!started) return
  if (flushTimer !== null) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  const deadline = Date.now() + 2000
  while (queue.length > 0 && Date.now() < deadline) {
    await flush().catch(() => {})
  }
  if (queue.length > 0) {
    dropped += queue.length
    queue = []
    queueBytes = 0
  }
  started = false
}

/** 当前状态（管理端/测试） */
export function diagnosticSinkStats(): SinkStats & { queueItems: number } {
  return { queueItems: queue.length, queued: queueBytes, dropped, lastFlushAt, lastErrorAt, circuitOpenUntil }
}
