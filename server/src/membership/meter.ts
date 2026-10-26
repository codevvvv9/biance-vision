import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { MembershipPlanSchema } from 'biance-vision-brooks'
import {
  membershipDb,
  membershipError,
  activeMembership,
  dayOf,
  exactProfile,
} from './service.js'
import { memberCalls } from './context.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SessionRecord } from '../users.js'

export interface MemberReservation {
  id: string
  username: string
  day: string
  replay?: { statusCode: number; body: unknown }
}
const reservations = new WeakMap<FastifyRequest, MemberReservation>()

/** Hijacked streaming replies bypass onSend; settle before closing the raw response. */
export async function settleMemberStream(
  req: FastifyRequest,
  success: boolean,
  text = '',
  conversationId = '',
): Promise<void> {
  const reservation = reservations.get(req)
  if (!reservation) return
  await settleMembership(
    reservation,
    success,
    200,
    success ? { stream: { text, conversationId } } : null,
  )
  reservations.delete(req)
}
export async function reserveMembership(
  username: string,
  path: string,
  body: unknown,
  operationKey?: string,
): Promise<MemberReservation | null> {
  return membershipDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`membership:${username}`},0))`,
    )
    // Admission may have waited for another request: use the time after taking the lock.
    const now = Date.now(),
      day = dayOf(now)
    const r = await activeMembership(username, tx, now)
    if (!r) return null
    if (
      r.disabled ||
      (r.chat_policy as { disabled?: boolean } | null)?.disabled
    )
      throw membershipError(
        '会员 AI 访问已停用 / Membership disabled',
        403,
        'membership_disabled',
      )
    if (!r.id)
      throw membershipError(
        '会员已到期，请联系管理员续费 / Membership expired',
        403,
        'membership_expired',
      )
    const plan = MembershipPlanSchema.parse(r.config)
    const feature =
      path === '/api/translate'
        ? 'translate'
        : path.startsWith('/api/research/')
          ? 'research'
          : 'chat'
    if (!plan.features[feature])
      throw membershipError(
        '套餐未包含此功能 / Feature unavailable',
        403,
        'membership_feature_unavailable',
      )
    const ctx = memberCalls.getStore()
    if (ctx) {
      ctx.username = username
      ctx.chat = exactProfile(plan.chatProfile)
      ctx.research = exactProfile(plan.researchProfile)
      ctx.chatName = plan.chatProfile
      ctx.researchName = plan.researchProfile
      ctx.features = plan.features
      ctx.versionId = String(r.version_id)
      ctx.revision = Number(r.revision)
    }
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({ path, body: body ?? null }))
      .digest('hex')
    if (operationKey) {
      if (operationKey.length > 128) throw membershipError('操作编号过长')
      const [old] = await tx.execute(
        sql`SELECT * FROM membership_reservations WHERE username=${username} AND operation_key=${operationKey}`,
      )
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw membershipError(
            '幂等编号对应不同内容',
            409,
            'idempotency_conflict',
          )
        if (old.state === 'accepted')
          return {
            id: String(old.id),
            username,
            day: String(old.day),
            replay: { statusCode: Number(old.status_code), body: old.response },
          }
        if (old.state === 'reserved')
          throw membershipError(
            '相同请求正在处理中，请稍后重试',
            409,
            'idempotency_in_progress',
          )
      }
    }
    await tx.execute(
      sql`INSERT INTO membership_usage(username,day) VALUES(${username},${day}) ON CONFLICT DO NOTHING`,
    )
    const [counter] = await tx.execute(
      sql`SELECT * FROM membership_usage WHERE username=${username} AND day=${day} FOR UPDATE`,
    )
    if (plan.dailyLimit !== null && Number(counter.used) >= plan.dailyLimit)
      throw membershipError(
        '今日 AI 次数已达上限 / Daily quota exceeded',
        429,
        'ai_daily_limit_exceeded',
      )
    if (
      now - Number(counter.window_at) < 60000 &&
      Number(counter.window_used) >= plan.requestsPerMinute
    )
      throw membershipError(
        'AI 请求过于频繁 / Too many requests',
        429,
        'ai_rate_limited',
      )
    await tx.execute(
      sql`UPDATE membership_usage SET used=used+1,window_used=CASE WHEN ${now}::bigint-window_at>=60000 THEN 1 ELSE window_used+1 END,window_at=CASE WHEN ${now}::bigint-window_at>=60000 THEN ${now}::bigint ELSE window_at END WHERE username=${username} AND day=${day}`,
    )
    const id = crypto.randomUUID()
    const [saved] = await tx.execute(
      sql`INSERT INTO membership_reservations(id,username,day,operation_key,fingerprint,state) VALUES(${id},${username},${day},${operationKey ?? null},${fingerprint},'reserved') ON CONFLICT(username,operation_key) DO UPDATE SET day=excluded.day,state='reserved',created_at=now(),response=NULL,status_code=NULL RETURNING id`,
    )
    return { id: String(saved.id), username, day }
  })
}
export async function settleMembership(
  r: MemberReservation,
  success: boolean,
  statusCode = 200,
  body: unknown = null,
): Promise<void> {
  await membershipDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`membership:${r.username}`},0))`,
    )
    const rows = await tx.execute(
      sql`UPDATE membership_reservations SET state=${success ? 'accepted' : 'refunded'},status_code=${statusCode},response=${JSON.stringify(body)}::jsonb WHERE id=${r.id} AND state='reserved' RETURNING day`,
    )
    if (!success && rows.length)
      await tx.execute(
        sql`UPDATE membership_usage SET used=GREATEST(0,used-1) WHERE username=${r.username} AND day=${String(rows[0].day)}`,
      )
  })
}
export function registerMembershipMeter(
  app: FastifyInstance,
  deps: { requireSession: (req: FastifyRequest) => SessionRecord },
  metered: (method: string, path: string) => boolean,
) {
  app.addHook('onRequest', (_req, _reply, done) => {
    memberCalls.run({}, done)
  })
  app.addHook('preHandler', async (req, reply) => {
    const path = req.routeOptions.url || req.url.split('?')[0]
    if (!metered(req.method, path)) return
    const s = deps.requireSession(req),
      key = req.headers['idempotency-key']
    const reservation = await reserveMembership(
      s.username,
      req.url.split('?')[0],
      req.body,
      typeof key === 'string' ? key : undefined,
    )
    if (reservation?.replay) {
      const body = reservation.replay.body as {
        stream?: { text: string; conversationId: string }
      } | null
      if (body?.stream)
        return reply
          .code(reservation.replay.statusCode)
          .type('text/plain; charset=utf-8')
          .header('x-conversation-id', body.stream.conversationId)
          .send(body.stream.text)
      return reply
        .code(reservation.replay.statusCode)
        .send(reservation.replay.body)
    }
    if (reservation) reservations.set(req, reservation)
  })
  app.addHook('onError', async (req) => {
    const r = reservations.get(req)
    if (r) {
      reservations.delete(req)
      await settleMembership(r, false)
    }
  })
  app.addHook('onSend', async (req, reply, payload) => {
    const r = reservations.get(req)
    if (r) {
      reservations.delete(req)
      let body: unknown = null
      if (typeof payload === 'string') {
        try {
          body = JSON.parse(payload)
        } catch {
          body = { message: payload }
        }
      }
      await settleMembership(r, reply.statusCode < 400, reply.statusCode, body)
    }
    return payload
  })
  app.addHook('onResponse', async (req) => {
    // A disconnected/unfinished hijacked stream must not leave a permanent charge.
    await settleMemberStream(req, false)
  })
}

