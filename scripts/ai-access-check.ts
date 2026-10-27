/** Isolated PG integration: never uses production accounts, keys, counters or data files. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'

const requireServer = createRequire(new URL('../server/package.json', import.meta.url))
const postgres = requireServer('postgres') as (url: string, opts?: object) => { unsafe: (q: string) => Promise<unknown>; end: () => Promise<void> }
const dbName = `bv_website_access_${randomUUID().replaceAll('-', '')}`
const directory = await mkdtemp(path.join(tmpdir(), 'bv-website-access-'))
const pgOrigin = new URL(process.env.ACCESS_TEST_PG_URL || 'postgresql://postgres:postgres@127.0.0.1:5434/postgres')
const superDb = postgres(pgOrigin.href, { max: 1 })
let count = 0
function pass(label: string): void { count++; console.log(`✔ ${label}`) }
let exitCode = 0
try {
  await superDb.unsafe(`CREATE DATABASE "${dbName}" OWNER biance_app`)
  pgOrigin.pathname = `/${dbName}`
  process.env.DATABASE_URL = pgOrigin.href
  process.env.BV_DATA_DIR = directory
  process.env.WEBSITE_PUBLIC_CONFIG_DIR = path.join(directory, 'website-public')
  process.env.WEBSITE_ORIGIN = 'https://user.example.test'
  const { initDb, getDb, sql } = await import('../server/src/db.js')
  const { initUsers, verifyLogin, createSession, findSession, findLiveSession } = await import('../server/src/users.js')
  const { saveAiProfiles, resolveAiProfileName } = await import('../server/src/ai.js')
  const { provisionUser, registerProvisionUserRoutes } = await import('../server/src/admin/provisionUsers.js')
  const { provisionLoginPath } = await import('../server/src/membership/routes.js')
  const { saveWebsiteContacts, readWebsiteContacts, registerWebsiteSettingsRoutes } = await import('../server/src/admin/websiteSettings.js')
  const { reserveAiAccess, refundAiAccess, readAiAccess, registerAiAccessGuard } = await import('../server/src/aiAccess.js')
  assert.equal(await initDb(), true)
  await initUsers({ seed: false })
  saveAiProfiles({ profiles: { default: { baseUrl: 'https://model.example.test/v1', model: 'local-test-only', apiKey: 'not-a-real-test-key', allowedUsers: [] } } })
  const input = { username: 'trial_user', profileName: 'default', totalLimit: 3, dailyLimit: null, requestsPerMinute: 60 }
  const account = await provisionUser(input, 'test-admin')
  assert.equal(account.publicOrigin, 'https://user.example.test')
  // 交付登录链接默认落在 /brooks（研究端有会员门禁，trial 类账号跳 /research 会被挡）
  assert.equal(account.loginPath, '/login?ui=dev&returnTo=%2Fbrooks')
  // .env（PROVISION_LOGIN_PATH）可免发版覆盖落地页；外站/非法值一律回退默认
  process.env.PROVISION_LOGIN_PATH = '/login?ui=dev&returnTo=%2Fdashboard'
  assert.equal(provisionLoginPath(), '/login?ui=dev&returnTo=%2Fdashboard')
  process.env.PROVISION_LOGIN_PATH = 'https://evil.example.test/phish'
  assert.equal(provisionLoginPath(), '/login?ui=dev&returnTo=%2Fbrooks')
  process.env.PROVISION_LOGIN_PATH = '//protocol-relative.example.test'
  assert.equal(provisionLoginPath(), '/login?ui=dev&returnTo=%2Fbrooks')
  delete process.env.PROVISION_LOGIN_PATH
  assert.equal(provisionLoginPath(), '/login?ui=dev&returnTo=%2Fbrooks')
  assert.equal(account.role, 'user'); assert.equal(account.password.length, 24)
  assert.ok(verifyLogin(account.username, account.password)); assert.equal(resolveAiProfileName(account.username), 'default')
  assert.equal((await readAiAccess(account.username))?.used, 0)
  const db = getDb()!
  const rows = await db.execute(sql`SELECT password_hash FROM users WHERE username = ${account.username}`)
  assert.notEqual(rows[0].password_hash, account.password)
  assert.ok(!JSON.stringify(await readAiAccess(account.username)).includes(account.password))
  pass('普通用户、scrypt 密码、档案绑定、初始额度一次保存成功；交付 URL 使用已配置用户域名，默认落地 /brooks、env 覆盖生效且外站值回退')
  await assert.rejects(() => provisionUser({ ...input, username: 'missing_profile', profileName: 'missing' }, 'admin'))
  await assert.rejects(() => provisionUser({ ...input, username: 'role_injection', role: 'superadmin' }, 'admin'))
  await assert.rejects(() => provisionUser({ ...input, username: 'TRIAL_USER' }, 'admin'))
  assert.equal((await db.execute(sql`SELECT id FROM users`)).length, 1)
  pass('无效档案、角色注入、大小写重复拒绝且不留下账号')
  const attempted = await Promise.allSettled(Array.from({ length: 20 }, () => reserveAiAccess(account.username)))
  const reserved = attempted.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : [])
  assert.equal(reserved.length, 3); assert.equal((await readAiAccess(account.username))?.used, 3)
  await assert.rejects(() => reserveAiAccess(account.username), { code: 'ai_access_exhausted' })
  await refundAiAccess(reserved[0]); assert.equal((await readAiAccess(account.username))?.used, 2)
  await reserveAiAccess(account.username)
  pass('20 个并发请求只受理 3 次；超额在模型执行前拒绝，失败退额后可再受理一次')
  const daily = await provisionUser({ ...input, username: 'daily_user', totalLimit: 20, dailyLimit: 1 }, 'admin')
  await reserveAiAccess(daily.username)
  await assert.rejects(() => reserveAiAccess(daily.username), { code: 'ai_daily_limit_exceeded' })
  const rate = await provisionUser({ ...input, username: 'rate_user', totalLimit: 20, requestsPerMinute: 1 }, 'admin')
  await reserveAiAccess(rate.username)
  await assert.rejects(() => reserveAiAccess(rate.username), { code: 'ai_rate_limited' })
  await db.execute(sql`UPDATE users SET chat_policy = '{"disabled":true}'::jsonb WHERE username = ${daily.username}`)
  await assert.rejects(() => reserveAiAccess(daily.username), { code: 'chat_disabled' })
  pass('每日额度、每分钟频率、管理端停用立即生效')
  const superadmin = (req: FastifyRequest) => {
    if (req.headers.authorization !== 'test-admin') throw Object.assign(new Error('unauthorized'), { statusCode: 401 })
    return { token: 'isolated-test-session-token', expiresAt: Date.now() + 60000, username: 'test-admin', role: 'superadmin', purpose: 'admin' } as never
  }
  const app = Fastify({ logger: false })
  registerProvisionUserRoutes(app, { requireSuperadmin: superadmin })
  registerWebsiteSettingsRoutes(app, { requireSuperadmin: superadmin })
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/users/provision', payload: input })).statusCode, 401)
  const jsonHeaders = { authorization: 'test-admin', 'content-type': 'application/json' }
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/users/provision', headers: { ...jsonHeaders, origin: 'https://foreign.test' }, payload: input })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/users/provision', headers: { ...jsonHeaders, 'sec-fetch-site': 'cross-site' }, payload: input })).statusCode, 403)
  pass('开通接口拒绝无管理会话与跨站请求')
  const renewed = await app.inject({ method: 'PUT', url: `/api/admin/users/${account.username}/ai-access`, headers: jsonHeaders, payload: { totalLimit: 5, dailyLimit: null, requestsPerMinute: 60 } })
  assert.equal(renewed.statusCode, 200); assert.equal(renewed.json().access.used, 3)
  assert.equal(renewed.headers['cache-control'], 'no-store')
  await reserveAiAccess(account.username)
  pass('管理端续开只增加额度上限，保留已用计数')
  const reset = await app.inject({ method: 'POST', url: `/api/admin/users/${account.username}/reset-credentials`, headers: jsonHeaders, payload: {} })
  assert.equal(reset.statusCode, 200); assert.equal(await verifyLogin(account.username, account.password), null)
  assert.ok(await verifyLogin(account.username, reset.json().password))
  const signed = await createSession((await verifyLogin(account.username, reset.json().password))!, 'user')
  assert.ok(findSession(signed.token, 'user'))
  await db.execute(sql`DELETE FROM auth_sessions WHERE username = ${account.username}`)
  assert.ok(findSession(signed.token, 'user')) // Simulates a token cached by the other process.
  assert.equal(await findLiveSession(signed.token, 'user'), null)
  pass('密码重置后旧密码失效；另一个进程仍缓存的会话也按 PG 撤销状态拒绝')
  const v1 = await saveWebsiteContacts({ expectedRevision: 0, telegram: 'test_contact', email: 'contact@example.test' })
  assert.equal((await readWebsiteContacts()).telegram, 'test_contact')
  assert.equal(v1.revision, 1)
  await assert.rejects(() => saveWebsiteContacts({ expectedRevision: 0, telegram: 'test_contact', email: '' }), { statusCode: 409 })
  await assert.rejects(() => saveWebsiteContacts({ expectedRevision: 1, telegram: '', email: '' }))
  await assert.rejects(() => saveWebsiteContacts({ expectedRevision: 1, telegram: 'https://t.me/x', email: 'x@example.test', apiKey: 'never-public' }))
  const publicData = await readFile(path.join(directory, 'website-public', 'contact.json'), 'utf8')
  assert.ok(!publicData.includes('apiKey')); assert.ok(!publicData.includes(account.password))
  pass('公开联系方式快照更新、版本冲突及敏感字段拒绝；目录内仅有公开数据')
  await app.close()
  const httpAccount = await provisionUser({ ...input, username: 'http_user', totalLimit: 2 }, 'admin')
  const metered = Fastify({ logger: false })
  registerAiAccessGuard(metered, { requireSession: () => ({ username: httpAccount.username }) as never })
  let invoked = 0
  metered.post('/api/ai/chat', async (req, reply) => { if ((req.body as { fail?: boolean })?.fail) return reply.code(503).send({ message: 'unavailable' }); invoked++; return { ok: true } })
  assert.equal((await metered.inject({ method: 'POST', url: '/api/ai/chat', payload: { fail: true } })).statusCode, 503)
  assert.equal((await readAiAccess(httpAccount.username))?.used, 0)
  await metered.inject({ method: 'POST', url: '/api/ai/chat', payload: {} })
  await metered.inject({ method: 'POST', url: '/api/ai/chat', payload: {} })
  const denied = await metered.inject({ method: 'POST', url: '/api/ai/chat', payload: {} })
  assert.equal(denied.statusCode, 403); assert.equal(invoked, 2)
  pass('真实 Fastify 钩子退回 HTTP 失败额度；超额请求不进入模型处理器')
  await metered.close()
  console.log(`\n人工开通与 AI 额度集成通过（${count} 组，独立测试库）`)
} catch (error) { console.error(error); exitCode = 1 }
finally {
  await superDb.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`).catch(() => {})
  await superDb.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {})
  await superDb.end()
  await rm(directory, { recursive: true, force: true })
}
process.exit(exitCode)
