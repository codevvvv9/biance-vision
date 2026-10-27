import { activeMembership as dbMembership, membershipStatus } from '../membership/service.js'
import { provisionMember, provisionLoginPath } from '../membership/routes.js'
import crypto from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { getDb } from '../db.js'
import { appSettings, users } from '../models.js'
import { hashPassword, initUsers, updatePassword } from '../users.js'
import type { SessionRecord } from '../users.js'
import { aiProfileByName, getAiProfilesMasked, saveAiProfiles } from '../ai.js'
import { accessKey, readAiAccess, type AiAccess } from '../aiAccess.js'
import { recordAudit } from '../audit.js'
import { guardAdminMutation } from './mutationGuard.js'

const inputSchema = z.object({
  username: z.string().regex(/^[a-zA-Z0-9_-]{3,32}$/).optional(),
  profileName: z.string().regex(/^[a-zA-Z0-9_-]{1,24}$/),
  totalLimit: z.number().int().min(1).max(100000),
  dailyLimit: z.number().int().min(1).max(100000).nullable(),
  requestsPerMinute: z.number().int().min(1).max(60),
}).strict()
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode })

function bindProfile(username: string, profileName: string | null, operator: string): void {
  const profiles = getAiProfilesMasked()
  const target = profileName ? profiles[profileName] : null
  if (profileName && (!target || !target.model || !target.apiKeyMasked)) throw bad('请先保存一个可用的 AI 档案')
  if (target && (target.allowedUsers?.length ?? 0) >= 20 && !target.allowedUsers?.includes(username)) throw bad('该档案已绑定 20 位用户，请使用其他档案')
  saveAiProfiles({ profiles: Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, {
    ...profile, apiKey: profile.apiKeyMasked,
    allowedUsers: [...(profile.allowedUsers || []).filter(u => u !== username), ...(name === profileName ? [username] : [])],
  }])) }, operator)
}

function configuredPublicOrigin(): string | null {
  if (!process.env.WEBSITE_ORIGIN) return null
  try { const url = new URL(process.env.WEBSITE_ORIGIN); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null } catch { return null }
}

export async function provisionUser(input: unknown, operator: string) {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) throw bad('开通参数不正确：请选择已保存的 AI 档案及有效的累计、每日和请求频率上限')
  const db = getDb()
  if (!db) throw bad('账号存储不可用，未生成可交付账号', 503)
  const { profileName, totalLimit, dailyLimit, requestsPerMinute } = parsed.data
  const username = parsed.data.username || `bv_${crypto.randomBytes(6).toString('hex')}`
  const password = crypto.randomBytes(18).toString('base64url')
  const profile = aiProfileByName(profileName)
  if (!getAiProfilesMasked()[profileName] || !profile || !profile.model || !profile.baseUrl || !profile.apiKey) throw bad('请先配置并保存 AI 档案')
  const access: AiAccess = { version: 1, generation: crypto.randomUUID(), totalLimit, used: 0, dailyLimit, dailyDate: '', dailyUsed: 0, requestsPerMinute, windowAt: 0, windowUsed: 0, profileName }
  let bound = false
  try {
    await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provision:${username.toLowerCase()}`}, 0))`)
      const duplicate = await tx.execute(sql`SELECT id FROM users WHERE lower(username) = ${username.toLowerCase()} LIMIT 1`)
      if (duplicate.length) throw bad('用户名已存在，请使用其他用户名', 409)
      await tx.insert(users).values({ id: crypto.randomUUID(), username, passwordHash: await hashPassword(password), role: 'user', chatPolicy: { disabled: false, dailyLimit } })
      await tx.insert(appSettings).values({ key: accessKey(username), value: access as unknown as Record<string, unknown> })
      bindProfile(username, profileName, operator)
      bound = true
    })
  } catch (error) {
    // PG rollback keeps the account inaccessible. Remove only the new binding,
    // preserving any other administrator's saved profile configuration.
    if (bound) try { bindProfile(username, null, operator) } catch { /* An orphan binding grants no account access. */ }
    throw error
  }
  await initUsers({ seed: false })
  return { username, password, role: 'user' as const, access: { totalLimit, dailyLimit, requestsPerMinute, profileName }, loginPath: provisionLoginPath(), publicOrigin: configuredPublicOrigin() }
}

export function registerProvisionUserRoutes(app: FastifyInstance, deps: { requireSuperadmin: (req: FastifyRequest) => SessionRecord }): void {
  app.post('/api/admin/users/provision', { bodyLimit: 4096 }, async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    guardAdminMutation(req, session.username, 'provision-user', 5)
    const result = await provisionMember(req.body, session.username)
    recordAudit(session, { action: 'settings_update', target: result.username, detail: `开通普通用户并绑定会员 ${result.grantId}` })
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache')
    return reply.code(201).send(result)
  })
  app.get('/api/admin/users/:username/ai-access', async (req, reply) => {
    deps.requireSuperadmin(req)
    reply.header('Cache-Control', 'no-store')
    const username = (req.params as { username: string }).username
    const membership = await membershipStatus(username)
    if (membership.managed) return { access: null, membership }
    return { access: await readAiAccess(username) }
  })
  app.put('/api/admin/users/:username/ai-access', { bodyLimit: 4096 }, async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    guardAdminMutation(req, session.username, 'update-ai-access')
    const username = (req.params as { username: string }).username
    if ((await dbMembership(username))) throw bad('会员用户请通过会员套餐管理额度', 409)
    const patch = z.object({ totalLimit: z.number().int().min(0).max(100000), dailyLimit: z.number().int().min(1).max(100000).nullable(), requestsPerMinute: z.number().int().min(1).max(60) }).strict().safeParse(req.body)
    if (!patch.success) throw bad('额度参数不正确')
    const db = getDb()
    if (!db || !await readAiAccess(username)) throw bad('用户无受管额度记录', 404)
    // Merge in SQL: never overwrite usage read before concurrent requests complete.
    await db.execute(sql`UPDATE app_settings SET value = value || ${JSON.stringify(patch.data)}::jsonb WHERE key = ${accessKey(username)}`)
    recordAudit(session, { action: 'settings_update', target: username, detail: `调整 AI 累计额度为 ${patch.data.totalLimit}（保留已用量）` })
    reply.header('Cache-Control', 'no-store')
    return { access: await readAiAccess(username) }
  })
  app.post('/api/admin/users/:username/reset-credentials', { bodyLimit: 1024 }, async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    guardAdminMutation(req, session.username, 'reset-user-password', 5)
    const username = (req.params as { username: string }).username
    const db = getDb()
    const target = db ? (await db.select({ role: users.role }).from(users).where(eq(users.username, username)).limit(1))[0] : null
    if (!target || target.role !== 'user') throw bad('仅可重置普通用户的交付密码', 404)
    // 请求体可选：自定义密码（4~64 位，与 createUser 同规则）；缺省则生成随机交付密码
    const parsed = z.object({ password: z.string().min(4).max(64) }).partial().strict().safeParse(req.body ?? {})
    if (!parsed.success) throw bad('密码长度需在 4~64 位之间')
    const custom = typeof parsed.data.password === 'string' && parsed.data.password.length > 0
    const password = custom ? parsed.data.password as string : crypto.randomBytes(18).toString('base64url')
    await initUsers({ seed: false })
    await updatePassword(username, password)
    recordAudit(session, { action: 'settings_update', target: username, detail: custom ? '设置自定义交付密码并使现有会话失效' : '重置交付密码并使现有会话失效' })
    reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache')
    return { username, password, custom }
  })
}