/** Reconcile reservations left by a crashed HTTP process; normal requests finish well below one hour. */
export async function recoverAbandonedMembershipReservations(): Promise<number> {
  const db = membershipDb()
  const users = await db.execute(
    sql`SELECT DISTINCT username FROM membership_reservations WHERE state='reserved' AND created_at < now()-interval '1 hour' LIMIT 100`,
  )
  let recovered = 0
  for (const user of users) {
    recovered += await db.transaction(async (tx) => {
      const username = String(user.username)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`membership:${username}`},0))`,
      )
      const rows = await tx.execute(sql`WITH recovered AS (
        UPDATE membership_reservations SET state='refunded' WHERE username=${username} AND state='reserved' AND created_at<now()-interval '1 hour' RETURNING day
      ), totals AS (SELECT day,count(*)::int AS n FROM recovered GROUP BY day)
      UPDATE membership_usage u SET used=GREATEST(0,u.used-t.n) FROM totals t WHERE u.username=${username} AND u.day=t.day RETURNING u.day`)
      return rows.length
    })
  }
  await db.execute(
    sql`DELETE FROM membership_reservations WHERE id IN (SELECT id FROM membership_reservations WHERE state<>'reserved' AND created_at<now()-interval '30 days' LIMIT 1000)`,
  )
  return recovered
}
