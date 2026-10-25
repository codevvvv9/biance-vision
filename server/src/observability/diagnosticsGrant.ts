/**
 * 受控诊断授权（P3-2，方案 §7）：生产不挂全局 debug 对象；详细诊断经管理域
 * superadmin 创建 15 分钟 grant（绑定当前 admin 会话哈希+目标，不只绑用户名），
 * 管理前端凭有效 grant 获得只读快照数据并挂 window.__BV_DEBUG__（另一会话/登出/
 * 过期即失效——服务端验证 grant，前端篡改不能延长权限）。
 * 创建/撤销均审计；按 release+请求编号定位，禁止任意用户全量抓包。
 */
import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sql } from 'drizzle-orm'
import { getDb } from '../db.js'
import { recordAudit } from '../audit.js'
import type { SessionRecord } from '../users.js'

const GRANT_TTL_MS = 15 * 60_000

function sessionHashOf(token: string | undefined): string | null {
  if (token === undefined) return null
  return crypto.createHash('sha256').update(token).digest('hex')
}

function readToken(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === 'bv_session') return part.slice(eq + 1).trim()
  }
  return undefined
}

export function registerDiagnosticsGrantRoutes(
  app: FastifyInstance,
  deps: { requireSuperadmin: (req: FastifyRequest) => SessionRecord },
): void {
  /** 创建授权（15 分钟；绑定会话哈希+目标；审计） */
  app.post('/api/admin/observability/diagnostics', async (req) => {
    const session = deps.requireSuperadmin(req)
    const db = getDb()
    if (db === null) throw Object.assign(new Error('数据库不可用'), { statusCode: 503 })
    const body = (req.body ?? {}) as { target?: unknown }
    const target = typeof body.target === 'string' ? body.target.slice(0, 128) : ''
    const id = crypto.randomUUID()
    const sessionHash = sessionHashOf(readToken(req.headers.cookie)) ?? ''
    await db.execute(sql`
      INSERT INTO observability_diagnostic_grants (id, admin_subject, admin_session_hash, target, expires_at)
      VALUES (${id}, ${session.username}, ${sessionHash}, ${target}, now() + make_interval(secs => ${GRANT_TTL_MS / 1000}))`)
    recordAudit(session, { action: 'settings_update', target: 'diagnostics', detail: `创建 15 分钟诊断授权（目标：${target || '全部'}）` })
    return { grantId: id, expiresAt: new Date(Date.now() + GRANT_TTL_MS).toISOString() }
  })

  /** 撤销（审计；幂等——不存在 404） */
  app.delete('/api/admin/observability/diagnostics/:id', async (req) => {
    const session = deps.requireSuperadmin(req)
    const db = getDb()
    if (db === null) throw Object.assign(new Error('数据库不可用'), { statusCode: 503 })
    const { id } = req.params as { id: string }
    const rows = await db.execute(sql`
      UPDATE observability_diagnostic_grants SET revoked_at = now()
      WHERE id = ${id} AND revoked_at IS NULL AND expires_at > now() RETURNING id`)
    if ((rows as unknown as unknown[]).length === 0) throw Object.assign(new Error('授权不存在或已失效'), { statusCode: 404 })
    recordAudit(session, { action: 'settings_update', target: 'diagnostics', detail: `撤销诊断授权 ${id.slice(0, 8)}` })
    return { ok: true }
  })

  /**
   * 自查（管理前端轮询）：仅当当前会话哈希匹配且未撤销未过期的 grant 存在时
   * 返回只读诊断快照数据（telemetry 状态+sink 概览）；否则 404（前端据此卸载
   * __BV_DEBUG__）。凭 grant 返回数据，不是权限本身——业务端点鉴权不变。
   */
  app.get('/api/observability/diagnostics/grant', async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    const db = getDb()
    if (db === null) return reply.code(503).send({ message: '数据库不可用' })
    const sessionHash = sessionHashOf(readToken(req.headers.cookie)) ?? ''
    const rows = await db.execute(sql`
      SELECT id, target, expires_at FROM observability_diagnostic_grants
      WHERE admin_subject = ${session.username} AND admin_session_hash = ${sessionHash}
        AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`)
    const grant = (rows as unknown as Array<{ id: string; target: string; expires_at: Date }>)[0]
    if (grant === undefined) return reply.code(404).send({ message: '无有效诊断授权' })
    const { diagnosticSinkStats } = await import('./diagnosticSink.js')
    const sink = diagnosticSinkStats()
    return {
      grantId: grant.id,
      target: grant.target,
      expiresAt: grant.expires_at,
      snapshot: {
        environment: 'production' as const,
        protectionMode: 'shadow' as const,
        telemetryState: sink.dropped > 100 ? ('degraded' as const) : ('ready' as const),
        sink: { queueItems: sink.queueItems, dropped: sink.dropped, lastFlushAt: sink.lastFlushAt },
      },
    }
  })
}
