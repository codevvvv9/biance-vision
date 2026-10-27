import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SessionRecord } from '../users.js'
import { hashPassword, initUsers } from '../users.js'
import { MembershipGrantInputSchema } from 'biance-vision-brooks'
import { guardAdminMutation } from '../admin/mutationGuard.js'
import { recordAudit } from '../audit.js'
import {
  membershipDb,
  membershipError,
  listPlans,
  savePlan,
  publishPlan,
  campaigns,
  readRefresh,
  saveRefresh,
  membershipStatus,
  assignMembership,
  publicCatalog,
  invalidateCatalog,
  dayOf,
} from './service.js'
import { recordHttpMetric } from '../observability/metrics.js'

function audit(session: SessionRecord, target: string, detail: string) {
  recordAudit(session, { action: 'settings_update', target, detail })
}
/** 开通交付文本里的登录链接。默认落在价格行为页 /brooks——研究终端有会员
 * 门禁（v0.23 三层门禁），trial 等未含研究权限的新账号直接跳 /research 会被
 * 挡；/brooks 是所有登录用户可用的基线页。运营要换落地页时在 VPS .env 配
 * PROVISION_LOGIN_PATH（免发版，up -d 重启生效）；仅接受站内相对路径，
 * 非法值一律回退默认（fail-safe，防止配置错误把交付链接指到外站）。 */
