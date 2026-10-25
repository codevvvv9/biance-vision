/**
 * POST /api/security/csp-report（P3-3，方案 §6.4）：CSP Report-Only 采集通道。
 * 匿名精确路由（仅此端点；不要求会话/CSRF——浏览器报告媒体类型，自身不执行业务）；
 * 强制配额 10/分/IP；≤16KiB；报告视为可伪造诊断（URL 去 query/fragment，不存
 * script-sample）；入诊断收件箱（source=server，kind=csp_report）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sql } from 'drizzle-orm'
import { getDb } from '../db.js'
import { RATE_POLICIES, rateLimitConsume, rateLimitedError } from '../security/rateLimit.js'
import { tryRecord } from './diagnosticSink.js'

const MAX_BODY_BYTES = 16 * 1024

export function registerCspReportRoute(
  app: FastifyInstance,
  deps: { purpose: 'user' | 'admin'; clientIp: (req: FastifyRequest) => string },
): void {
  app.post('/api/security/csp-report', async (req, reply) => {
    const verdict = await rateLimitConsume(RATE_POLICIES['csp.report:ip'], deps.clientIp(req))
    if (!verdict.allowed) throw rateLimitedError(verdict.retryAfterSeconds)
    const body = (req.body ?? {}) as Record<string, unknown>
    const text = JSON.stringify(body)
    if (text.length > MAX_BODY_BYTES) {
      return reply.code(413).send({ statusCode: 413, error: 'Payload Too Large', message: '报告过大', code: 'payload_too_large', requestId: req.id })
    }
    // 投影：只留 document-uri（去 query/fragment）/violated-directive/blocked-uri 类别
    const report = (body['csp-report'] ?? {}) as Record<string, unknown>
    const docUri = typeof report['document-uri'] === 'string' ? report['document-uri'].split('?')[0].split('#')[0].slice(0, 200) : null
    tryRecord(deps.purpose, deps.clientIp(req), {
      kind: 'csp_report',
      requestId: req.id,
      payload: {
        directive: typeof report['violated-directive'] === 'string' ? report['violated-directive'].slice(0, 64) : null,
        documentUri: docUri,
      },
    })
    void getDb // 保持模块形状一致（无需直查）
    void sql
    return reply.code(202).send({ ok: true })
  })
}
