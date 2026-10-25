import type { FastifyRequest } from 'fastify'
import { requestOriginVerdict } from '../security/origin.js'
import { allowedOrigins } from '../security/cors.js'

const windows = new Map<string, { at: number; count: number }>()

// 管理突变同源白名单：与写守卫/WS 握手同源同语义（security/origin.ts 单点），
// boot 期构建；默认空 = 管理端仅同源，BV_ALLOWED_ORIGINS 精确列举可显式放行
const mutationAllowOrigins = new Set(allowedOrigins())

/** Additional defense for infrequent, authenticated administrative mutations. */
export function guardAdminMutation(req: FastifyRequest, username: string, action: string, limit = 10): void {
  const reject = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode })
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw reject('需要 application/json', 415)
  if (req.headers['sec-fetch-site'] === 'cross-site') throw reject('不允许跨站管理操作', 403)
  // 来源判定迁移至 security/origin.ts（原手写 host/protocol 比较与写守卫语义重复，
  // 且端口归一口径不一致——单点化后三处消费同一实现）
  if (requestOriginVerdict(req, mutationAllowOrigins) === 'foreign') throw reject('管理操作来源不匹配', 403)
  const now = Date.now()
  for (const [key, entry] of windows) if (now - entry.at >= 60_000) windows.delete(key)
  const key = `${action}:${username}`
  const entry = windows.get(key) ?? { at: now, count: 0 }
  if (entry.count >= limit) throw reject('管理操作过于频繁，请稍后重试', 429)
  entry.count += 1
  windows.set(key, entry)
}
