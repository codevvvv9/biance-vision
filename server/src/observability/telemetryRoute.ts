/**
 * POST /api/telemetry/batch（P2a-3，方案 §10）：浏览器错误/操作失败事件的批量上报。
 *
 * 端点约束：
 * - 会话：用户进程只收 user 会话、管理进程只收 admin 会话（purpose 匹配）；
 * - CSRF：带 X-CSRF-Token 必验（sourceGuard 全局已生效），SDK 自动携带；
 * - 配额：10 批/分/用户 + 30 批/分/IP（enforce——可丢遥测的 429 不影响业务）；
 * - 体积：每批 ≤20 事件 / 64KiB；单事件 ≤4KiB / ≤10 属性 / 字符串 ≤256 字；
 *   仅 client_error 可带 diagnostic（errorType ≤64 字、脱敏 stack ≤2KiB）；
 * - 事件白名单（P2a 仅错误/失败两类）：client_error / operation_failed；
 *   客户端提供的身份/HTTP 状态等字段一律拒绝（服务端补 source/subject/receivedAt）；
 * - 响应 202 {accepted, dropped, requestId}＝进入接收缓冲（不代表已持久化），
 *   失败不重试不递归上报。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { RATE_POLICIES, rateLimitConsume, rateLimitedError } from '../security/rateLimit.js'
import { clientIp } from '../security/trust.js'
import { tryRecordBrowser } from './diagnosticSink.js'

const ALLOWED_EVENTS = new Set(['client_error', 'operation_failed'])
const MAX_EVENTS = 20
const MAX_EVENT_BYTES = 4096
const MAX_BATCH_BYTES = 64 * 1024
const MAX_PROPS = 10
const MAX_STRING = 256
const MAX_ERROR_TYPE = 64
const MAX_STACK = 2048

interface IncomingEvent {
  eventId?: unknown
  name?: unknown
  occurredAt?: unknown
  properties?: unknown
  diagnostic?: unknown
}

function boundedString(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) return null
  return v
}

/** 属性白名单投影：只保留 ≤10 个标量属性（字符串截 256），拒绝对象/数组/危险键 */
function projectProps(raw: unknown): Record<string, string | number | boolean> | null {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return null
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (out.length === MAX_PROPS) break
    if (k.length > 64 || /password|token|secret|authorization|apikey/i.test(k)) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'boolean') out[k] = v
    else if (typeof v === 'string') out[k] = v.slice(0, MAX_STRING)
  }
  return out
}

export function registerTelemetryRoute(
  app: FastifyInstance,
  deps: { purpose: 'user' | 'admin'; requireSession: (req: FastifyRequest) => { username: string }; clientIp: (req: FastifyRequest) => string },
): void {
  app.post('/api/telemetry/batch', async (req, reply) => {
    const session = deps.requireSession(req)
    // 配额（enforce：可丢遥测的拒绝不影响业务）
    const byUser = await rateLimitConsume(RATE_POLICIES['telemetry:user'], session.username)
    if (!byUser.allowed) throw rateLimitedError(byUser.retryAfterSeconds)
    const byIp = await rateLimitConsume(RATE_POLICIES['telemetry:ip'], clientIp(req))
    if (!byIp.allowed) throw rateLimitedError(byIp.retryAfterSeconds)

    const body = (req.body ?? {}) as { schemaVersion?: unknown; events?: unknown }
    if (body.schemaVersion !== 1 || !Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_EVENTS) {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: '非法的遥测批次结构', code: 'validation_failed', requestId: req.id })
    }
    if (JSON.stringify(body).length > MAX_BATCH_BYTES) {
      return reply.code(413).send({ statusCode: 413, error: 'Payload Too Large', message: '遥测批次过大', code: 'payload_too_large', requestId: req.id })
    }
    let accepted = 0
    let dropped = 0
    for (const raw of body.events as IncomingEvent[]) {
      const eventId = typeof raw.eventId === 'string' && /^[0-9a-f-]{16,64}$/i.test(raw.eventId) ? raw.eventId : null
      const name = typeof raw.name === 'string' && ALLOWED_EVENTS.has(raw.name) ? raw.name : null
      const props = projectProps(raw.properties)
      if (eventId === null || name === null || props === null) {
        dropped += 1
        continue
      }
      // diagnostic 仅 client_error 且字段有界；其余事件拒绝携带
      const diagnostic = name === 'client_error' && typeof raw.diagnostic === 'object' && raw.diagnostic !== null
        ? {
            errorType: boundedString((raw.diagnostic as { errorType?: unknown }).errorType, MAX_ERROR_TYPE),
            stack: boundedString((raw.diagnostic as { stack?: unknown }).stack, MAX_STACK),
          }
        : undefined
      const payload: Record<string, unknown> = { name, properties: props }
      if (diagnostic !== undefined) payload.diagnostic = diagnostic
      if (JSON.stringify(payload).length > MAX_EVENT_BYTES) {
        dropped += 1
        continue
      }
      tryRecordBrowser(deps.purpose, session.username, {
        kind: name,
        eventId,
        requestId: req.id,
        payload,
      })
      accepted += 1
    }
    return reply.code(202).send({ accepted, dropped, requestId: req.id })
  })
}
