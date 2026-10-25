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
import { localGateConsume } from './security/localGate.js'
import { clientIp } from './security/trust.js'
import { tryRecord } from './observability/diagnosticSink.js'
import type { FastifyInstance } from 'fastify'

export interface BuildAppOptions {
  cors?: boolean
  /** 入口用途（P2a-1 起诊断事件按入口标记） */
  purpose?: 'user' | 'admin'
}

export function buildApp(opts: BuildAppOptions = { cors: true }): FastifyInstance {
  const purpose = opts.purpose ?? 'user'
  // P0-2：代理信任单点——空 = 不信任（socket 对端），列表 = 按信任链解析；
  // 禁止 true（反射任意来源伪造 XFF）
  // P0-3：requestId 单点——进程内计数不足以保证双进程/重启后唯一，改 UUID；
  // 不采信公网上传的同名头（requestIdHeader:false）
  const app = Fastify({
    logger: false,
    trustProxy: trustProxyOption(),
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID(),
    // P1-4 输入边界：普通 JSON 上限 256 KiB（multipart 上传不受此限，走独立 50MiB）
    bodyLimit: 256 * 1024,
  })

  // P1-2 本地入口闸门：onRequest 最前（先于鉴权/密码/body 解析）——每 IP 10/s
  // 突发 20、进程 100/s 突发 200；无界 IP 不再等于无界资源。两进程共用本实现。
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]
    if (!url.startsWith('/api/') && url !== '/ws') return
    const verdict = localGateConsume(clientIp(req))
    if (!verdict.allowed) {
      reply.code(429).header('retry-after', String(Math.max(1, Math.ceil(verdict.retryAfterMs / 1000)))).send({
        statusCode: 429, error: 'Too Many Requests', message: '请求过于频繁，请稍后再试',
        code: 'rate_limited', requestId: req.id,
      })
    }
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
    // P2a-1：错误进诊断收件箱（可丢：同步有界不抛）；5xx 全量 + 4xx 计数样本，
    // 指纹=statusCode+code（聚合键不含动态 ID/原始 message 变量，§9.4）
    tryRecord(purpose, req.ip ?? 'unknown', {
      kind: statusCode >= 500 ? 'http_error' : 'http_4xx',
      requestId: req.id,
      payload: {
        method: req.method,
        route: req.url.split('?')[0].slice(0, 128),
        statusCode,
        code: typeof e.code === 'string' ? e.code : null,
        message: statusCode >= 500 ? null : String(e.message ?? '').slice(0, 200),
      },
    }, { fingerprint: `http:${statusCode}:${typeof e.code === 'string' ? e.code : 'none'}` })
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
