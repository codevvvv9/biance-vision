/**
 * 写操作来源守卫（P0-2b）：跨源 Origin 硬拒绝 + CSRF token verify 模式。
 * 同源判定（协议感知 + 对称端口归一）单点在 security/origin.ts——2026-10-25
 * 修订：原实现 Host 侧默认端口写死 80，TLS 终止在反代的 HTTPS 生产拓扑
 * （Origin 归一 443）被整体误判跨源，登录全站 403。
 * onRequest 阶段执行（早于 body 解析——便宜校验先行，方案 §3 顺序约束）：
 * 1. Origin 存在时必须与本服务同源（见 origin.ts）或在 BV_ALLOWED_ORIGINS
 *    白名单内；null/未知来源的写请求 403。无 Origin 的请求（curl/脚本/
 *    服务间）本阶段放行——「二者均无拒绝」属 enforce 阶段，避免破坏既有
 *    脚本与运维通道。
 * 2. 携带 X-CSRF-Token 的写请求必须验证通过（verify 由组合方构造：主体=会话
 *    token 哈希优先、登录前种子兜底，绑定 purpose），无效 403；未携带放行
 *    （verify 兼容阶段——SDK 接入并观察后切 enforce，届时未携带亦 403）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { allowedOrigins } from './cors.js'
import { requestOriginAllowed } from './origin.js'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
export const CSRF_INVALID = 'csrf_invalid'

export function registerSourceGuard(app: FastifyInstance, deps: { verify: (req: FastifyRequest, token: string) => boolean }): void {
  const allow = new Set(allowedOrigins())
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!WRITE_METHODS.has(req.method)) return
    const url = req.url.split('?')[0]
    if (!url.startsWith('/api/')) return

    if (!requestOriginAllowed(req, allow)) {
      reply.code(403).send({ statusCode: 403, error: 'Forbidden', message: '跨来源写请求被拒绝', code: CSRF_INVALID })
      return
    }

    const tokenHeader = req.headers['x-csrf-token']
    if (typeof tokenHeader === 'string' && tokenHeader !== '' && !deps.verify(req, tokenHeader)) {
      reply.code(403).send({ statusCode: 403, error: 'Forbidden', message: 'CSRF 校验失败，请刷新页面后重试', code: CSRF_INVALID })
    }
  })
}
