import type { FastifyRequest } from 'fastify'

const windows = new Map<string, { at: number; count: number }>()

/** Additional defense for infrequent, authenticated administrative mutations. */
export function guardAdminMutation(req: FastifyRequest, username: string, action: string, limit = 10): void {
  const reject = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode })
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw reject('需要 application/json', 415)
  if (req.headers['sec-fetch-site'] === 'cross-site') throw reject('不允许跨站管理操作', 403)
  const origin = req.headers.origin
  if (origin) {
    try {
      const parsed = new URL(origin)
      if (parsed.host !== req.headers.host || parsed.protocol !== `${req.protocol}:`) throw new Error('origin')
    } catch { throw reject('管理操作来源不匹配', 403) }
  }
  const now = Date.now()
  for (const [key, entry] of windows) if (now - entry.at >= 60_000) windows.delete(key)
  const key = `${action}:${username}`
  const entry = windows.get(key) ?? { at: now, count: 0 }
  if (entry.count >= limit) throw reject('管理操作过于频繁，请稍后重试', 429)
  entry.count += 1
  windows.set(key, entry)
}
