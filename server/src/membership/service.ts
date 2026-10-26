import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import {
  MembershipGrantInputSchema,
  MembershipPlanSchema,
  MembershipRefreshSchema,
} from 'biance-vision-brooks'
import type {
  MembershipPlan,
  MembershipPeriod,
  MembershipStatus,
  MembershipGrantInput,
  MembershipRefresh,
  MembershipPlanRecord,
  MembershipCampaign,
  PublicMembershipCatalog,
} from 'biance-vision-brooks'
import { getDb } from '../db.js'
import { getAiProfilesMasked, aiProfileByName } from '../ai.js'
import { readWebsiteContacts } from '../admin/websiteSettings.js'

type Db = NonNullable<ReturnType<typeof getDb>>
export type Executor = Pick<Db, 'execute'>
export const membershipError = (
  message: string,
  statusCode = 400,
  code = 'membership_invalid',
) => Object.assign(new Error(message), { statusCode, code })
export function membershipDb(): Db {
  const db = getDb()
  if (!db)
    throw membershipError(
      '会员服务暂不可用 / Membership unavailable',
      503,
      'membership_unavailable',
    )
  return db
}
export const epoch = (v: unknown): number => new Date(v as string).getTime()
export const dayOf = (now: number): string =>
  new Date(now + 8 * 3600000).toISOString().slice(0, 10)
export const nextDay = (now: number): number =>
  Date.parse(`${dayOf(now)}T00:00:00+08:00`) + 86400000
