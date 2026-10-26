import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { DATA_DIR } from '../store.js'
import type { SessionRecord } from '../users.js'
import { recordAudit } from '../audit.js'
import { guardAdminMutation } from './mutationGuard.js'

export interface WebsiteContacts { version: 1; revision: number; telegram: string; email: string; updatedAt: number }
/** 官网首屏小游戏（Risk Run）公开配置快照；词表与速度由管理端发布。 */
export interface WebsiteHeroGame { version: 1; revision: number; risks: Array<{ zh: string; en: string; glyph: string }>; speedScale: number; updatedAt: number }
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode })
export const defaultContacts = (): WebsiteContacts => ({ version: 1, revision: 0, telegram: '', email: 'codevvvv9@gmail.com', updatedAt: 0 })
// 默认词表与官网 website/lib/hero-game.ts 内置兜底保持同源语义（无配置文件时两端各自可用）
export const defaultHeroGame = (): Pick<WebsiteHeroGame, 'risks' | 'speedScale'> => ({
  risks: [
    { zh: '杠杆', en: 'LEVERAGE', glyph: '↯' },
    { zh: '追高', en: 'CHASING', glyph: '▲' },
    { zh: 'FOMO', en: 'FOMO', glyph: '!' },
    { zh: '重仓', en: 'OVERSIZE', glyph: '▤' },
    { zh: '噪声', en: 'NOISE', glyph: '≈' },
    { zh: '假突破', en: 'FAKEOUT', glyph: '✕' },
  ],
  speedScale: 1,
})
export function websiteContactFile(): string { return path.join(process.env.WEBSITE_PUBLIC_CONFIG_DIR || path.join(DATA_DIR, 'website-public'), 'contact.json') }
export function websiteHeroGameFile(): string { return path.join(process.env.WEBSITE_PUBLIC_CONFIG_DIR || path.join(DATA_DIR, 'website-public'), 'hero-game.json') }

export function validateContactFields(input: unknown): { telegram: string; email: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('联系方式格式不正确')
  const raw = input as Record<string, unknown>
  if (typeof raw.telegram !== 'string' || typeof raw.email !== 'string') throw bad('telegram 和 email 必须为字符串')
  const telegram = raw.telegram.trim().replace(/^@/, '')
  const email = raw.email.trim()
  if (telegram && !/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(telegram)) throw bad('Telegram 仅填写 5–32 位用户名，不填写 URL 或 Bot Token')
  if (email.length > 254 || (email && !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(email))) throw bad('邮箱格式不正确')
  if (!telegram && !email) throw bad('至少保留一个真实联系渠道')
  return { telegram, email }
}

export async function readWebsiteContacts(file = websiteContactFile()): Promise<WebsiteContacts> {
  try {
    if ((await fs.stat(file)).size > 4096) throw new Error('oversized')
    const input = JSON.parse(await fs.readFile(file, 'utf8')) as WebsiteContacts
    const fields = validateContactFields(input)
    if (input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 1 || !Number.isSafeInteger(input.updatedAt)) throw new Error('invalid')
    return { version: 1, revision: input.revision, updatedAt: input.updatedAt, ...fields }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultContacts()
    throw bad('公开联系方式快照不可读，请检查存储后重试', 503)
  }
}

let queue: Promise<unknown> = Promise.resolve()
export function saveWebsiteContacts(input: unknown, file = websiteContactFile()): Promise<WebsiteContacts> {
  const operation = queue.catch(() => {}).then(async () => {
    const raw = input as Record<string, unknown>
    if (!raw || Object.keys(raw).some(k => !['telegram', 'email', 'expectedRevision'].includes(k))) throw bad('仅允许更新公开联系方式')
    const fields = validateContactFields(raw)
    if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 0) throw bad('缺少有效配置版本')
    const previous = await readWebsiteContacts(file)
    if (raw.expectedRevision !== previous.revision) throw bad('配置已被更新，请刷新后重试', 409)
    const next: WebsiteContacts = { version: 1, revision: previous.revision + 1, updatedAt: Date.now(), ...fields }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 })
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
      await fs.rename(temporary, file)
    } finally { await fs.unlink(temporary).catch(() => {}) }
    return next
  })
  queue = operation
  return operation as Promise<WebsiteContacts>
}

