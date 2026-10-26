import { registerMembershipMeter } from './membership/meter.js'
import { memberCalls } from './membership/context.js'
import { membershipStatus } from './membership/service.js'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb } from './db.js'
import { appSettings, users } from './models.js'
import type { SessionRecord } from './users.js'

/** Managed access is persistent and shared by every process. No daily JSON counter is trusted. */
export interface AiAccess {
  version: 1
  generation: string
  totalLimit: number
  used: number
  dailyLimit: number | null
  dailyDate: string
  dailyUsed: number
  requestsPerMinute: number
  windowAt: number
  windowUsed: number
  profileName: string
}
export const accessKey = (username: string) => `ai_access:${username}`
const unavailable = () => Object.assign(new Error('AI 额度服务暂不可用，请稍后重试'), { statusCode: 503 })
const exhausted = () => Object.assign(new Error('AI 使用额度已用完，请联系我们开通会员服务。 / AI access limit reached. Contact us for membership access.'), { statusCode: 403, code: 'ai_access_exhausted' })

export async function readAiAccess(username: string): Promise<AiAccess | null> {
  const db = getDb()
  if (!db) throw unavailable()
  const rows = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, accessKey(username))).limit(1)
  return rows[0] ? rows[0].value as unknown as AiAccess : null
}

interface Reservation { username: string; generation: string; day: string }
export async function reserveAiAccess(username: string): Promise<Reservation | null> {
  const db = getDb()
  if (!db) throw unavailable()
  // Read the administrator's cutoff from PG on every interaction, not the 60-second user cache.
  const user = (await db.select({ policy: users.chatPolicy }).from(users).where(eq(users.username, username)).limit(1))[0]
  if (!user || user.policy?.disabled) throw Object.assign(new Error('AI 访问已停用，请联系我们确认开通状态。 / AI access is disabled. Please contact us.'), { statusCode: 403, code: 'chat_disabled' })
  const current = await readAiAccess(username)
  if (!current) return null // Existing accounts retain their existing policy until explicitly managed.
  const now = Date.now()
  const day = new Date(now + 8 * 3600_000).toISOString().slice(0, 10)
  const rows = await db.execute(sql`
    UPDATE app_settings SET value = value || jsonb_build_object(
      'used', (value->>'used')::int + 1,
      'dailyDate', ${day}::text,
      'dailyUsed', CASE WHEN value->>'dailyDate' = ${day} THEN (value->>'dailyUsed')::int + 1 ELSE 1 END,
      'windowAt', CASE WHEN ${now}::bigint - (value->>'windowAt')::bigint >= 60000 THEN ${now}::bigint ELSE (value->>'windowAt')::bigint END,
      'windowUsed', CASE WHEN ${now}::bigint - (value->>'windowAt')::bigint >= 60000 THEN 1 ELSE (value->>'windowUsed')::int + 1 END
    ) WHERE key = ${accessKey(username)}
      AND value->>'generation' = ${current.generation}
      AND (value->>'used')::int < (value->>'totalLimit')::int
      AND (value->>'dailyLimit' IS NULL OR value->>'dailyDate' <> ${day} OR (value->>'dailyUsed')::int < (value->>'dailyLimit')::int)
      AND (${now}::bigint - (value->>'windowAt')::bigint >= 60000 OR (value->>'windowUsed')::int < (value->>'requestsPerMinute')::int)
    RETURNING key`)
  if (!rows.length) {
    const latest = await readAiAccess(username)
    if (!latest || latest.generation !== current.generation) throw unavailable()
    if (latest.used >= latest.totalLimit) throw exhausted()
    if (latest.dailyLimit !== null && latest.dailyDate === day && latest.dailyUsed >= latest.dailyLimit) {
      throw Object.assign(new Error('今日 AI 使用额度已达上限，请联系我们开通会员服务。 / Daily AI access limit reached. Contact us for membership access.'), { statusCode: 429, code: 'ai_daily_limit_exceeded' })
    }
    throw Object.assign(new Error('AI 请求过于频繁，请稍后重试。 / Too many AI requests. Please try again later.'), { statusCode: 429, code: 'ai_rate_limited' })
  }
  return { username, generation: current.generation, day }
}

export async function refundAiAccess(reservation: Reservation): Promise<void> {
  const db = getDb()
  if (!db) throw unavailable()
  await db.execute(sql`UPDATE app_settings SET value = value || jsonb_build_object(
    'used', GREATEST(0, (value->>'used')::int - 1),
    'dailyUsed', CASE WHEN value->>'dailyDate' = ${reservation.day} THEN GREATEST(0, (value->>'dailyUsed')::int - 1) ELSE (value->>'dailyUsed')::int END
  ) WHERE key = ${accessKey(reservation.username)} AND value->>'generation' = ${reservation.generation}`)
}

export function isMeteredAiPath(method: string, path: string): boolean {
  return method === 'POST' && (['/api/ai/chat', '/api/ai/command', '/api/translate', '/api/research/chat', '/api/research/runs'].includes(path) || /^\/api\/conversations\/[^/]+\/messages$/.test(path))
}

export function registerAiAccessGuard(app: FastifyInstance, deps: { requireSession: (req: FastifyRequest) => SessionRecord }): void {
  registerMembershipMeter(app, deps, isMeteredAiPath)
  const reservations = new WeakMap<FastifyRequest, Reservation>()
  app.addHook('preHandler', async req => {
    if (!isMeteredAiPath(req.method, req.routeOptions.url || req.url.split('?')[0])) return
    const session = deps.requireSession(req)
    if (memberCalls.getStore()?.username === session.username) return
    const reservation = await reserveAiAccess(session.username)
    if (reservation) reservations.set(req, reservation)
  })
  const refund = async (req: FastifyRequest) => {
    const reservation = reservations.get(req)
    if (!reservation) return
    reservations.delete(req) // Error + onSend cannot refund the same failed request twice.
    await refundAiAccess(reservation)
  }
  app.addHook('onError', async req => { await refund(req) })
  app.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 400) await refund(req)
    return payload
  })
  app.get('/api/users/me/ai-access', async (req, reply) => {
    const session = deps.requireSession(req)
    const membership = await membershipStatus(session.username)
    if (membership.managed) { reply.header('Cache-Control', 'no-store'); return { managed: true, totalLimit: membership.current?.dailyLimit ?? null, used: membership.usedToday, remaining: membership.remainingToday, contactPath: '/en/contact', membership } }
    const access = await readAiAccess(session.username)
    reply.header('Cache-Control', 'no-store')
    return { managed: !!access, totalLimit: access?.totalLimit ?? null, used: access?.used ?? null,
      remaining: access ? Math.max(0, access.totalLimit - access.used) : null, contactPath: '/en/contact' }
  })
}
