/**
 * 研究访问门禁契约测试（pnpm research:check，docs/specs/membership.md）：
 * 独立临时库（同 membership-check 模式）；不打开真实 AI 端点、不改既有用户。
 * 覆盖矩阵：
 * - featureAccess 判定：无授权 / legacy / 有效会员 / internal / research:false 版本 /
 *   到期（不回退 legacy）/ 仅未来授权 / 停用（账号与 chat_policy 两种）/ 纳管从未授权 / chat 参数化
 * - createRun 用户/系统边界：user 默认受检且无 run 落库；system 豁免可建
 * - HTTP 伪造 source:'system' 不能绕过（body 字段不进 createRun 内部参数）
 * - 错误码透传：chat 入口对授权 403 保留领域码（不被改写 chat_failed）
 * - DB 异常：权限查询边界返回受控 503，不含底层错误信息
 * - membershipStatus.access 与判定单点一致
 */
import type { SessionRecord } from '../server/src/users.js'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
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
  name = `bv_research_access_${randomUUID().replaceAll('-', '')}`,
  dir = await mkdtemp(path.join(tmpdir(), 'bv-research-access-'))
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
  const { saveAiProfiles } = await import('../server/src/ai.js')
  const { savePlan, publishPlan, listPlans, membershipStatus } = await import(
    '../server/src/membership/service.js'
  )
  const { featureAccess, assertResearchAccess } = await import(
    '../server/src/membership/access.js'
  )
  const { createRun } = await import('../server/src/research/runs/store.js')
  const { registerResearchRunRoutes } = await import(
    '../server/src/research/runs/routes.js'
  )
  const { initUsers } = await import('../server/src/users.js')
  await initUsers({ seed: false })
  saveAiProfiles({
    profiles: {
      default: {
        baseUrl: 'https://unused.invalid/v1',
        model: 'chat-model',
        apiKey: 'test-key-never-sent',
        allowedUsers: [],
      },
    },
  })

  // 0038 迁移种子：internal 自动发布+上架（public:false、价格 0、features 三开）
  const plans = await listPlans()
  const internal = plans.find((p) => p.id === 'internal')!
  assert.ok(internal, 'internal 套餐应存在（0038 种子）')
  assert.ok(internal.enabled && internal.publishedVersionId, 'internal 应已发布并上架')
  assert.equal(internal.draft.price, '0')
  assert.equal(internal.draft.public, false)
  assert.equal(internal.draft.features.research, true)
  pass('internal 固定套餐就绪（已发布上架、0 价、不公开、含 research）')

  const monthly = plans.find((p) => p.id === 'monthly')!
  // savePlan 每次保存 revision+1；publishPlan 校验「保存后的 revision」并以该号入版本表
  await savePlan('monthly', { ...monthly.draft, requestsPerMinute: 60 }, monthly.revision, 'test')
  const monthlyId = await publishPlan('monthly', monthly.revision + 1, 'test')
  // research:false / chat:true 版本：验证按 feature 参数化（且额度口径与权限分离）
  await savePlan(
    'monthly',
    { ...monthly.draft, requestsPerMinute: 60, features: { chat: true, research: false, translate: true } },
    monthly.revision + 1,
    'test',
  )
  const noResearchId = await publishPlan('monthly', monthly.revision + 2, 'test')

  const now = Date.now()
  const mkUser = (username: string) =>
    db.execute(
      sql`INSERT INTO users(id,username,password_hash,role,chat_policy) VALUES(${randomUUID()},${username},'not-a-login-hash','user','{}'::jsonb)`,
    )
  const grantTo = (
    username: string,
    versionId: string,
    opts: { startsAt?: number; endsAt?: number | null } = {},
  ) =>
    db.execute(
      sql`INSERT INTO membership_grants(id,username,version_id,starts_at,ends_at,note,created_by)
          VALUES(${randomUUID()},${username},${versionId},${new Date(opts.startsAt ?? now - 3600_000).toISOString()},${opts.endsAt === undefined ? null : opts.endsAt === null ? null : new Date(opts.endsAt).toISOString()},'test','test')`,
    )
  const manage = (username: string) =>
    db.execute(sql`INSERT INTO membership_accounts(username,updated_by) VALUES(${username},'test') ON CONFLICT DO NOTHING`)

  // ---- featureAccess 判定矩阵 ----
  await mkUser('ra_nobody')
  assert.deepEqual(await featureAccess('ra_nobody', 'research'), {
    allowed: false,
    source: null,
    reason: 'no_access',
  })
  await assert.rejects(() => assertResearchAccess('ra_nobody'), {
    statusCode: 403,
    code: 'research_access_required',
  })

  await mkUser('ra_legacy')
  await db.execute(
    sql`INSERT INTO app_settings(key,value) VALUES(${'ai_access:ra_legacy'},${'{"totalLimit":10,"used":0}'}::jsonb)`,
  )
  assert.deepEqual(await featureAccess('ra_legacy', 'research'), {
    allowed: true,
    source: 'legacy',
    reason: null,
  })

  await mkUser('ra_member')
  await manage('ra_member')
  await grantTo('ra_member', monthlyId)
  assert.deepEqual(await featureAccess('ra_member', 'research'), {
    allowed: true,
    source: 'membership',
    reason: null,
  })

  await mkUser('ra_internal')
  await manage('ra_internal')
  await grantTo('ra_internal', internal.publishedVersionId!)
  assert.equal((await featureAccess('ra_internal', 'research')).allowed, true)

  await mkUser('ra_noresearch')
  await manage('ra_noresearch')
  await grantTo('ra_noresearch', noResearchId)
  const noResearch = await featureAccess('ra_noresearch', 'research')
  assert.equal(noResearch.allowed, false)
  assert.equal(noResearch.reason, 'plan_feature')
  await assert.rejects(() => assertResearchAccess('ra_noresearch'), {
    statusCode: 403,
    code: 'membership_feature_unavailable',
  })
  // 同一账号 chat 仍可用：feature 参数化生效（权限判定与额度/聊天规则分离）
  assert.equal((await featureAccess('ra_noresearch', 'chat')).allowed, true)

  // 到期纳管账号同时残留 legacy 配置：不回退，拒绝归因 expired
  await mkUser('ra_expired')
  await manage('ra_expired')
  await grantTo('ra_expired', monthlyId, { startsAt: now - 7200_000, endsAt: now - 3600_000 })
  await db.execute(
    sql`INSERT INTO app_settings(key,value) VALUES(${'ai_access:ra_expired'},${'{"totalLimit":10,"used":0}'}::jsonb)`,
  )
  assert.equal((await featureAccess('ra_expired', 'research')).reason, 'expired')

  await mkUser('ra_future')
  await manage('ra_future')
  await grantTo('ra_future', monthlyId, { startsAt: now + 86400_000, endsAt: now + 2 * 86400_000 })
  assert.equal((await featureAccess('ra_future', 'research')).reason, 'expired')

  await mkUser('ra_disabled')
  await manage('ra_disabled')
  await grantTo('ra_disabled', monthlyId)
  await db.execute(sql`UPDATE membership_accounts SET disabled=true WHERE username='ra_disabled'`)
  assert.equal((await featureAccess('ra_disabled', 'research')).reason, 'disabled')

  await mkUser('ra_chatpol')
  await manage('ra_chatpol')
  await grantTo('ra_chatpol', monthlyId)
  await db.execute(sql`UPDATE users SET chat_policy='{"disabled":true}'::jsonb WHERE username='ra_chatpol'`)
  assert.equal((await featureAccess('ra_chatpol', 'research')).reason, 'disabled')

  await mkUser('ra_nogrant')
  await manage('ra_nogrant')
  assert.equal((await featureAccess('ra_nogrant', 'research')).reason, 'no_grant')
  pass('featureAccess 判定矩阵：无授权/legacy/会员/internal/research:false/到期不回退/未来/停用/无授权纳管')

  // membershipStatus.access 与判定单点一致
  assert.equal((await membershipStatus('ra_member')).access.research.allowed, true)
  assert.equal((await membershipStatus('ra_nobody')).access.research.allowed, false)
  assert.equal((await membershipStatus('ra_legacy')).access.research.source, 'legacy')
  pass('membershipStatus.access 与 featureAccess 同源一致')

  // ---- createRun 用户/系统边界 ----
  const runCount = async (): Promise<number> => {
    const [r] = await db.execute(sql`SELECT count(*)::int AS n FROM research_runs`)
    return Number(r.n)
  }
  const minimal = {
    product: 'teaching',
    symbol: 'BTCUSDT',
    marketType: 'spot',
    horizon: '1h',
  } as const
  const before = await runCount()
  await assert.rejects(
    () => createRun({ userId: 'ra_nobody', create: minimal }),
    { statusCode: 403, code: 'research_access_required' },
  )
  assert.equal(await runCount(), before, '拒绝路径不得落任何 run 行')
  await assert.rejects(
    () => createRun({ userId: 'ra_expired', create: minimal }),
    { statusCode: 403, code: 'membership_expired' },
  )
  // 系统调用（evalRunner 形态）：显式豁免，无会员账号可创建
  const sysRun = await createRun({ userId: 'ra_nobody', source: 'system', create: minimal })
  assert.equal(sysRun.userId, 'ra_nobody')
  assert.equal(await runCount(), before + 1)
  pass('createRun：user 默认受检且零落库；system 显式豁免可建')

  // ---- HTTP 层：伪造 source 不可绕过 + 错误码不被改写 ----
  const app = Fastify(),
    session = (username: string) =>
      ({
        username,
        role: 'user',
        purpose: 'user',
        token: 'test',
        expiresAt: Date.now() + 60000,
      }) as SessionRecord
  let current = 'ra_nobody'
  registerResearchRunRoutes(app, { requireSession: () => session(current) })
  const forged = await app.inject({
    method: 'POST',
    url: '/api/research/runs',
    payload: { ...minimal, source: 'system' },
  })
  assert.equal(forged.statusCode, 403)
  assert.equal(forged.json().code, 'research_access_required')
  assert.equal(await runCount(), before + 1, '伪造 source 不得创建 run')
  const chatDenied = await app.inject({
    method: 'POST',
    url: '/api/research/chat',
    payload: { message: 'test question' },
  })
  assert.equal(chatDenied.statusCode, 403)
  assert.equal(
    chatDenied.json().code,
    'research_access_required',
    'chat 入口对授权 403 保留领域码，不得改写为 chat_failed',
  )
  // 会员（research:false 版本）经 chat 入口：preHandler 抛 membership_feature_unavailable
  current = 'ra_noresearch'
  const featureDenied = await app.inject({
    method: 'POST',
    url: '/api/research/chat',
    payload: { message: 'test question' },
  })
  assert.equal(featureDenied.statusCode, 403)
  assert.equal(featureDenied.json().code, 'membership_feature_unavailable')
  pass('HTTP：伪造 source 仍 403 零落库；授权 403 领域码原样透传')

  // ---- DB 异常 → 受控 503 ----
  const brokenEx = {
    execute: () => {
      throw new Error('connection terminated: ECONNRESET at pg pool (SQL: SELECT secret...)')
    },
  }
  await assert.rejects(
    () => featureAccess('ra_member', 'research', now, brokenEx as never),
    (err: Error & { statusCode?: number; code?: string; message: string }) => {
      assert.equal(err.statusCode, 503)
      assert.equal(err.code, 'membership_unavailable')
      assert.ok(!err.message.includes('SQL') && !err.message.includes('ECONNRESET'), '503 不得回显底层错误细节')
      return true
    },
  )
  pass('DB 异常受控 503（membership_unavailable，不泄露底层信息）')

  console.log(`研究访问门禁检查通过：${count} 组`)
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
