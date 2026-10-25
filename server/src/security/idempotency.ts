/**
 * 幂等中间件（P1-5，方案 §5）：
 * - SDK 每次逻辑操作生成 UUID Idempotency-Key（自动重试沿用原键；新操作新键）；
 *   键 ≤128 字节；未带键的请求照旧处理（兼容 rollout——观察窗口后高成本路由
 *   才要求键并 400 idempotency_key_required，§5.2）。
 * - 唯一范围 (purpose, subject_hash, method, routeTemplate, key)；指纹=规范化
 *   body（不含 CSRF token/传输元数据/请求编号——它们每次变化，§5.1）。
 * - 争抢（security_idempotency_claim 原子函数）：
 *   fresh=本请求执行业务；replay=返回原响应（含原 runId 等）；in_progress=409
 *   idempotency_in_progress+Retry-After；conflict=409 idempotency_conflict（不执行副作用）。
 *   processing 超 30s 可重争（进程崩溃不留死键——返回 fresh 重执行）。
 * - 完成记录保留 24h；业务失败（抛错）不写 completed（键可重试）。
 */
import crypto from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { sql } from 'drizzle-orm'
import { getDb } from '../db.js'
import { subjectHashOf } from './subjectHash.js'

const KEY_HEADER = 'idempotency-key'
const KEY_MAX_BYTES = 128
const PROCESSING_TIMEOUT_MS = 30_000

export type IdempotencyVerdict =
  | { kind: 'passthrough' } // 未带键
  | { kind: 'fresh' }
  | { kind: 'replay'; statusCode: number; body: unknown }
  | { kind: 'in_progress' }
  | { kind: 'conflict' }

export function idempotencyKeyOf(req: FastifyRequest): string | null {
  const raw = req.headers[KEY_HEADER]
  if (typeof raw !== 'string' || raw === '') return null
  const key = raw.trim()
  return key.length > 0 && key.length <= KEY_MAX_BYTES ? key : null
}

function fingerprintOf(method: string, route: string, body: unknown): string {
  const normalized = body === undefined ? '' : JSON.stringify(body)
  return crypto.createHash('sha256').update(`${method}\n${route}\n${normalized}`).digest('hex')
}

/** 争抢幂等记录（原子）；routeTemplate 由调用方传（路由模板而非原始 URL） */
export async function claimIdempotency(
  req: FastifyRequest,
  routeTemplate: string,
  purpose: 'user' | 'admin',
  subject: string,
): Promise<IdempotencyVerdict> {
  const key = idempotencyKeyOf(req)
  if (key === null) return { kind: 'passthrough' }
  const conn = getDb()
  if (conn === null) {
    throw Object.assign(new Error('安全状态暂不可用，请稍后重试'), { statusCode: 503, code: 'security_state_unavailable' })
  }
  const rows = await conn.execute(sql`
    SELECT security_idempotency_claim(${purpose}, ${subjectHashOf(subject)}, ${req.method},
      ${routeTemplate}, ${key}, ${fingerprintOf(req.method, routeTemplate, req.body)}, ${PROCESSING_TIMEOUT_MS}) AS v`)
  const v = (rows as unknown as Array<{ v: { verdict: string; response_body?: unknown; status_code?: number } }>)[0]?.v
  switch (v?.verdict) {
    case 'fresh':
      return { kind: 'fresh' }
    case 'replay':
      return { kind: 'replay', statusCode: v.status_code ?? 200, body: v.response_body }
    case 'conflict':
      return { kind: 'conflict' }
    default:
      return { kind: 'in_progress' }
  }
}

/** 业务成功后写完成记录（同键重放返回原响应） */
export async function completeIdempotency(
  req: FastifyRequest,
  routeTemplate: string,
  purpose: 'user' | 'admin',
  subject: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  const key = idempotencyKeyOf(req)
  if (key === null) return
  const conn = getDb()
  if (conn === null) return
  await conn.execute(sql`
    SELECT security_idempotency_complete(${purpose}, ${subjectHashOf(subject)}, ${req.method},
      ${routeTemplate}, ${key}, ${statusCode}, ${JSON.stringify(body)}::jsonb)`)
}

/** 幂等拒绝响应构造（409 两类；不执行副作用） */
export function idempotencyRejected(verdict: Extract<IdempotencyVerdict, { kind: 'in_progress' | 'conflict' }>): Error {
  if (verdict.kind === 'conflict') {
    return Object.assign(new Error('幂等键已用于不同内容的请求，请刷新后重试'), { statusCode: 409, code: 'idempotency_conflict' })
  }
  return Object.assign(new Error('相同请求正在处理中，请稍后查询结果'), { statusCode: 409, code: 'idempotency_in_progress', retryAfterSeconds: 3 })
}

export async function replyReplay(reply: FastifyReply, statusCode: number, body: unknown): Promise<void> {
  await reply.code(statusCode).send(body)
}