export function membershipEnd(
  start: number,
  unit: MembershipPlan['durationUnit'],
  count: number,
): number | null {
  if (unit === 'lifetime') return null
  if (unit === 'day') return start + count * 86400000
  const d = new Date(start + 8 * 3600000),
    date = d.getUTCDate()
  d.setUTCDate(1)
  if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + count)
  else d.setUTCFullYear(d.getUTCFullYear() + count)
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate()
  d.setUTCDate(Math.min(date, last))
  return d.getTime() - 8 * 3600000
}
export const micros = (s: string): bigint => {
  const [whole, fraction = ''] = s.split('.')
  return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))
}
export function validateProfiles(plan: MembershipPlan): void {
  const profiles = getAiProfilesMasked()
  for (const name of [plan.chatProfile, plan.researchProfile]) {
    const p = profiles[name]
    if (!p?.model || !p.apiKeyMasked || !p.baseUrl)
      throw membershipError(`AI 档案不可用：${name}`)
  }
}
export function exactProfile(name: string) {
  if (!getAiProfilesMasked()[name])
    throw membershipError(
      `AI 档案不可用：${name}`,
      503,
      'membership_ai_unavailable',
    )
  const p = aiProfileByName(name)
  if (!p?.apiKey || !p.baseUrl || !p.model)
    throw membershipError(
      `AI 档案不可用：${name}`,
      503,
      'membership_ai_unavailable',
    )
  return p
}
let refreshCache: { until: number; value: MembershipRefresh } | null = null
let refreshFlight: Promise<MembershipRefresh> | null = null
export async function readRefresh(): Promise<MembershipRefresh> {
  if (refreshCache && refreshCache.until > Date.now()) return refreshCache.value
  if (refreshFlight) return refreshFlight
  refreshFlight = (async () => {
    const [r] = await membershipDb().execute(
      sql`SELECT * FROM membership_refresh_settings WHERE id='global'`,
    )
    if (!r) throw membershipError('刷新配置不可用', 503)
    const value = {
      ...MembershipRefreshSchema.parse(r.config),
      revision: Number(r.revision),
      updatedBy: String(r.updated_by),
      updatedAt: epoch(r.updated_at),
    }
    refreshCache = { until: Date.now() + 5000, value }
    return value
  })()
  try {
    return await refreshFlight
  } finally {
    refreshFlight = null
  }
}
export async function saveRefresh(input: unknown, operator: string) {
  const { z } = await import('zod')
  const v = MembershipRefreshSchema.extend({
    expectedRevision: z.number().int().positive(),
  })
    .strict()
    .parse(input)
  const { expectedRevision, ...config } = v
  const rows = await membershipDb().execute(
    sql`UPDATE membership_refresh_settings SET config=${JSON.stringify(config)}::jsonb,revision=revision+1,updated_at=now(),updated_by=${operator} WHERE id='global' AND revision=${expectedRevision} RETURNING id`,
  )
  if (!rows.length)
    throw membershipError(
      '配置已更新，请刷新后重试 / Configuration changed',
      409,
      'revision_conflict',
    )
  // An older in-flight read must finish before invalidating this process's cache.
  await refreshFlight
  refreshCache = null
  return readRefresh()
}
export async function listPlans(): Promise<MembershipPlanRecord[]> {
  const db = membershipDb()
  const rows = await db.execute(
    sql`SELECT p.*,coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'revision',v.revision,'config',v.config,'createdAt',extract(epoch from v.created_at)*1000) ORDER BY v.revision DESC) FROM membership_plan_versions v WHERE v.plan_id=p.id),'[]'::jsonb) AS versions FROM membership_plans p ORDER BY (draft->>'sortOrder')::int,id`,
  )
  return rows.map((r) => ({
    id: String(r.id),
    draft: MembershipPlanSchema.parse(r.draft),
    revision: Number(r.revision),
    publishedVersionId: r.published_version_id as string | null,
    enabled: !!r.enabled,
    versions: r.versions as MembershipPlanRecord['versions'],
  }))
}
export async function savePlan(
  id: string,
  config: unknown,
  expectedRevision: number,
  operator: string,
) {
  const plan = MembershipPlanSchema.parse(config)
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id)) throw membershipError('套餐标识不合法')
  const db = membershipDb()
  if (expectedRevision === 0) {
    const rows = await db.execute(
      sql`INSERT INTO membership_plans(id,draft,updated_by) VALUES(${id},${JSON.stringify(plan)}::jsonb,${operator}) ON CONFLICT DO NOTHING RETURNING id`,
    )
    if (!rows.length) throw membershipError('套餐已存在', 409)
  } else {
    const rows = await db.execute(
      sql`UPDATE membership_plans SET draft=${JSON.stringify(plan)}::jsonb,revision=revision+1,updated_at=now(),updated_by=${operator} WHERE id=${id} AND revision=${expectedRevision} RETURNING id`,
    )
    if (!rows.length)
      throw membershipError(
        '套餐已修改，请刷新后重试',
        409,
        'revision_conflict',
      )
  }
}
export async function publishPlan(
  id: string,
  expectedRevision: number,
  operator: string,
) {
  return membershipDb().transaction(async (tx) => {
    const [r] = await tx.execute(
      sql`SELECT * FROM membership_plans WHERE id=${id} FOR UPDATE`,
    )
    if (!r || Number(r.revision) !== expectedRevision)
      throw membershipError(
        '套餐已修改，请刷新后重试',
        409,
        'revision_conflict',
      )
    const plan = MembershipPlanSchema.parse(r.draft)
    validateProfiles(plan)
    const versionId = crypto.randomUUID()
    const duplicate = await tx.execute(
      sql`SELECT id FROM membership_plan_versions WHERE plan_id=${id} AND revision=${expectedRevision}`,
    )
    if (duplicate.length)
      throw membershipError('此版本已发布；修改草稿后再发布', 409)
    await tx.execute(
      sql`INSERT INTO membership_plan_versions(id,plan_id,revision,config,created_by) VALUES(${versionId},${id},${expectedRevision},${JSON.stringify(plan)}::jsonb,${operator})`,
    )
    await tx.execute(
      sql`UPDATE membership_plans SET enabled=true,published_version_id=${versionId},updated_by=${operator},updated_at=now() WHERE id=${id}`,
    )
    return versionId
  })
}
export async function campaigns(): Promise<MembershipCampaign[]> {
  const rows = await membershipDb().execute(
    sql`SELECT c.*,(SELECT count(*)::int FROM membership_redemptions r WHERE r.campaign_id=c.id) AS used FROM membership_campaigns c ORDER BY id`,
  )
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    enabled: !!r.enabled,
    capacity: Number(r.capacity),
    used: Number(r.used),
    remaining: Math.max(0, Number(r.capacity) - Number(r.used)),
    startsAt: r.starts_at ? epoch(r.starts_at) : null,
    endsAt: r.ends_at ? epoch(r.ends_at) : null,
    revision: Number(r.revision),
  }))
}
export const periodOf = (r: Record<string, unknown>): MembershipPeriod => {
  const p = MembershipPlanSchema.parse(r.config)
  return {
    id: String(r.id),
    planId: String(r.plan_id),
    versionId: String(r.version_id),
    revision: Number(r.revision),
    name: p.name,
    nameEn: p.nameEn,
    startsAt: epoch(r.starts_at),
    endsAt: r.ends_at ? epoch(r.ends_at) : null,
    dailyLimit: p.dailyLimit,
    requestsPerMinute: p.requestsPerMinute,
    features: p.features,
  }
}
export async function activeMembership(
  username: string,
  ex: Executor = membershipDb(),
  now = Date.now(),
) {
  const [r] =
    await ex.execute(sql`SELECT a.disabled,u.chat_policy,g.id,g.version_id,g.starts_at,g.ends_at,v.plan_id,v.revision,v.config
    FROM membership_accounts a JOIN users u ON u.username=a.username
    LEFT JOIN LATERAL (SELECT * FROM membership_grants WHERE username=a.username AND revoked_at IS NULL AND starts_at <= ${new Date(now).toISOString()} AND (ends_at IS NULL OR ends_at > ${new Date(now).toISOString()}) ORDER BY starts_at DESC LIMIT 1) g ON true
    LEFT JOIN membership_plan_versions v ON v.id=g.version_id WHERE a.username=${username}`)
  return r ?? null
}
let contactCache: {
  until: number
  value: Awaited<ReturnType<typeof readWebsiteContacts>>
} | null = null
let contactFlight: Promise<
  Awaited<ReturnType<typeof readWebsiteContacts>>
