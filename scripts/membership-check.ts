import type { SessionRecord } from '../server/src/users.js'
/** Independent database and data directory. Does not open real AI endpoints or alter existing users. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'
const reqServer = createRequire(
  new URL('../server/package.json', import.meta.url),
)
const postgres = reqServer('postgres') as (
  url: string,
  opts?: object,
) => { unsafe: (s: string) => Promise<any[]>; end: () => Promise<void> }
const origin = new URL(
    process.env.ACCESS_TEST_PG_URL ||
      'postgresql://postgres:postgres@127.0.0.1:5434/postgres',
  ),
  root = postgres(origin.href, { max: 1 }),
  name = `bv_membership_${randomUUID().replaceAll('-', '')}`,
  dir = await mkdtemp(path.join(tmpdir(), 'bv-membership-'))
let exitCode = 0,
  count = 0
const pass = (label: string) => {
  count++
  console.log(`✔ ${label}`)
}
try {
  await root.unsafe(`CREATE DATABASE "${name}" OWNER biance_app`)
  origin.pathname = `/${name}`
  process.env.DATABASE_URL = origin.href
  process.env.BV_DATA_DIR = dir
  process.env.WEBSITE_PUBLIC_CONFIG_DIR = path.join(dir, 'public')
  const { initDb, getDb, sql } = await import('../server/src/db.js')
  assert.equal(await initDb(), true)
  const db = getDb()!
  const { saveAiProfiles, resolveAiProfile } = await import(
    '../server/src/ai.js'
  )
  const {
    listPlans,
    savePlan,
    publishPlan,
    assignMembership,
    membershipStatus,
    membershipEnd,
    dayOf,
    readRefresh,
    saveRefresh,
    publicCatalog,
    assertProfilesRetained,
  } = await import('../server/src/membership/service.js')
  const {
    provisionMember,
    registerMembershipAdminRoutes,
    registerMembershipUserRoutes,
  } = await import('../server/src/membership/routes.js')
  const {
    reserveMembership,
    settleMembership,
    settleMemberStream,
    recoverAbandonedMembershipReservations,
  } = await import('../server/src/membership/meter.js')
  const { registerAiAccessGuard } = await import('../server/src/aiAccess.js')
  const { memberCalls } = await import('../server/src/membership/context.js')
  const { freezeRunConfig } = await import(
    '../server/src/research/runs/store.js'
  )
  const { resolveLlmClient } = await import('../server/src/research/llm.js')
  const { hashPassword, initUsers, verifyLogin } = await import(
    '../server/src/users.js'
  )
  await initUsers({ seed: false })
  const profile = (model: string) => ({
    baseUrl: 'https://unused.invalid/v1',
    model,
    apiKey: 'test-key-never-sent',
    allowedUsers: [],
  })
  saveAiProfiles({
    profiles: {
      default: profile('chat-model'),
      research: profile('research-model'),
    },
  })
  const plans = await listPlans()
  assert.equal(plans.length, 4)
  assert.ok(plans.every((p) => !p.enabled && !p.publishedVersionId))
  const trial = plans.find((p) => p.id === 'trial')!,
    monthly = plans.find((p) => p.id === 'monthly')!,
    lifetime = plans.find((p) => p.id === 'lifetime')!
  await savePlan(
    'trial',
    {
      ...trial.draft,
      dailyLimit: 3,
      requestsPerMinute: 60,
      researchProfile: 'research',
    },
    trial.revision,
    'test',
  )
  const trialId = await publishPlan('trial', 2, 'test'),
    monthlyId = await publishPlan('monthly', 1, 'test'),
    lifetimeId = await publishPlan('lifetime', 1, 'test')
  await assert.rejects(() => savePlan('monthly', monthly.draft, 99, 'test'), {
    statusCode: 409,
  })
  await assert.rejects(() => assertProfilesRetained(['research']), {
    statusCode: 409,
  })
  const pub = JSON.stringify(await publicCatalog())
  assert.ok(!pub.includes('Profile'))
  assert.ok(!pub.includes('test-key'))
  assert.ok(!pub.includes('unused.invalid'))
  pass('草稿、发布、并发版本校验与公开字段隔离')
  const input = (
    versionId: string,
    amount = '0',
    action: 'bind' | 'renew' | 'switch' | 'migrate' = 'bind',
  ) => ({
    operationId: randomUUID(),
    versionId,
    action,
    confirmReplace: false,
    useIntro: false,
    paidAmount: amount,
    paidAt: Date.now(),
    paymentReference: 'test',
    note: 'isolated test',
  })
  const user = await provisionMember(
    { ...input(trialId), username: 'trial_member' },
    'test',
  )
  assert.ok(await verifyLogin(user.username, user.password))
  assert.equal(user.membership.current?.dailyLimit, 3)
  await assert.rejects(
    () =>
      provisionMember({ ...input(trialId), username: 'TRIAL_MEMBER' }, 'test'),
    { statusCode: 409 },
  )
  const replayInput = input(monthlyId, '15')
  await db.transaction((tx) =>
    assignMembership(
      tx,
      user.username,
      { ...replayInput, action: 'switch', confirmReplace: true },
      'test',
    ),
  )
  await assert.rejects(() =>
    db.transaction((tx) =>
      assignMembership(
        tx,
        user.username,
        { ...input(trialId), action: 'switch', confirmReplace: true },
        'test',
      ),
    ),
  )
  const primary = await provisionMember(
    { ...input(trialId), username: 'quota_member' },
    'test',
  )
  const results = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      reserveMembership(primary.username, '/api/ai/chat', {}),
    ),
  )
  const reserved = results.flatMap((r) =>
    r.status === 'fulfilled' && r.value ? [r.value] : [],
  )
  assert.equal(reserved.length, 3)
  assert.equal((await membershipStatus(primary.username)).usedToday, 3)
  await settleMembership(reserved[0], false)
  await settleMembership(reserved[0], false)
  assert.equal((await membershipStatus(primary.username)).usedToday, 2)
  const key = randomUUID(),
    res = await reserveMembership(
      primary.username,
      '/api/ai/chat',
      { hello: 'world' },
      key,
    )
  assert.ok(res)
  await settleMembership(res, true, 200, { ok: true })
  const replay = await reserveMembership(
    primary.username,
    '/api/ai/chat',
    { hello: 'world' },
    key,
  )
  assert.deepEqual(replay?.replay, { statusCode: 200, body: { ok: true } })
  await assert.rejects(
    () =>
      reserveMembership(
        primary.username,
        '/api/ai/chat',
        { different: true },
        key,
      ),
    { statusCode: 409 },
  )
  pass('并发 20 次仅受理 3 次；幂等预占、重放与失败只退一次')
  await savePlan(
    'trial',
    {
      ...trial.draft,
      dailyLimit: 9,
      requestsPerMinute: 60,
      researchProfile: 'research',
    },
    2,
    'test',
  )
  await publishPlan('trial', 3, 'test')
  assert.equal(
    (await membershipStatus(primary.username)).current?.dailyLimit,
    3,
  )
  const futureInput = input(monthlyId, '15', 'renew')
  await db.transaction((tx) =>
    assignMembership(tx, user.username, futureInput, 'test'),
  )
  const renewed = await membershipStatus(user.username)
  assert.equal(renewed.upcoming.length, 1)
  assert.equal(renewed.upcoming[0].startsAt, renewed.current?.endsAt)
  const again = await db.transaction((tx) =>
    assignMembership(tx, user.username, futureInput, 'test'),
  )
  assert.equal(again.replay, true)
  assert.equal((await membershipStatus(user.username)).upcoming.length, 1)
  await db.transaction((tx) =>
    assignMembership(
      tx,
      primary.username,
      { ...input(monthlyId, '15', 'switch'), confirmReplace: true },
      'test',
    ),
  )
  assert.equal((await membershipStatus(primary.username)).usedToday, 3)
  assert.equal(
    new Date(
      membershipEnd(Date.parse('2024-01-31T12:00:00+08:00'), 'month', 1)!,
    ).toISOString(),
    '2024-02-29T04:00:00.000Z',
  )
  assert.equal(
    new Date(
      membershipEnd(Date.parse('2024-02-29T12:00:00+08:00'), 'year', 1)!,
    ).toISOString(),
    '2025-02-28T04:00:00.000Z',
  )
  assert.equal(membershipEnd(Date.now(), 'lifetime', 1), null)
  pass('版本保留、续费时段、重复续费、切换保留用量、月末与闰年')
  await db.execute(
    sql`UPDATE membership_campaigns SET enabled=true,capacity=100 WHERE id='founders'`,
  )
  await db.execute(
    sql`INSERT INTO users(id,username,password_hash,role,chat_policy) SELECT 'seed-'||n,'seed_member_'||n,'not-a-login-hash','user','{"disabled":false}'::jsonb FROM generate_series(1,99) AS n`,
  )
  await db.execute(
    sql`INSERT INTO membership_accounts(username,updated_by) SELECT username,'test' FROM users WHERE username LIKE 'seed_member_%'`,
  )
  await db.execute(
    sql`INSERT INTO membership_grants(id,username,version_id,starts_at,ends_at,note,created_by) SELECT username,username,${lifetimeId},now(),NULL,'test','test' FROM membership_accounts WHERE username LIKE 'seed_member_%'`,
  )
  await db.execute(
    sql`INSERT INTO membership_receipts(id,username,grant_id,operation_id,fingerprint,action,expected_amount,paid_amount,currency,paid_at,payment_reference,note,created_by) SELECT username,username,username,username,username,'bind',100,100,'USDT',now(),'test','test','test' FROM membership_accounts WHERE username LIKE 'seed_member_%'`,
  )
  await db.execute(
    sql`INSERT INTO membership_redemptions(campaign_id,username,receipt_id) SELECT 'founders',username,username FROM membership_accounts WHERE username LIKE 'seed_member_%'`,
  )
  const firsts = await Promise.allSettled(
    ['intro_one', 'intro_two'].map((username) =>
      provisionMember(
        { ...input(lifetimeId, '100'), username, useIntro: true },
        'test',
      ),
    ),
  )
  assert.equal(firsts.filter((r) => r.status === 'fulfilled').length, 1)
  const [n] = await db.execute(
    sql`SELECT count(*)::int AS n FROM membership_redemptions`,
  )
  assert.equal(n.n, 100)
  const winner = firsts.find((r) => r.status === 'fulfilled')!
  if (winner.status === 'fulfilled') {
    await assert.rejects(() =>
      db.transaction((tx) =>
        assignMembership(
          tx,
          winner.value.username,
          input(lifetimeId, '299', 'renew'),
          'test',
        ),
      ),
    )
  }
  const [users] = await db.execute(
    sql`SELECT count(*)::int AS n FROM users WHERE username LIKE 'intro_%'`,
  )
  assert.equal(users.n, 1)
  pass('第 100/101 位内测用户竞争不超发，失败开通完整回滚，终身拒绝续费')
  const f = await readRefresh()
  assert.equal(f.userSeconds, 60)
  await saveRefresh(
    {
      userSeconds: 30,
      adminSeconds: 300,
      publicSeconds: 60,
      expectedRevision: f.revision,
    },
    'test',
  )
  await assert.rejects(
    () =>
      saveRefresh(
        {
          userSeconds: 60,
          adminSeconds: 60,
          publicSeconds: 60,
          expectedRevision: f.revision,
        },
        'test',
      ),
    { statusCode: 409 },
  )
  assert.equal((await readRefresh()).userSeconds, 30)
  await assert.rejects(() =>
    saveRefresh(
      {
        userSeconds: 29,
        adminSeconds: 60,
        publicSeconds: 60,
        expectedRevision: 2,
      },
      'test',
    ),
  )
  pass('刷新设置 30/300 边界、动态配置与冲突拒绝')
  const app = Fastify(),
    session = (username: string) =>
      ({
        username,
        role: 'user',
        purpose: 'user',
        token: 'test',
        expiresAt: Date.now() + 60000,
      }) as SessionRecord
  let username = primary.username,
    invoked = 0
  registerAiAccessGuard(app, { requireSession: () => session(username) })
  registerMembershipUserRoutes(app, { requireSession: () => session(username) })
  app.post('/api/ai/chat', async (req, reply) => {
    invoked++
    if ((req.body as { stream?: boolean })?.stream) {
      reply.hijack()
      reply.raw.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'x-conversation-id': 'stream-conversation',
      })
      reply.raw.write('first ')
      await settleMemberStream(
        req,
        !(req.body as { fail?: boolean }).fail,
        'first last',
        'stream-conversation',
      )
      reply.raw.end('last')
      return
    }
    if ((req.body as { fail?: boolean })?.fail)
      return reply.code(503).send({ message: 'test failure' })
    return { model: resolveAiProfile(username)?.model }
  })
  app.post('/api/research/runs', async (_req, reply) =>
    reply.code(202).send({ runId: 'accepted-run' }),
  )
  const before = (await membershipStatus(primary.username)).usedToday
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/ai/chat',
        payload: { fail: true },
      })
    ).statusCode,
    503,
  )
  assert.equal((await membershipStatus(primary.username)).usedToday, before)
  const ok = await app.inject({
    method: 'POST',
    url: '/api/ai/chat',
    headers: { 'idempotency-key': 'http-one' },
    payload: {},
  })
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.json().model, 'chat-model')
  const previousInvoked = invoked
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/ai/chat',
        headers: { 'idempotency-key': 'http-one' },
        payload: {},
      })
    ).statusCode,
    200,
  )
  assert.equal(invoked, previousInvoked)
  // Use a separate high-quota account for real hijacked responses.
  username = user.username
  const streamBefore = (await membershipStatus(username)).usedToday
  const streamRequest = {
    method: 'POST' as const,
    url: '/api/ai/chat',
    headers: { 'idempotency-key': 'stream-one' },
    payload: { stream: true },
  }
  const stream = await app.inject(streamRequest)
  assert.equal(stream.body, 'first last')
  assert.equal((await membershipStatus(username)).usedToday, streamBefore + 1)
  const streamInvoked = invoked
  const replayedStream = await app.inject(streamRequest)
  assert.equal(replayedStream.body, 'first last')
  assert.equal(
    replayedStream.headers['x-conversation-id'],
    'stream-conversation',
  )
  assert.equal(invoked, streamInvoked)
  await app.inject({
    method: 'POST',
    url: '/api/ai/chat',
    payload: { stream: true, fail: true },
  })
  assert.equal((await membershipStatus(username)).usedToday, streamBefore + 1)
  const abandoned = await reserveMembership(
    username,
    '/api/ai/chat',
    {},
    'crashed-process',
  )
  await db.execute(
    sql`UPDATE membership_reservations SET created_at=now()-interval '2 hours' WHERE id=${abandoned!.id}`,
  )
  await recoverAbandonedMembershipReservations()
  assert.equal((await membershipStatus(username)).usedToday, streamBefore + 1)
  const acceptedRun = await app.inject({
    method: 'POST',
    url: '/api/research/runs',
    payload: {},
  })
  assert.equal(acceptedRun.statusCode, 202)
  assert.equal((await membershipStatus(username)).usedToday, streamBefore + 2)
  await recoverAbandonedMembershipReservations()
  assert.equal((await membershipStatus(username)).usedToday, streamBefore + 2)
  pass('流式响应结算／重放、流中失败退额与崩溃预占回收幂等')
  username = primary.username
  await db.execute(
    sql`UPDATE membership_accounts SET disabled=true WHERE username=${primary.username}`,
  )
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/ai/chat', payload: {} }))
      .statusCode,
    403,
  )
  await db.execute(
    sql`UPDATE membership_accounts SET disabled=false WHERE username=${primary.username}`,
  )
  await db.execute(
    sql`UPDATE membership_grants SET starts_at=now()-interval '2 days',ends_at=now()-interval '1 day' WHERE username=${primary.username} AND revoked_at IS NULL`,
  )
  assert.equal(
    (await app.inject({ method: 'POST', url: '/api/ai/chat', payload: {} }))
      .statusCode,
    403,
  )
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/users/me/membership' }))
      .headers['cache-control'],
    'no-store',
  )
  const ownStatus = (
    await app.inject({ method: 'GET', url: '/api/users/me/membership' })
  ).json()
  assert.equal(ownStatus.refresh.updatedBy, undefined)
  assert.equal(ownStatus.refresh.adminSeconds, undefined)
  pass('真实 HTTP 钩子：聊天档案、响应重放、失败退额、停用／到期立即拒绝')
  await app.close()
  const fresh = await provisionMember(
    {
      ...input(
        (await listPlans()).find((p) => p.id === 'trial')!.publishedVersionId!,
      ),
      username: 'model_member',
    },
    'test',
  )
  const frozen = await memberCalls.run({}, async () => {
    const r = await reserveMembership(fresh.username, '/api/research/runs', {})
    const c = memberCalls.getStore()!
    assert.equal(c.chat?.model, 'chat-model')
    assert.equal(c.research?.model, 'research-model')
    assert.ok(resolveLlmClient())
    await settleMembership(r!, true, 202, {})
    return freezeRunConfig(fresh.username, 'structure-scan')
  })
  assert.equal((frozen.raw.capabilities as any).chat.model, 'research-model')
  assert.ok(!JSON.stringify(frozen).includes('test-key'))
  pass('聊天与研究模型独立解析，研究快照冻结且不包含密钥')
  const admin = Fastify()
  registerMembershipAdminRoutes(admin, {
    requireSuperadmin: (req: FastifyRequest) => {
      if (req.headers.authorization !== 'test-admin')
        throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
      return session('test-admin')
    },
  })
  assert.equal(
    (await admin.inject({ url: '/api/admin/membership/plans' })).statusCode,
    401,
  )
  assert.equal(
    (
      await admin.inject({
        method: 'PUT',
        url: '/api/admin/membership/refresh-settings',
        headers: {
          authorization: 'test-admin',
          'content-type': 'application/json',
          origin: 'https://foreign.invalid',
        },
        payload: {},
      })
    ).statusCode,
    403,
  )
  const listing = await admin.inject({
    url: '/api/admin/membership/users?page=1&pageSize=2',
    headers: { authorization: 'test-admin' },
  })
  assert.equal(listing.statusCode, 200)
  assert.equal(listing.json().users.length, 2)
  await db.execute(
    sql`UPDATE users SET chat_policy='{"disabled":true}'::jsonb WHERE username=${user.username}`,
  )
  assert.equal((await membershipStatus(user.username)).status, 'disabled')
  const restored = await admin.inject({
    method: 'PATCH',
    url: `/api/admin/users/${user.username}/membership`,
    headers: { authorization: 'test-admin' },
    payload: { disabled: false, note: 'restore test' },
  })
  assert.equal(restored.statusCode, 200)
  assert.equal((await membershipStatus(user.username)).status, 'active')
  await admin.close()
  pass('管理接口鉴权、跨站写拒绝及分页查询')
  const legacyName = 'legacy_migration'
  await db.execute(
    sql`INSERT INTO users(id,username,password_hash,role,chat_policy) VALUES(${randomUUID()},${legacyName},${await hashPassword('isolated-only')},'user','{"disabled":false,"dailyLimit":5}'::jsonb)`,
  )
  const legacyRecord = {
    totalLimit: 100,
    used: 90,
    dailyLimit: 5,
    dailyDate: dayOf(Date.now()),
    dailyUsed: 4,
  }
  await db.execute(
    sql`INSERT INTO app_settings(key,value) VALUES(${`ai_access:${legacyName}`},${JSON.stringify(legacyRecord)}::jsonb),('chat_usage',${JSON.stringify({ date: dayOf(Date.now()), counts: { [legacyName]: 7 } })}::jsonb)`,
  )
  const legacyStatus = await membershipStatus(legacyName)
  assert.equal(legacyStatus.managed, false)
  assert.equal(legacyStatus.legacyAccess?.remaining, 10)
  const latestTrial = (await listPlans()).find(
    (p) => p.id === 'trial',
  )!.publishedVersionId!
  await db.transaction((tx) =>
    assignMembership(
      tx,
      legacyName,
      input(latestTrial, '0', 'migrate'),
      'test',
    ),
  )
  assert.equal((await membershipStatus(legacyName)).usedToday, 7)
  const [retainedLegacy] = await db.execute(
    sql`SELECT value FROM app_settings WHERE key=${`ai_access:${legacyName}`}`,
  )
  assert.deepEqual(retainedLegacy.value, legacyRecord)
  const endedAt = Date.now() - 1000
  await db.execute(
    sql`UPDATE membership_grants SET starts_at=now()-interval '1 month',ends_at=${new Date(endedAt).toISOString()} WHERE username=${primary.username} AND revoked_at IS NULL`,
  )
  const resumedAt = Date.now()
  await db.transaction((tx) =>
    assignMembership(
      tx,
      primary.username,
      input(monthlyId, '15', 'renew'),
      'test',
      resumedAt,
    ),
  )
  assert.equal(
    (await membershipStatus(primary.username)).current?.startsAt,
    resumedAt,
  )
  await assert.rejects(() =>
    db.transaction((tx) =>
      assignMembership(
        tx,
        primary.username,
        input(lifetimeId, '299', 'renew'),
        'test',
      ),
    ),
  )
  pass('老账号显式迁移保留旧流水与当日用量；过期续费从当前时间开始')
  await savePlan(
    'feature_test',
    {
      ...monthly.draft,
      requestsPerMinute: 1,
      features: { chat: true, research: false, translate: false },
    },
    0,
    'test',
  )
  const limitedId = await publishPlan('feature_test', 1, 'test')
  const limited = await provisionMember(
    { ...input(limitedId, '15'), username: 'feature_member' },
    'test',
  )
  await assert.rejects(
    () => reserveMembership(limited.username, '/api/translate', {}),
    { statusCode: 403, code: 'membership_feature_unavailable' },
  )
  await assert.rejects(
    () => reserveMembership(limited.username, '/api/research/runs', {}),
    { statusCode: 403 },
  )
  await db.execute(
    sql`INSERT INTO membership_usage(username,day,used) VALUES(${limited.username},${dayOf(Date.now() - 86400000)},100)`,
  )
  const admitted = await reserveMembership(limited.username, '/api/ai/chat', {})
  await settleMembership(admitted!, false)
  await assert.rejects(
    () => reserveMembership(limited.username, '/api/ai/chat', {}),
    { statusCode: 429, code: 'ai_rate_limited' },
  )
  assert.equal((await membershipStatus(limited.username)).usedToday, 0)
  await db.execute(
    sql`UPDATE membership_usage SET window_at=0 WHERE username=${limited.username}`,
  )
  const afterWindow = await reserveMembership(
    limited.username,
    '/api/ai/chat',
    {},
  )
  await settleMembership(afterWindow!, true)
  assert.equal((await membershipStatus(limited.username)).usedToday, 1)
  pass('功能权限、分钟防刷窗口、失败退额与跨日计数隔离')
  // Explicitly verify new commercial tables cannot be changed by the actual user-api role.
  await root.unsafe(`GRANT CONNECT ON DATABASE "${name}" TO biance_user`)
  const ro = [
    'membership_plans',
    'membership_plan_versions',
    'membership_campaigns',
    'membership_accounts',
    'membership_grants',
    'membership_receipts',
    'membership_redemptions',
    'membership_refresh_settings',
  ]
  await db.execute(sql.raw(`GRANT SELECT ON ${ro.join(',')} TO biance_user`))
  await db.execute(
    sql.raw(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON membership_usage,membership_reservations TO biance_user',
    ),
  )
  await db.execute(sql.raw('GRANT SELECT ON users,app_settings TO biance_user'))
  const low = postgres(origin.href, { max: 1 })
  await low.unsafe('SET ROLE biance_user')
  try {
    await low.unsafe('SELECT * FROM membership_plans')
    await assert.rejects(
      () => low.unsafe('UPDATE membership_plans SET enabled=true'),
      (e: any) => e.code === '42501',
    )
  } finally {
    await low.end()
  }
  pass('用户 API 数据库账号只读会员商业配置')
  console.log(`会员集成检查通过：${count} 组`)
} catch (error) {
  console.error(error)
  exitCode = 1
} finally {
  await root
    .unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${name}' AND pid<>pg_backend_pid()`,
    )
    .catch(() => {})
  await root.unsafe(`DROP DATABASE IF EXISTS "${name}"`).catch(() => {})
  await root.end()
  await rm(dir, { recursive: true, force: true })
}
process.exit(exitCode)