export function validateHeroGameFields(input: unknown): { risks: WebsiteHeroGame['risks']; speedScale: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw bad('小游戏配置格式不正确')
  const raw = input as Record<string, unknown>
  if (!Array.isArray(raw.risks)) throw bad('风险词表必须为列表')
  if (raw.risks.length < 3 || raw.risks.length > 10) throw bad('风险词条需保留 3–10 条')
  const risks = raw.risks.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw bad(`第 ${index + 1} 条风险词条格式不正确`)
    const risk = item as Record<string, unknown>
    const zh = typeof risk.zh === 'string' ? risk.zh.trim() : ''
    const en = typeof risk.en === 'string' ? risk.en.trim() : ''
    const glyph = typeof risk.glyph === 'string' ? risk.glyph.trim() : ''
    if (!zh || zh.length > 8) throw bad(`第 ${index + 1} 条中文名需为 1–8 个字符`)
    if (!en || en.length > 16) throw bad(`第 ${index + 1} 条英文名需为 1–16 个字符`)
    if (!glyph || glyph.length > 3) throw bad(`第 ${index + 1} 条图标符号需为 1–3 个字符`)
    return { zh, en: en.toUpperCase(), glyph }
  })
  const speedScale = Number(raw.speedScale)
  if (!Number.isFinite(speedScale) || speedScale < 0.5 || speedScale > 2) throw bad('速度倍率需在 0.5–2 之间')
  return { risks, speedScale: Math.round(speedScale * 100) / 100 }
}

export async function readWebsiteHeroGame(file = websiteHeroGameFile()): Promise<WebsiteHeroGame> {
  try {
    if ((await fs.stat(file)).size > 8192) throw new Error('oversized')
    const input = JSON.parse(await fs.readFile(file, 'utf8')) as WebsiteHeroGame
    const fields = validateHeroGameFields(input)
    if (input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 1 || !Number.isSafeInteger(input.updatedAt)) throw new Error('invalid')
    return { version: 1, revision: input.revision, updatedAt: input.updatedAt, ...fields }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, revision: 0, updatedAt: 0, ...defaultHeroGame() }
    throw bad('官网小游戏配置快照不可读，请检查存储后重试', 503)
  }
}

let heroQueue: Promise<unknown> = Promise.resolve()
export function saveWebsiteHeroGame(input: unknown, file = websiteHeroGameFile()): Promise<WebsiteHeroGame> {
  const operation = heroQueue.catch(() => {}).then(async () => {
    const raw = input as Record<string, unknown>
    if (!raw || Object.keys(raw).some(k => !['risks', 'speedScale', 'expectedRevision'].includes(k))) throw bad('仅允许更新官网小游戏配置')
    const fields = validateHeroGameFields(raw)
    if (!Number.isSafeInteger(raw.expectedRevision) || Number(raw.expectedRevision) < 0) throw bad('缺少有效配置版本')
    const previous = await readWebsiteHeroGame(file)
    if (raw.expectedRevision !== previous.revision) throw bad('配置已被更新，请刷新后重试', 409)
    const next: WebsiteHeroGame = { version: 1, revision: previous.revision + 1, updatedAt: Date.now(), ...fields }
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 })
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o644, flag: 'wx' })
      await fs.rename(temporary, file)
    } finally { await fs.unlink(temporary).catch(() => {}) }
    return next
  })
  heroQueue = operation
  return operation as Promise<WebsiteHeroGame>
}

export function registerWebsiteSettingsRoutes(app: FastifyInstance, deps: { requireSuperadmin: (req: FastifyRequest) => SessionRecord }): void {
  app.get('/api/admin/website-config', async (req, reply) => {
    deps.requireSuperadmin(req)
    reply.header('Cache-Control', 'no-store')
    return { contacts: await readWebsiteContacts(), heroGame: await readWebsiteHeroGame() }
  })
  app.put('/api/admin/website-config', { bodyLimit: 4096 }, async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    guardAdminMutation(req, session.username, 'website-config')
    const contacts = await saveWebsiteContacts(req.body)
    recordAudit(session, { action: 'settings_update', target: 'website_contacts', detail: `发布官网公开联系方式 v${contacts.revision}` })
    reply.header('Cache-Control', 'no-store')
    return { ok: true, contacts }
  })
  app.put('/api/admin/website-config/hero-game', { bodyLimit: 8192 }, async (req, reply) => {
    const session = deps.requireSuperadmin(req)
    guardAdminMutation(req, session.username, 'website-hero-game')
    const heroGame = await saveWebsiteHeroGame(req.body)
    recordAudit(session, { action: 'settings_update', target: 'website_hero_game', detail: `发布官网首屏小游戏配置 v${heroGame.revision}（词表 ${heroGame.risks.length} 条，速度 ×${heroGame.speedScale}）` })
    reply.header('Cache-Control', 'no-store')
    return { ok: true, heroGame }
  })
}
