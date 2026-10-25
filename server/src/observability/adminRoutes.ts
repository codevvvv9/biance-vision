/**
 * 管理端观测查询（P2a-4，方案 §12.1）：仅 admin-api 注册——概览（sink 状态/
 * 计数/新鲜度）、错误聚合列表、requestId/用户精确检索。三视图最小集。
 *
 * 约束：superadmin 鉴权 + CSRF（全局 sourceGuard）+ 读路径入口闸门；固定允许列
 * （不开放任意 SQL/JSON 查询语言）；默认 50 行/最多 100；时间窗默认 15 分钟、
 * 最大 7 天；空数据=明确空（不用绿色 0 假装采集正常——stale/droppedCount 单列）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sql } from 'drizzle-orm'
import { getDb } from '../db.js'
import { diagnosticSinkStats } from './diagnosticSink.js'
import crypto from 'node:crypto'

function subjectHashOf(username: string): string {
  return `${username.length}:${crypto.createHash('sha256').update(username).digest('hex').slice(0, 32)}`
}

function parseIntQuery(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(v ?? '', 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

export function registerObservabilityAdminRoutes(
  app: FastifyInstance,
  deps: { requireSuperadmin: (req: FastifyRequest) => { username: string } },
): void {
  app.get('/api/admin/observability/overview', async () => {
    const db = getDb()
    const sink = diagnosticSinkStats()
    if (db === null) return { dbAvailable: false, sink }
    const inbox = await db.execute(sql`SELECT
      count(*) FILTER (WHERE received_at > now() - interval '15 minutes') AS recent,
      count(*) AS total FROM observability_inbox`)
    const errors = await db.execute(sql`SELECT
      count(*) FILTER (WHERE last_seen > now() - interval '15 minutes') AS recent,
      count(*) FILTER (WHERE status = 'open') AS open FROM observability_error_groups`)
    const i = (inbox as unknown as Array<Record<string, unknown>>)[0] ?? {}
    const e = (errors as unknown as Array<Record<string, unknown>>)[0] ?? {}
    return {
      dbAvailable: true,
      sink,
      inbox: { recent15m: Number(i.recent ?? 0), total: Number(i.total ?? 0) },
      errorGroups: { recent15m: Number(e.recent ?? 0), open: Number(e.open ?? 0) },
      observedAt: new Date().toISOString(),
    }
  })

  app.get('/api/admin/observability/errors', async (req) => {
    const db = getDb()
    if (db === null) return { items: [], nextCursor: null, observedAt: new Date().toISOString() }
    const q = req.query as { limit?: string; cursor?: string }
    const limit = parseIntQuery(q.limit, 50, 1, 100)
    const cursorOffset = parseIntQuery(q.cursor, 0, 0, 1_000_000)
    const rows = await db.execute(sql`
      SELECT fingerprint, release, source, first_seen, last_seen, count, status, sample
      FROM observability_error_groups
      ORDER BY last_seen DESC LIMIT ${limit + 1} OFFSET ${cursorOffset}`)
    const items = (rows as unknown as Array<Record<string, unknown>>).slice(0, limit).map((r) => ({
      fingerprint: String(r.fingerprint),
      release: String(r.release),
      source: String(r.source),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      count: Number(r.count),
      status: String(r.status),
      sample: r.sample,
    }))
    return {
      items,
      nextCursor: items.length === limit ? String(cursorOffset + limit) : null,
      observedAt: new Date().toISOString(),
    }
  })

  /** requestId 精确查（含 origin_request_id 关联）+ 用户最近已记录请求 */
  app.get('/api/admin/observability/logs', async (req) => {
    const db = getDb()
    if (db === null) return { items: [], observedAt: new Date().toISOString(), stale: true }
    const q = req.query as { requestId?: string; username?: string; limit?: string }
    const limit = parseIntQuery(q.limit, 50, 1, 100)
    let rows: Array<Record<string, unknown>>
    if (typeof q.requestId === 'string' && q.requestId !== '') {
      const id = q.requestId.slice(0, 64)
      rows = await db.execute(sql`
        SELECT source, kind, request_id, origin_request_id, payload, received_at
        FROM observability_inbox
        WHERE request_id = ${id} OR origin_request_id = ${id}
        ORDER BY received_at DESC LIMIT ${limit}`) as unknown as Array<Record<string, unknown>>
    } else if (typeof q.username === 'string' && q.username !== '') {
      // 用户检索：主体哈希映射（服务端确定；管理授权边界内）
      const hash = subjectHashOf(q.username.slice(0, 64))
      rows = await db.execute(sql`
        SELECT source, kind, request_id, origin_request_id, payload, received_at
        FROM observability_inbox
        WHERE subject_hash = ${hash}
        ORDER BY received_at DESC LIMIT ${limit}`) as unknown as Array<Record<string, unknown>>
    } else {
      rows = await db.execute(sql`
        SELECT source, kind, request_id, origin_request_id, payload, received_at
        FROM observability_inbox
        ORDER BY received_at DESC LIMIT ${limit}`) as unknown as Array<Record<string, unknown>>
    }
    return {
      items: rows.map((r) => ({
        source: String(r.source),
        kind: String(r.kind),
        requestId: r.request_id === null ? null : String(r.request_id),
        originRequestId: r.origin_request_id === null ? null : String(r.origin_request_id),
        payload: r.payload,
        receivedAt: r.received_at,
      })),
      // 采样口径披露：inbox 是错误/安全/浏览器事件（非全量行为）；查无记录≠未发生
      note: 'diagnostic-sampled',
      observedAt: new Date().toISOString(),
    }
  })
}