> | null = null
async function membershipContacts() {
  if (contactCache && contactCache.until > Date.now()) return contactCache.value
  if (contactFlight) return contactFlight
  contactFlight = readWebsiteContacts().then((value) => {
    contactCache = { until: Date.now() + 5000, value }
    return value
  })
  try {
    return await contactFlight
  } finally {
    contactFlight = null
  }
}
export async function membershipStatus(
  username: string,
  forAdmin = false,
): Promise<MembershipStatus> {
  const now = Date.now(),
    db = membershipDb()
  const [result, refresh, contacts] = await Promise.all([
    db.execute(
      sql`SELECT a.username AS managed_username,a.disabled,u.chat_policy,legacy.value AS legacy_access,coalesce((SELECT jsonb_agg(jsonb_build_object('id',g.id,'version_id',g.version_id,'starts_at',g.starts_at,'ends_at',g.ends_at,'plan_id',v.plan_id,'revision',v.revision,'config',v.config) ORDER BY g.starts_at) FROM ((SELECT * FROM membership_grants WHERE username=a.username AND revoked_at IS NULL AND starts_at <= ${new Date(now).toISOString()} ORDER BY starts_at DESC LIMIT 1) UNION ALL (SELECT * FROM membership_grants WHERE username=a.username AND revoked_at IS NULL AND starts_at > ${new Date(now).toISOString()} ORDER BY starts_at LIMIT 24)) g JOIN membership_plan_versions v ON v.id=g.version_id),'[]'::jsonb) AS periods,coalesce(mu.used,0)::int AS used FROM users u LEFT JOIN membership_accounts a ON a.username=u.username LEFT JOIN app_settings legacy ON a.username IS NULL AND legacy.key=${`ai_access:${username}`} LEFT JOIN membership_usage mu ON mu.username=a.username AND mu.day=${dayOf(now)} WHERE u.username=${username}`,
    ),
    readRefresh(),
    membershipContacts(),
  ])
  const r = result[0]
  const managed = !!r?.managed_username
  const legacy = !managed
    ? (r?.legacy_access as { totalLimit: number; used: number } | null)
    : null
  const periods = r
    ? (r.periods as Record<string, unknown>[]).map(periodOf)
    : []
  const current = periods.find((p) => p.startsAt <= now) ?? null
  const disabled =
    !!r &&
    (!!r.disabled ||
      (r.chat_policy as { disabled?: boolean } | null)?.disabled === true)
  return {
    legacyAccess: legacy
      ? {
          totalLimit: legacy.totalLimit,
          used: legacy.used,
          remaining: Math.max(0, legacy.totalLimit - legacy.used),
        }
      : undefined,
    managed,
    status: !managed
      ? 'legacy'
      : disabled
        ? 'disabled'
        : !current || (current.endsAt !== null && current.endsAt <= now)
          ? 'expired'
          : current.planId === 'trial'
            ? 'trial'
            : 'active',
    current,
    upcoming: periods.filter((p) => p.startsAt > now),
    usedToday: Number(r?.used ?? 0),
    remainingToday:
      managed &&
      (disabled ||
        !current ||
        (current.endsAt !== null && current.endsAt <= now))
        ? 0
        : current?.dailyLimit == null
          ? null
          : Math.max(0, current.dailyLimit - Number(r?.used ?? 0)),
    nextResetAt: nextDay(now),
    serverTime: now,
    refresh: {
      userSeconds: refresh.userSeconds,
      revision: refresh.revision,
      ...(forAdmin ? { adminSeconds: refresh.adminSeconds } : {}),
    },
    contacts: { telegram: contacts.telegram, email: contacts.email },
  }
}
export async function assignMembership(
  ex: Executor,
  username: string,
  raw: unknown,
  operator: string,
  now = Date.now(),
) {
  const input = MembershipGrantInputSchema.parse(raw)
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ username, ...input }))
    .digest('hex')
  await ex.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`membership-op:${input.operationId}`},0))`,
  )
  const [previous] = await ex.execute(
    sql`SELECT * FROM membership_receipts WHERE operation_id=${input.operationId}`,
  )
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw membershipError(
        '相同操作编号对应了不同内容',
        409,
        'idempotency_conflict',
      )
    return {
      grantId: String(previous.grant_id),
      receiptId: String(previous.id),
      replay: true,
    }
  }
  await ex.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`membership:${username}`},0))`,
  )
  const [user] = await ex.execute(
    sql`SELECT role FROM users WHERE username=${username}`,
  )
  if (!user || user.role !== 'user')
    throw membershipError('仅可为普通用户开通会员', 404)
  const [v] = await ex.execute(
    sql`SELECT v.*,p.enabled,p.published_version_id FROM membership_plan_versions v JOIN membership_plans p ON p.id=v.plan_id WHERE v.id=${input.versionId} FOR SHARE OF p`,
  )
  if (!v || !v.enabled || v.published_version_id !== input.versionId)
    throw membershipError('请选择在售套餐的当前发布版本', 409)
  const plan = MembershipPlanSchema.parse(v.config)
  validateProfiles(plan)
  const [account] = await ex.execute(
    sql`SELECT * FROM membership_accounts WHERE username=${username}`,
  )
  if ((input.action === 'bind' || input.action === 'migrate') && account)
    throw membershipError('用户已绑定套餐，请选择续费或切换', 409)
  if ((input.action === 'renew' || input.action === 'switch') && !account)
    throw membershipError('请先绑定套餐', 409)
  const periods = await ex.execute(
    sql`SELECT g.*,v.plan_id FROM membership_grants g JOIN membership_plan_versions v ON v.id=g.version_id WHERE username=${username} AND revoked_at IS NULL AND (ends_at IS NULL OR ends_at > ${new Date(now).toISOString()}) ORDER BY starts_at`,
  )
  let start = now
  if (input.action === 'renew' && periods.length) {
    if (periods.some((p) => p.ends_at == null))
      throw membershipError('终身会员无需续费')
    if (periods.some((p) => p.plan_id !== v.plan_id))
      throw membershipError('不同套餐请使用立即切换')
    start = Math.max(now, ...periods.map((p) => epoch(p.ends_at)))
  }
  if (input.action === 'renew' && !periods.length) {
    const [last] = await ex.execute(
      sql`SELECT v.plan_id FROM membership_grants g JOIN membership_plan_versions v ON v.id=g.version_id WHERE g.username=${username} AND g.revoked_at IS NULL ORDER BY g.starts_at DESC LIMIT 1`,
    )
    if (last && last.plan_id !== v.plan_id)
      throw membershipError('不同套餐请使用立即切换')
  }
  if (input.action === 'switch' && !input.confirmReplace)
    throw membershipError(
      '请确认替换当前及待生效授权，剩余金额和天数不自动折算',
    )
  if (v.plan_id === 'trial') {
    const usedTrial = await ex.execute(
      sql`SELECT 1 FROM membership_grants g JOIN membership_plan_versions v ON v.id=g.version_id WHERE username=${username} AND v.plan_id='trial' LIMIT 1`,
    )
    if (usedTrial.length) throw membershipError('每个账号仅可试用一次')
  }
  if (micros(plan.price) === 0n && micros(input.paidAmount) !== 0n)
    throw membershipError('免费套餐实收必须为零')
  if (micros(plan.price) > 0n && micros(input.paidAmount) <= 0n)
    throw membershipError('付费套餐需要填写实际到账金额')
  if (input.paidAt > now + 60000)
    throw membershipError('到账时间不能晚于当前时间')
  await ex.execute(
    sql`INSERT INTO membership_accounts(username,updated_by) VALUES(${username},${operator}) ON CONFLICT DO NOTHING`,
  )
  let campaignId: string | null = null
  if (input.useIntro) {
    if (micros(plan.price) === 0n) throw membershipError('试用不占优惠名额')
    const priorPaid = await ex.execute(
      sql`SELECT 1 FROM membership_receipts WHERE username=${username} AND paid_amount>0 LIMIT 1`,
    )
    if (priorPaid.length || input.action === 'renew')
      throw membershipError('内测价仅用于首次付费')
    const [c] = await ex.execute(
      sql`SELECT * FROM membership_campaigns WHERE id='founders' FOR UPDATE`,
    )
    if (
      !c ||
      !c.enabled ||
      (c.starts_at && epoch(c.starts_at) > now) ||
      (c.ends_at && epoch(c.ends_at) <= now)
    )
      throw membershipError('优惠活动未开放', 409)
    const [count] = await ex.execute(
      sql`SELECT count(*)::int AS n FROM membership_redemptions WHERE campaign_id='founders'`,
    )
    if (Number(count.n) >= Number(c.capacity))
      throw membershipError(
        '内测名额已用完，请按正式价重新确认',
        409,
        'membership_intro_sold_out',
      )
    campaignId = 'founders'
  }
  const expected = campaignId ? plan.introPrice : plan.price
  if (micros(expected) !== micros(input.paidAmount) && !input.note.trim())
    throw membershipError('实收与套餐价格不一致，请填写原因')
  if (input.action === 'switch') {
    await ex.execute(
      sql`UPDATE membership_grants SET revoked_at=${new Date(now).toISOString()} WHERE username=${username} AND revoked_at IS NULL AND (ends_at IS NULL OR ends_at > ${new Date(now).toISOString()})`,
    )
  }
  // Carry today's pre-migration usage into the new counter without altering legacy records.
  await ex.execute(sql`INSERT INTO membership_usage(username,day,used) SELECT ${username},${dayOf(now)},GREATEST(
    coalesce((SELECT CASE WHEN value->>'dailyDate'=${dayOf(now)} THEN (value->>'dailyUsed')::int ELSE 0 END FROM app_settings WHERE key=${`ai_access:${username}`}),0),
    coalesce((SELECT CASE WHEN value->>'date'=${dayOf(now)} THEN (value->'counts'->>${username})::int ELSE 0 END FROM app_settings WHERE key='chat_usage'),0)) ON CONFLICT DO NOTHING`)
  const grantId = crypto.randomUUID(),
    receiptId = crypto.randomUUID(),
    end = membershipEnd(start, plan.durationUnit, plan.durationCount)
  await ex.execute(
    sql`INSERT INTO membership_grants(id,username,version_id,starts_at,ends_at,note,created_by) VALUES(${grantId},${username},${input.versionId},${new Date(start).toISOString()},${end === null ? null : new Date(end).toISOString()},${input.note},${operator})`,
  )
  await ex.execute(
    sql`INSERT INTO membership_receipts(id,username,grant_id,operation_id,fingerprint,action,expected_amount,paid_amount,currency,paid_at,payment_reference,note,created_by) VALUES(${receiptId},${username},${grantId},${input.operationId},${fingerprint},${input.action},${expected},${input.paidAmount},'USDT',${new Date(input.paidAt).toISOString()},${input.paymentReference},${input.note},${operator})`,
  )
  if (campaignId)
    await ex.execute(
      sql`INSERT INTO membership_redemptions(campaign_id,username,receipt_id) VALUES(${campaignId},${username},${receiptId})`,
    )
  return { grantId, receiptId, replay: false }
}
let catalogCache: { until: number; data: PublicMembershipCatalog } | null = null
export function invalidateCatalog(): void {
  catalogCache = null
}
export async function publicCatalog(): Promise<PublicMembershipCatalog> {
  if (catalogCache && catalogCache.until > Date.now()) return catalogCache.data
  const [rows, refresh, allCampaigns] = await Promise.all([
    membershipDb().execute(
      sql`SELECT p.id,v.id AS version_id,v.revision,v.config FROM membership_plans p JOIN membership_plan_versions v ON v.id=p.published_version_id WHERE p.enabled=true AND (v.config->>'public')::boolean=true ORDER BY (v.config->>'sortOrder')::int,p.id`,
    ),
    readRefresh(),
    campaigns(),
  ])
  const now = Date.now()
  const c =
    allCampaigns.find(
      (c) =>
        c.enabled &&
        (c.startsAt === null || c.startsAt <= now) &&
        (c.endsAt === null || c.endsAt > now),
    ) ?? null
  const data: PublicMembershipCatalog = {
    plans: rows.map((r) => {
      const p = MembershipPlanSchema.parse(r.config)
      return {
        id: String(r.id),
        versionId: String(r.version_id),
        revision: Number(r.revision),
        name: p.name,
        nameEn: p.nameEn,
        description: p.description,
        descriptionEn: p.descriptionEn,
        durationUnit: p.durationUnit,
        durationCount: p.durationCount,
        price: p.price,
        introPrice: p.introPrice,
        currency: p.currency,
        dailyLimit: p.dailyLimit,
        features: p.features,
      }
    }),
    campaign: c,
    refreshSeconds: refresh.publicSeconds,
    serverTime: now,
  }
  catalogCache = { until: now + 5000, data }
  return data
}

export async function assertProfilesRetained(names: string[]): Promise<void> {
  if (!names.length) return
  const rows = await membershipDb().execute(
    sql`SELECT 1 FROM membership_plan_versions WHERE config->>'chatProfile' IN ${sql`(${sql.join(
      names.map((n) => sql`${n}`),
      sql`,`,
    )})`} OR config->>'researchProfile' IN ${sql`(${sql.join(
      names.map((n) => sql`${n}`),
      sql`,`,
    )})`} LIMIT 1`,
  )
  if (rows.length)
    throw membershipError(
      'AI 档案已被发布的会员套餐引用，不能删除；可更新连接配置',
      409,
      'membership_profile_referenced',
    )
}