export function provisionLoginPath(): string {
  const v = process.env.PROVISION_LOGIN_PATH
  if (
    v &&
    v.startsWith('/') &&
    !v.startsWith('//') &&
    !/[\s\x00-\x1f\\]/.test(v) &&
    v.length <= 200
  )
    return v
  return '/login?ui=dev&returnTo=%2Fbrooks'
}
export async function provisionMember(raw: unknown, operator: string) {
  const input = MembershipGrantInputSchema.extend({
    username: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{3,32}$/)
      .optional(),
  })
    .strict()
    .parse(raw)
  if (input.action !== 'bind') throw membershipError('新账号必须使用开通操作')
  const username =
      input.username || `bv_${crypto.randomBytes(6).toString('hex')}`,
    password = crypto.randomBytes(18).toString('base64url')
  const hash = await hashPassword(password)
  const result = await membershipDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`membership-op:${input.operationId}`},0))`,
    )
    const previous = await tx.execute(
      sql`SELECT id FROM membership_receipts WHERE operation_id=${input.operationId}`,
    )
    if (previous.length)
      throw membershipError(
        '此开通已完成，请查询账号；交付密码未持久化，可通过重置密码重新交付',
        409,
        'provision_already_completed',
      )
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provision:${username.toLowerCase()}`},0))`,
    )
    const duplicate = await tx.execute(
      sql`SELECT 1 FROM users WHERE lower(username)=${username.toLowerCase()}`,
    )
    if (duplicate.length) throw membershipError('用户名已存在', 409)
    await tx.execute(
      sql`INSERT INTO users(id,username,password_hash,role,chat_policy) VALUES(${crypto.randomUUID()},${username},${hash},'user','{"disabled":false,"dailyLimit":null}'::jsonb)`,
    )
    const { username: _, ...grantInput } = input
    return assignMembership(tx, username, grantInput, operator)
  })
  await initUsers({ seed: false })
  invalidateCatalog()
  let publicOrigin: string | null = null
  try {
    const u = new URL(process.env.WEBSITE_ORIGIN || '')
    if (
      ['http:', 'https:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      u.pathname === '/' &&
      !u.search &&
      !u.hash
    )
      publicOrigin = u.origin
  } catch {
    /* relative delivery */
  }
  return {
    ...result,
    username,
    password,
    publicOrigin,
    loginPath: provisionLoginPath(),
    membership: await membershipStatus(username),
  }
}
export function registerMembershipAdminRoutes(
  app: FastifyInstance,
  deps: { requireSuperadmin: (req: FastifyRequest) => SessionRecord },
) {
  const mutate = (req: FastifyRequest, action: string) => {
    const s = deps.requireSuperadmin(req)
    guardAdminMutation(req, s.username, action, 30)
    return s
  }
  const statusHeaders = (reply: {
    header: (name: string, value: string) => unknown
  }) => {
    reply.header('Cache-Control', 'no-store')
  }
  app.get('/api/admin/membership/plans', async (req, reply) => {
    deps.requireSuperadmin(req)
    statusHeaders(reply)
    return { plans: await listPlans(), refresh: await readRefresh() }
  })
  app.put('/api/admin/membership/plans/:id', async (req, reply) => {
    const s = mutate(req, 'membership-plan'),
      b = z
        .object({
          config: z.unknown(),
          expectedRevision: z.number().int().min(0),
        })
        .strict()
        .parse(req.body)
    const id = (req.params as { id: string }).id
    await savePlan(id, b.config, b.expectedRevision, s.username)
    invalidateCatalog()
    audit(s, id, '保存会员套餐草稿')
    statusHeaders(reply)
    return { ok: true }
  })
  app.post('/api/admin/membership/plans/:id/publish', async (req, reply) => {
    const s = mutate(req, 'membership-publish'),
      b = z
        .object({ expectedRevision: z.number().int().positive() })
        .strict()
        .parse(req.body),
      id = (req.params as { id: string }).id
    const versionId = await publishPlan(id, b.expectedRevision, s.username)
    invalidateCatalog()
    audit(s, id, `发布会员套餐版本 ${versionId}`)
    statusHeaders(reply)
    return { versionId }
  })
  app.patch('/api/admin/membership/plans/:id', async (req, reply) => {
    const s = mutate(req, 'membership-listing'),
      b = z
        .object({
          enabled: z.boolean(),
          expectedRevision: z.number().int().positive(),
        })
        .strict()
        .parse(req.body),
      id = (req.params as { id: string }).id
    const rows = await membershipDb().execute(
      sql`UPDATE membership_plans SET enabled=${b.enabled},revision=revision+1,updated_at=now(),updated_by=${s.username} WHERE id=${id} AND revision=${b.expectedRevision} AND (NOT ${b.enabled} OR published_version_id IS NOT NULL) RETURNING id`,
    )
    if (!rows.length) throw membershipError('套餐版本已变化，或尚未发布', 409)
    invalidateCatalog()
    audit(s, id, b.enabled ? '上架套餐' : '下架套餐')
    statusHeaders(reply)
    return { ok: true }
  })
  app.get('/api/admin/membership/campaigns', async (req, reply) => {
    deps.requireSuperadmin(req)
    statusHeaders(reply)
    return { campaigns: await campaigns(), refresh: await readRefresh() }
  })
  app.put('/api/admin/membership/campaigns/:id', async (req, reply) => {
    const s = mutate(req, 'membership-campaign'),
      id = (req.params as { id: string }).id
    const b = z
      .object({
        name: z.string().min(1).max(100),
        enabled: z.boolean(),
        capacity: z.number().int().min(0).max(1000000),
        startsAt: z.number().int().positive().nullable(),
        endsAt: z.number().int().positive().nullable(),
        expectedRevision: z.number().int().positive(),
      })
      .strict()
      .parse(req.body)
    if (b.startsAt && b.endsAt && b.endsAt <= b.startsAt)
      throw membershipError('活动结束时间必须晚于开始时间')
    await membershipDb().transaction(async (tx) => {
      const [c] = await tx.execute(
        sql`SELECT * FROM membership_campaigns WHERE id=${id} FOR UPDATE`,
      )
      const [count] = await tx.execute(
        sql`SELECT count(*)::int AS n FROM membership_redemptions WHERE campaign_id=${id}`,
      )
      if (!c || Number(c.revision) !== b.expectedRevision)
        throw membershipError('活动已修改，请刷新', 409)
      if (b.capacity < Number(count.n))
        throw membershipError('名额不能小于已使用人数')
      await tx.execute(
        sql`UPDATE membership_campaigns SET name=${b.name},enabled=${b.enabled},capacity=${b.capacity},starts_at=${b.startsAt ? new Date(b.startsAt).toISOString() : null},ends_at=${b.endsAt ? new Date(b.endsAt).toISOString() : null},revision=revision+1,updated_by=${s.username} WHERE id=${id}`,
      )
    })
    invalidateCatalog()
    audit(s, id, '更新会员优惠活动')
    statusHeaders(reply)
    return { ok: true }
  })
  app.get('/api/admin/membership/refresh-settings', async (req, reply) => {
    deps.requireSuperadmin(req)
    statusHeaders(reply)
    return { refresh: await readRefresh() }
  })
  app.put('/api/admin/membership/refresh-settings', async (req, reply) => {
    const s = mutate(req, 'membership-refresh')
    const refresh = await saveRefresh(req.body, s.username)
    invalidateCatalog()
    audit(s, 'membership_refresh', `更新刷新设置 v${refresh.revision}`)
    statusHeaders(reply)
    return { refresh }
  })
  app.get('/api/admin/membership/users', async (req, reply) => {
    deps.requireSuperadmin(req)
    statusHeaders(reply)
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
        username: z.string().max(32).default(''),
      })
      .parse(req.query)
    const db = membershipDb(),
      now = new Date().toISOString()
    const users =
      await db.execute(sql`SELECT u.username,a.disabled AS membership_disabled,u.chat_policy,a.username IS NOT NULL AS managed,g.id,g.starts_at,g.ends_at,v.config,v.revision,coalesce(mu.used,0)::int AS used
      FROM users u LEFT JOIN membership_accounts a ON a.username=u.username
      LEFT JOIN LATERAL (SELECT * FROM membership_grants WHERE username=u.username AND revoked_at IS NULL AND starts_at<=${now} AND (ends_at IS NULL OR ends_at>${now}) ORDER BY starts_at DESC LIMIT 1) g ON true
      LEFT JOIN membership_plan_versions v ON v.id=g.version_id LEFT JOIN membership_usage mu ON mu.username=u.username AND mu.day=${dayOf(Date.now())}
      WHERE u.role='user' AND (${q.username}='' OR u.username ILIKE ${`%${q.username}%`}) ORDER BY u.username LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`)
    const [total] = await db.execute(
      sql`SELECT count(*)::int AS n FROM users WHERE role='user' AND (${q.username}='' OR username ILIKE ${`%${q.username}%`})`,
    )
    return { users, total: Number(total.n), refresh: await readRefresh() }
  })
  app.get('/api/admin/membership/stats', async (req, reply) => {
    deps.requireSuperadmin(req)
    statusHeaders(reply)
    const [stats] = await membershipDb().execute(
      // 口径（docs/specs/membership.md）：managed=进过会员体系的账号总数（含禁用/到期/internal）；
      // active=进行中授权且未停用的去重用户，internal 套餐（plan_id='internal'）移出 active 单列
      // internalActive——active 含有效 trial，不能解释为「付费会员数」；received 不受 internal
      // 影响（internal 价格恒为 0，实收必为 0）
      sql`SELECT (SELECT count(*)::int FROM membership_accounts) AS managed,(SELECT count(DISTINCT g.username)::int FROM membership_grants g JOIN membership_plan_versions v ON v.id=g.version_id JOIN membership_accounts a ON a.username=g.username JOIN users u ON u.username=g.username WHERE g.revoked_at IS NULL AND NOT a.disabled AND NOT coalesce((u.chat_policy->>'disabled')::boolean,false) AND g.starts_at<=now() AND (g.ends_at IS NULL OR g.ends_at>now()) AND v.plan_id<>'internal') AS active,(SELECT count(DISTINCT g.username)::int FROM membership_grants g JOIN membership_plan_versions v ON v.id=g.version_id JOIN membership_accounts a ON a.username=g.username JOIN users u ON u.username=g.username WHERE g.revoked_at IS NULL AND NOT a.disabled AND NOT coalesce((u.chat_policy->>'disabled')::boolean,false) AND g.starts_at<=now() AND (g.ends_at IS NULL OR g.ends_at>now()) AND v.plan_id='internal') AS "internalActive",(SELECT coalesce(sum(paid_amount),0)::text FROM membership_receipts WHERE voided_at IS NULL) AS received`,
    )
    return { stats, refresh: await readRefresh() }
  })
  app.get('/api/admin/users/:username/membership', async (req, reply) => {
    deps.requireSuperadmin(req)
    statusHeaders(reply)
    const username = (req.params as { username: string }).username
    const [membership, receipts, history] = await Promise.all([
      membershipStatus(username, true),
      membershipDb().execute(
        sql`SELECT id,grant_id,action,expected_amount,paid_amount,currency,paid_at,payment_reference,note,created_by,created_at,voided_at,void_reason FROM membership_receipts WHERE username=${username} ORDER BY created_at DESC LIMIT 50`,
      ),
      membershipDb().execute(
        sql`SELECT g.*,v.config,v.revision FROM membership_grants g JOIN membership_plan_versions v ON v.id=g.version_id WHERE g.username=${username} ORDER BY g.created_at DESC LIMIT 50`,
      ),
    ])
    return { membership, receipts, history }
  })
  app.post('/api/admin/users/:username/membership', async (req, reply) => {
    const s = mutate(req, 'membership-grant'),
      username = (req.params as { username: string }).username
    const result = await membershipDb().transaction((tx) =>
      assignMembership(tx, username, req.body, s.username),
    )
    invalidateCatalog()
    audit(s, username, `会员授权 ${result.grantId}`)
    statusHeaders(reply)
    return { ...result, membership: await membershipStatus(username, true) }
  })
  app.patch('/api/admin/users/:username/membership', async (req, reply) => {
    const s = mutate(req, 'membership-disable'),
      username = (req.params as { username: string }).username,
      b = z
        .object({
          disabled: z.boolean(),
          note: z.string().trim().min(1).max(1000),
        })
        .strict()
        .parse(req.body)
    await membershipDb().transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`membership:${username}`},0))`,
      )
      const r = await tx.execute(
        sql`UPDATE membership_accounts SET disabled=${b.disabled},updated_by=${s.username},updated_at=now() WHERE username=${username} RETURNING username`,
      )
      if (!r.length) throw membershipError('用户尚未绑定会员', 404)
      if (!b.disabled)
        await tx.execute(
          sql`UPDATE users SET chat_policy=jsonb_set(coalesce(chat_policy,'{}'::jsonb),'{disabled}','false'::jsonb) WHERE username=${username}`,
        )
    })
    if (!b.disabled) await initUsers({ seed: false })
    audit(
      s,
      username,
      `${b.disabled ? '停用会员' : '恢复会员并解除账号聊天停用'}：${b.note}`,
    )
    statusHeaders(reply)
    return { membership: await membershipStatus(username, true) }
  })
  app.post('/api/admin/membership/receipts/:id/void', async (req, reply) => {
    const s = mutate(req, 'membership-void'),
      id = (req.params as { id: string }).id,
      b = z
        .object({ reason: z.string().trim().min(1).max(1000) })
        .strict()
        .parse(req.body)
    await membershipDb().transaction(async (tx) => {
      const [lookup] = await tx.execute(
        sql`SELECT username FROM membership_receipts WHERE id=${id}`,
      )
      if (!lookup) throw membershipError('收款记录不存在', 404)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`membership:${lookup.username}`},0))`,
      )
      const [r] = await tx.execute(
        sql`UPDATE membership_receipts SET voided_at=now(),void_reason=${b.reason} WHERE id=${id} AND voided_at IS NULL RETURNING grant_id`,
      )
      if (r)
        await tx.execute(
          sql`UPDATE membership_grants SET revoked_at=now() WHERE id=${r.grant_id} AND revoked_at IS NULL`,
        )
    })
    audit(s, id, `撤销收款及对应授权（不自动退回优惠名额）：${b.reason}`)
    statusHeaders(reply)
    return { ok: true }
  })
}
export function registerMembershipUserRoutes(
  app: FastifyInstance,
  deps: { requireSession: (req: FastifyRequest) => SessionRecord },
) {
  app.get('/api/public/membership-plans', async (_req, reply) => {
    // The process cache supplies the five-second window; another HTTP cache must not double it.
    reply.header('Cache-Control', 'public, max-age=0, must-revalidate')
    return publicCatalog()
  })
  app.get('/api/users/me/membership', async (req, reply) => {
    const s = deps.requireSession(req),
      started = performance.now()
    reply.header('Cache-Control', 'no-store')
    let succeeded = false
    try {
      const result = await membershipStatus(s.username)
      succeeded = true
      return result
    } finally {
      recordHttpMetric(
        'membership-db',
        'membership.status.query',
        'READ',
        succeeded ? 200 : 500,
        performance.now() - started,
      )
    }
  })
}
