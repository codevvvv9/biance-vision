/**
 * 最小错误遥测 SDK（P2a-3，方案 §10）：只采集 client_error（全局 error/
 * unhandledrejection + ErrorBoundary 经 reportClientError）与 operation_failed
 * （业务 catch 显式上报）。产品行为/性能事件不在本批。
 *
 * 纪律（§10.2/§3.0.3）：
 * - 监听由单一实例持有；start/stop 幂等，stop 清全部监听/计时器与队列；
 * - 队列有界（100 条/256KiB）；每 10s 或 20 条 flush；页面隐藏尽力 flush
 *   （keepalive fetch 带 X-CSRF-Token——不为 sendBeacon 缺头而豁免 CSRF）；
 * - 同指纹错误 60s 合并（防雪崩）；传输失败不重试不递归、不改业务 Promise；
 * - 不覆写 fetch/console/原型；不持有 Cookie/token（CSRF token 只在内存）；
 * - 跨账号/登出：丢旧主体队列（调用方在登出回调调 resetSubject）。
 */
import { ApiError } from '../api'

interface QueuedEvent {
  eventId: string
  name: 'client_error' | 'operation_failed'
  occurredAt: string
  properties: Record<string, string | number | boolean>
  diagnostic?: { errorType: string; stack?: string }
}

interface SdkConfig {
  pageId: string
  release?: string
}

const QUEUE_MAX = 100
const QUEUE_MAX_BYTES = 256 * 1024
const FLUSH_INTERVAL_MS = 10_000
const FLUSH_BATCH = 20
const FINGERPRINT_WINDOW_MS = 60_000

let started = false
let config: SdkConfig | null = null
let csrfToken: string | null = null
let csrfExpiresAt = 0
let queue: QueuedEvent[] = []
let queueBytes = 0
let droppedClientSide = 0
let flushTimer: ReturnType<typeof setInterval> | null = null
let onError: ((ev: ErrorEvent) => void) | null = null
let onRejection: ((ev: PromiseRejectionEvent) => void) | null = null
let onVisibility: (() => void) | null = null
const fingerprintLastAt = new Map<string, number>()

function uuid(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function refreshCsrf(): Promise<void> {
  if (csrfToken !== null && Date.now() < csrfExpiresAt - 60_000) return
  try {
    const res = await fetch('/api/auth/csrf', { headers: { 'accept': 'application/json' } })
    if (res.ok) {
      const body = (await res.json()) as { token?: string; expiresAt?: string }
      if (typeof body.token === 'string') {
        csrfToken = body.token
        csrfExpiresAt = body.expiresAt !== undefined ? Date.parse(body.expiresAt) : Date.now() + 25 * 60_000
      }
    }
  } catch {
    /* 取不到 token：本批丢弃（下次再试），不影响业务 */
  }
}

function enqueue(evt: QueuedEvent): void {
  if (queue.length >= QUEUE_MAX || queueBytes + JSON.stringify(evt).length > QUEUE_MAX_BYTES) {
    droppedClientSide += 1
    return
  }
  queue.push(evt)
  queueBytes += JSON.stringify(evt).length
  if (queue.length >= FLUSH_BATCH) void flush()
}

function fingerprintOf(err: Error): string {
  return `${err.name}:${err.message.slice(0, 120)}`
}

function recordError(err: Error, context: Record<string, string | number | boolean> = {}): void {
  if (config === null) return
  const fp = fingerprintOf(err)
  const last = fingerprintLastAt.get(fp) ?? 0
  if (Date.now() - last < FINGERPRINT_WINDOW_MS) return // 同指纹 60s 合并
  fingerprintLastAt.set(fp, Date.now())
  if (fingerprintLastAt.size > 200) fingerprintLastAt.clear() // 防指纹表无界
  enqueue({
    eventId: uuid(),
    name: 'client_error',
    occurredAt: new Date().toISOString(),
    properties: { pageId: config.pageId, ...context },
    diagnostic: { errorType: err.name.slice(0, 64), stack: err.stack === undefined ? undefined : err.stack.slice(0, 2048) },
  })
}

/** 业务操作失败显式上报（已知 UI 操作的 catch 里调用；后端 requestId 用于关联） */
export function reportOperationFailed(actionId: string, err: unknown): void {
  if (config === null) return
  const props: Record<string, string | number | boolean> = { actionId, pageId: config.pageId }
  if (err instanceof ApiError) {
    props.publicCode = err.code ?? 'unknown'
    if (err.requestId !== null) props.requestId = err.requestId
  }
  enqueue({ eventId: uuid(), name: 'operation_failed', occurredAt: new Date().toISOString(), properties: props })
}

async function flush(): Promise<void> {
  if (queue.length === 0) return
  await refreshCsrf()
  if (csrfToken === null) {
    droppedClientSide += queue.length
    queue = []
    queueBytes = 0
    return
  }
  const batch = queue.splice(0, FLUSH_BATCH)
  for (const e of batch) queueBytes -= JSON.stringify(e).length
  const events = batch.map((e) => ({
    eventId: e.eventId,
    name: e.name,
    occurredAt: e.occurredAt,
    properties: e.properties,
    ...(e.diagnostic !== undefined ? { diagnostic: e.diagnostic } : {}),
  }))
  try {
    // 失败静默（本页内最多重试 0 次：丢批计数，不递归上报）
    const res = await fetch('/api/telemetry/batch', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ schemaVersion: 1, events }),
    })
    if (!res.ok) droppedClientSide += events.length
  } catch {
    droppedClientSide += events.length
  }
}

/** 启动（幂等）：注册全局错误监听与周期 flush */
export function startTelemetry(opts: SdkConfig): void {
  if (started) return
  started = true
  config = opts
  onError = (ev: ErrorEvent): void => { recordError(ev.error ?? new Error(ev.message)) }
  onRejection = (ev: PromiseRejectionEvent): void => {
    recordError(ev.reason instanceof Error ? ev.reason : new Error(String(ev.reason).slice(0, 200)))
  }
  onVisibility = (): void => { if (document.visibilityState === 'hidden') void flush() }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  document.addEventListener('visibilitychange', onVisibility)
  flushTimer = setInterval(() => { void flush() }, FLUSH_INTERVAL_MS)
}

/** 停止（幂等）：清监听/计时器并尽力 flush（≤2s 语义由 keepalive 承担） */
export function stopTelemetry(): void {
  if (!started) return
  started = false
  if (onError !== null) window.removeEventListener('error', onError)
  if (onRejection !== null) window.removeEventListener('unhandledrejection', onRejection)
  if (onVisibility !== null) document.removeEventListener('visibilitychange', onVisibility)
  if (flushTimer !== null) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  void flush()
}

/** 登出/账号切换：丢旧主体队列与采样状态（旧身份数据不跨账号） */
export function resetTelemetrySubject(): void {
  queue = []
  queueBytes = 0
  csrfToken = null
  csrfExpiresAt = 0
  fingerprintLastAt.clear()
}

/** ErrorBoundary 复用入口（同一指纹与全局监听合并，不重复上报） */
export function reportClientError(err: Error, context?: Record<string, string | number | boolean>): void {
  recordError(err, context)
}

/** 状态（诊断/测试） */
export function telemetryStats(): { queued: number; dropped: number } {
  return { queued: queue.length, dropped: droppedClientSide }
}
