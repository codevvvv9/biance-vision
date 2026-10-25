/**
 * 写操作来源守卫（P0-2b）：跨源 Origin 硬拒绝 + CSRF token verify 模式。
 *
 * onRequest 阶段执行（早于 body 解析——便宜校验先行，方案 §3 顺序约束）：
 * 1. Origin 存在时必须同源（与请求 Host 精确匹配，含端口归一）或在
 *    BV_ALLOWED_ORIGINS 白名单内；null/未知来源的写请求 403。
 *    无 Origin 的请求（curl/脚本/服务间）本阶段放行——「二者均无拒绝」属
 *    enforce 阶段，避免破坏既有脚本与运维通道。
 * 2. 携带 X-CSRF-Token 的写请求必须验证通过（verify 由组合方构造：主体=会话
 *    token 哈希优先、登录前种子兜底，绑定 purpose），无效 403；未携带放行
 *    （verify 兼容阶段——SDK 接入并观察后切 enforce，届时未携带亦 403）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { allowedOrigins } from './cors.js'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
export const CSRF_INVALID = 'csrf_invalid'

/** Origin 与 Host 同源判定（端口归一：默认 80/443）；白名单来源直接放行 */
export function isSameOrigin(origin: string, host: string | undefined, allow: Set<string>): boolean {
  if (allow.has(origin)) return true
  if (host === undefined || host === '') return false
  try {
    const u = new URL(origin)
    const originHost = u.hostname.toLowerCase()
    const originPort = u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port
    const [reqHost, rawPort] = host.toLowerCase().split(':')
    const reqPort = rawPort ?? '80'
    return originHost === reqHost && originPort === reqPort
  } catch {
    return false // 'null' 与畸形值一律非同源
  }
}

export function registerSourceGuard(app: FastifyInstance, deps: { verify: (req: FastifyRequest, token: string) => boolean }): void {
  const allow = new Set(allowedOrigins())
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!WRITE_METHODS.has(req.method)) return
    const url = req.url.split('?')[0]
    if (!url.startsWith('/api/')) return

    const origin = req.headers.origin
    if (typeof origin === 'string' && (origin === 'null' || !isSameOrigin(origin, req.headers.host, allow))) {
      reply.code(403).send({ statusCode: 403, error: 'Forbidden', message: '跨来源写请求被拒绝', code: CSRF_INVALID })
      return
    }

    const tokenHeader = req.headers['x-csrf-token']
    if (typeof tokenHeader === 'string' && tokenHeader !== '' && !deps.verify(req, tokenHeader)) {
      reply.code(403).send({ statusCode: 403, error: 'Forbidden', message: 'CSRF 校验失败，请刷新页面后重试', code: CSRF_INVALID })
    }
  })
}
