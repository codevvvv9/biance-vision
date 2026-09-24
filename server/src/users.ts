import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, loadJson, saveJson } from './store.js'
import { initDb, isDbAvailable, loadUsersFromDb, upsertUsersDb } from './db.js'

export type UserRole = 'user' | 'superadmin'

export interface UserRecord {
  id: string
  username: string
  passwordHash: string
  role: UserRole
  createdAt: number
  updatedAt: number
}

export interface PublicUser {
  username: string
  role: UserRole
}

export interface SessionRecord {
  token: string
  username: string
  role: UserRole
  expiresAt: number
}

export const SESSION_COOKIE = 'bv_session'
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/
const USERS_FILE = path.join(DATA_DIR, 'users.json')

interface BadRequestError extends Error {
  statusCode: number
}
function badRequest(msg: string): BadRequestError {
  return Object.assign(new Error(msg), { statusCode: 400 })
}

// ---------------------------------------------------------------------------
// 密码：scrypt + 随机盐，存储格式 "salt$hash"（hex）
// ---------------------------------------------------------------------------
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}$${hash}`
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split('$')
  if (!salt || !hash) return false
  const actual = crypto.scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

// ---------------------------------------------------------------------------
// 用户存储：JSON 镜像为热数据（按 mtime 失效，脚本改动无需重启服务），
// PostgreSQL 为持久副本（可用时同步写入）
// ---------------------------------------------------------------------------
let usersCache: UserRecord[] | null = null
let usersMtime = 0

/** 内置账号清单：server/data/seed-users.json（不入库），首次启动（users.json 为空）时写入 */
const SEED_FILE = path.join(DATA_DIR, 'seed-users.json')

function loadSeedUsers(): { username: string; password: string; role: UserRole }[] {
  try {
    const raw = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (s): s is { username: string; password: string; role: UserRole } =>
        !!s && typeof s === 'object' &&
        typeof (s as Record<string, unknown>).username === 'string' &&
        typeof (s as Record<string, unknown>).password === 'string' &&
        ((s as Record<string, unknown>).role === 'user' || (s as Record<string, unknown>).role === 'superadmin'),
    )
  } catch {
    return []
  }
}

/** 读取用户列表；users.json 被外部修改（如 add-user 脚本）时自动重载 */
export function getUsers(): UserRecord[] {
  try {
    const mtime = fs.statSync(USERS_FILE).mtimeMs
    if (usersCache && mtime === usersMtime) return usersCache
    usersCache = loadJson<UserRecord[]>('users.json', [])
    usersMtime = mtime
  } catch {
    usersCache ??= loadJson<UserRecord[]>('users.json', [])
  }
  return usersCache
}

function persistUsers(list: UserRecord[]): void {
  usersCache = list
  saveJson('users.json', list)
  try {
    usersMtime = fs.statSync(USERS_FILE).mtimeMs
  } catch {
    /* noop */
  }
  void upsertUsersDb(list).catch((e: Error) => console.warn('[db] 用户写入失败:', e.message))
}

/**
 * 启动时初始化用户存储：
 * - 首次运行（无用户）：写入内置账号
 * - 数据库可用：与 users 表按 username 合并（并集，同名以 JSON 为准）后双写
 */
export async function initUsers(): Promise<void> {
  if (!isDbAvailable()) await initDb() // 独立脚本调用时尚未初始化数据库

  if (getUsers().length === 0) {
    const seeds = loadSeedUsers()
    if (seeds.length > 0) {
      const now = Date.now()
      const seeded = seeds.map((s) => ({
        id: crypto.randomUUID(),
        username: s.username,
        passwordHash: hashPassword(s.password),
        role: s.role,
        createdAt: now,
        updatedAt: now,
      }))
      persistUsers(seeded)
      console.log(`[users] 已按 seed-users.json 写入内置账号 ${seeded.length} 个`)
    } else {
      console.log('[users] 未配置内置账号（server/data/seed-users.json），可用 pnpm user:add 创建')
    }
  }

  if (isDbAvailable()) {
    const dbUsers = await loadUsersFromDb().catch((e: Error) => {
      console.warn('[db] 用户读取失败:', e.message)
      return []
    })
    if (dbUsers.length > 0) {
      const map = new Map(dbUsers.map((u) => [u.username, u]))
      for (const u of getUsers()) map.set(u.username, u) // JSON 为准
      const merged = [...map.values()].sort((a, b) => a.createdAt - b.createdAt)
      persistUsers(merged)
    } else {
      persistUsers(getUsers()) // 首次接入数据库：把 JSON 存量导入
    }
  }
}

/** 新增用户（校验 + 查重），写入 JSON 镜像与数据库 */
export function createUser(username: string, password: string, role: UserRole = 'user'): UserRecord {
  const name = String(username ?? '').trim()
  if (!USERNAME_RE.test(name)) {
    throw badRequest('用户名需为 3~32 位字母 / 数字 / 下划线 / 连字符')
  }
  const pw = String(password ?? '')
  if (pw.length < 4 || pw.length > 64) throw badRequest('密码长度需在 4~64 位之间')
  const list = getUsers()
  if (list.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    throw badRequest(`用户 ${name} 已存在`)
  }
  const now = Date.now()
  const record: UserRecord = {
    id: crypto.randomUUID(),
    username: name,
    passwordHash: hashPassword(pw),
    role,
    createdAt: now,
    updatedAt: now,
  }
  persistUsers([...list, record])
  return record
}

/** 修改密码（校验用户存在 + 密码长度），成功后该用户的全部会话失效 */
export function updatePassword(username: string, password: string): UserRecord {
  const name = String(username ?? '').trim()
  const pw = String(password ?? '')
  if (pw.length < 4 || pw.length > 64) throw badRequest('密码长度需在 4~64 位之间')
  const list = getUsers()
  const u = list.find((x) => x.username.toLowerCase() === name.toLowerCase())
  if (!u) throw badRequest(`用户 ${name} 不存在`)
  u.passwordHash = hashPassword(pw)
  u.updatedAt = Date.now()
  persistUsers([...list])
  destroySessionsFor(u.username)
  return u
}

export function toPublic(u: UserRecord): PublicUser {
  return { username: u.username, role: u.role }
}

/** 校验用户名密码；统一返回 null 以免区分「用户不存在 / 密码错误」 */
export function verifyLogin(username: string, password: string): UserRecord | null {
  const u = getUsers().find((x) => x.username === String(username ?? '').trim())
  if (!u || !verifyPassword(String(password ?? ''), u.passwordHash)) return null
  return u
}

// ---------------------------------------------------------------------------
// 会话：内存 Map + sessions.json 镜像（服务重启不掉线），惰性清理过期；
// 同样按 mtime 热加载——改密码脚本踢掉会话后，运行中的服务立即生效
// ---------------------------------------------------------------------------
let sessions: Map<string, SessionRecord> | null = null
let sessionsMtime = 0
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')

function loadSessions(): Map<string, SessionRecord> {
  try {
    const mtime = fs.statSync(SESSIONS_FILE).mtimeMs
    if (sessions && mtime === sessionsMtime) return sessions
    const now = Date.now()
    sessions = new Map(
      loadJson<SessionRecord[]>('sessions.json', [])
        .filter((s) => s.expiresAt > now)
        .map((s) => [s.token, s]),
    )
    sessionsMtime = mtime
  } catch {
    sessions ??= new Map()
  }
  return sessions
}

function persistSessions(): void {
  saveJson('sessions.json', [...loadSessions().values()])
  try {
    sessionsMtime = fs.statSync(SESSIONS_FILE).mtimeMs
  } catch {
    /* noop */
  }
}

export function createSession(u: UserRecord): SessionRecord {
  const record: SessionRecord = {
    token: crypto.randomBytes(24).toString('hex'),
    username: u.username,
    role: u.role,
    expiresAt: Date.now() + SESSION_TTL_MS,
  }
  loadSessions().set(record.token, record)
  persistSessions()
  return record
}

/** 有效会话返回记录；过期或用户已被移除则清理并返回 null */
export function findSession(token: string | undefined): SessionRecord | null {
  if (!token) return null
  const s = loadSessions().get(token)
  if (!s) return null
  if (s.expiresAt <= Date.now() || !getUsers().some((u) => u.username === s.username)) {
    loadSessions().delete(token)
    persistSessions()
    return null
  }
  return s
}

export function destroySession(token: string | undefined): void {
  if (!token) return
  if (loadSessions().delete(token)) persistSessions()
}

/** 销毁某用户的全部会话（改密码后调用），返回销毁数量 */
export function destroySessionsFor(username: string): number {
  let n = 0
  for (const [token, s] of loadSessions()) {
    if (s.username === username) {
      loadSessions().delete(token)
      n++
    }
  }
  if (n > 0) persistSessions()
  return n
}

/** 从 Cookie 头解析会话 token */
export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim()
  }
  return undefined
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}
