/**
 * 共享 Fastify 应用骨架（W3-S3）：统一错误映射（与 index.ts v0.15.2 行为一致）
 * + 可选 CORS。user-api 与 admin-api 两个入口共用，改这里即两端同步。
 */
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { STATUS_CODES } from 'node:http'
import { log } from './logger.js'
import type { FastifyInstance } from 'fastify'

export function buildApp(opts: { cors: boolean } = { cors: true }): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: true })

  // 统一错误映射：路由内 throw Object.assign(new Error(msg), { statusCode, code? })
  // 转为 { statusCode, error, message, code? }——message 面向最终用户（前端原样展示）；
  // code 为机器可读业务码，仅 4xx 透传——5xx 不回显内部 message 也不透 code
  // （防泄露 PG SQLSTATE / 系统错误码等内部细节）。
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; code?: string; message?: string }
    const statusCode = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500
    if (statusCode >= 500) log.error('http', '未处理异常', err)
    const body: Record<string, unknown> = {
      statusCode,
      error: STATUS_CODES[statusCode] ?? 'Error',
      message: statusCode >= 500 ? 'Internal Server Error' : String(e.message ?? ''),
    }
    if (statusCode < 500 && typeof e.code === 'string') body.code = e.code
    void reply.code(statusCode).send(body)
  })

  // CORS 仅 user-api 需要（同源部署下亦无害）；admin-api 同源直连不注册
  if (opts.cors) void app.register(cors, { origin: true })

  return app
}
