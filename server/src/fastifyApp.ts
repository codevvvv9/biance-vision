/**
 * 共享 Fastify 应用骨架（P0-1 起为唯一构造点）：统一错误映射 + 可选 CORS。
 * user-api（index.ts）与 admin-api（adminApi.ts）均经 buildApp 构造——错误映射/
 * 基础配置单点定义；入口差异（CORS 仅 user 端、WS 仅 user 端）由调用方注册。
 * 历史注记：W3-S3 时期注释声称两端共用、实际 index.ts 自建实例拷贝错误处理器
 * （假共享，两份实现可静默漂移）——P0-1 已消除。
 */
import Fastify from 'fastify'
import cors from '@fastify/cors'
import crypto from 'node:crypto'
import { STATUS_CODES } from 'node:http'
import { log } from './logger.js'
import { corsOptions } from './security/cors.js'
import { trustProxyOption } from './security/trust.js'
import type { FastifyInstance } from 'fastify'

export function buildApp(opts: { cors: boolean } = { cors: true }): FastifyInstance {
  // P0-2：代理信任单点——空 = 不信任（socket 对端），列表 = 按信任链解析；
  // 禁止 true（反射任意来源伪造 XFF）
  // P0-3：requestId 单点——进程内计数不足以保证双进程/重启后唯一，改 UUID；
  // 不采信公网上传的同名头（requestIdHeader:false）
  const app = Fastify({
    logger: false,
    trustProxy: trustProxyOption(),
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID(),
  })

  // 每个响应返还 X-Request-ID（前端报障可复制；onSend 是最后可改头的阶段）
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-request-id', req.id)
    return payload // ❗onSend 必须原样返回 payload——返回 undefined 会吞掉响应体（Fastify 按 not-found 回退 404）
  })

  // 统一错误映射：路由内 throw Object.assign(new Error(msg), { statusCode, code? })
  // 转为 ApiErrorResponse（platform-contracts）：{ statusCode, error, message, code,
  // requestId, retryAfterSeconds? }——message 面向最终用户（前端原样展示）；
  // code 为机器可读公开码（框架码见 platform-contracts 注册表；领域业务码原样
  // 透传），仅 4xx 透传——5xx 不回显内部 message 也不透 code（防泄露 PG
  // SQLSTATE / 系统错误码等内部细节）。retryAfterSeconds 从 err 读取（429 等）。
  app.setErrorHandler((err, req, reply) => {
    const e = err as { statusCode?: number; code?: string; message?: string; retryAfterSeconds?: number }
    const statusCode = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500
    if (statusCode >= 500) log.error('http', '未处理异常', err)
    const body: Record<string, unknown> = {
      statusCode,
      error: STATUS_CODES[statusCode] ?? 'Error',
      message: statusCode >= 500 ? 'Internal Server Error' : String(e.message ?? ''),
      requestId: req.id,
    }
    if (statusCode < 500 && typeof e.code === 'string') body.code = e.code
    if (statusCode < 500 && typeof e.retryAfterSeconds === 'number' && Number.isFinite(e.retryAfterSeconds)) {
      body.retryAfterSeconds = Math.max(0, Math.trunc(e.retryAfterSeconds))
    }
    void reply.code(statusCode).send(body)
  })

  // CORS 仅 user-api 需要；策略单点在 security/cors.ts（Q-3：默认同源不反射，
  // BV_ALLOWED_ORIGINS 显式列举才放行）——admin-api 同源直连不注册
  if (opts.cors) void app.register(cors, corsOptions())

  return app
}
