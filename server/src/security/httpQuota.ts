/**
 * HTTP 配额守卫（P1-4）：按路由组注册的策略经唯一原语消费——路由不再另写
 * 限流 SQL。本批全部 shadow（计数+should_block 记录，不拒绝业务）；观察期满
 * 按 scope 切 enforce（方案 §13.2，切换不清旧状态）。
 *
 * 维度：已登录按用户（主体=username）+ IP 双桶（多维按固定顺序操作，读请求
 * 允许部分扣减后被拒——shadow 阶段均不拒）；未登录仅 IP 桶。
 * 挂点：preHandler（注册于鉴权钩子之后——能取到会话用户）。
 * URL 超限（8 KiB）在 onRequest 便宜拒绝（先于配额消费）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { RATE_POLICIES, rateLimitConsume, type RatePolicy } from './rateLimit.js'
import { clientIp } from './trust.js'

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
export const URL_MAX_BYTES = 8 * 1024

export interface QuotaGuardDeps {
  /** 从请求解析已认证主体（无会话返回 null——挂点在鉴权后，通常能取到） */
  resolveUser: (req: FastifyRequest) => string | null
  /** 上传类路径判定（POST + 前缀匹配；admin-api 传知识库上传前缀集合） */
  isUploadPath?: (method: string, url: string) => boolean
  /** 管理变更类路径判定（admin-api 的其余写操作，10/分/管理员） */
  isAdminWritePath?: (method: string, url: string) => boolean
}

async function consumePair(userPolicy: RatePolicy, ipPolicy: RatePolicy, user: string | null, ip: string): Promise<void> {
  await rateLimitConsume(ipPolicy, ip)
  if (user !== null) await rateLimitConsume(userPolicy, user)
}

export function registerHttpQuotaGuard(app: FastifyInstance, deps: QuotaGuardDeps): void {
  // URL 上限：onRequest 便宜拒绝（先于配额消费与 body 解析）
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.length > URL_MAX_BYTES) {
      reply.code(414).send({ statusCode: 414, error: 'URI Too Long', message: '请求地址过长', code: 'payload_too_large' })
    }
  })
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const url = req.url.split('?')[0]
    if (!url.startsWith('/api/') || url === '/api/health' || url.startsWith('/api/auth/')) return
    const user = deps.resolveUser(req)
    const ip = clientIp(req)
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        await consumePair(RATE_POLICIES['read:user'], RATE_POLICIES['read:ip'], user, ip)
        return
      }
      if (WRITE_METHODS.has(req.method) && deps.isUploadPath?.(req.method, url) === true) {
        await consumePair(RATE_POLICIES['upload:admin'], RATE_POLICIES['upload:ip'], user, ip)
        return
      }
      if (WRITE_METHODS.has(req.method) && deps.isAdminWritePath?.(req.method, url) === true) {
        await rateLimitConsume(RATE_POLICIES['admin.write:admin'], user ?? ip)
        return
      }
      if (WRITE_METHODS.has(req.method)) {
        await consumePair(RATE_POLICIES['write:user'], RATE_POLICIES['write:ip'], user, ip)
      }
    } catch {
      // shadow 策略存储故障不拒绝业务（rateLimitConsume 内部已告警）；此处兜底
      // 不让配额观察拖垮请求
    }
  })
}

/** 429 响应构造在 rateLimitedError（rateLimit.ts）——enforce 切换时复用 */
export type { RatePolicy }
