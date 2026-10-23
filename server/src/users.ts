import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, saveJson } from './store.js'
import { getDb, initDb, isDbAvailable, loadUsersFromDb, upsertUsersDb } from './db.js'
import { authSessions } from './models.js'
import { log } from './logger.js'

export type UserRole = 'user' | 'superadmin'

/** 会话用途（W3-S2）：签发入口决定——admin 域名签发 'admin'、用户入口签发 'user'；findSession 按访问入口校验 */
export type SessionPurpose = 'user' | 'admin'

/** 用户级聊天管控（管理端设置）：disabled=禁用 AI 助手；dailyLimit=每日交互上限（null/缺省=不限） */
export interface ChatPolicy {
  disabled: boolean
  dailyLimit: number | null
}

export interface UserRecord {
  id: string
  username: string
  passwordHash: string
  role: UserRole
  /** 聊天管控；缺省（旧数据无字段）= 不禁不限 */
  chatPolicy?: ChatPolicy
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
  /** 用途标记：user/admin（W3-S2）；跨用途使用一律无效 */
  purpose: SessionPurpose
  expiresAt: number
}

export const SESSION_COOKIE = 'bv_session'
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/

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
// 用户存储（W3-S2 定稿）：PostgreSQL 唯一真源 + 进程内缓存（同步读路径沿用）。
// - 读：getUsers() 走缓存；缓存仅在 initUsers/写入成功/周期同步时从 PG 刷新；
//   ❗users.json 不再参与判权（外部改动无效），仅在写入成功后 best-effort 落一份备份；
// - 写：先 await PG 成功再换缓存（失败即操作失败——fail-closed，不降级 JSON）；
// - 周期同步（60s）：为 S3 双进程预备——admin-api 写入后 user-api/worker 最迟 60s 对齐
//   （比 JSON mtime 热加载的旧机制显式且可审计）。
// ---------------------------------------------------------------------------
let usersCache: UserRecord[] = []
let usersSyncTimer: NodeJS.Timeout | null = null

/** 内置账号清单：server/data/seed-users.json（不入库），仅首启（PG 用户表为空）时写入 */
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

/** 读取用户列表（进程内缓存；真源刷新点见文件头注释） */
export function getUsers(): UserRecord[] {
  return usersCache
}

/** 从 PG 刷新用户缓存；返回是否成功（失败保持旧缓存，只告警） */
async function refreshUsersFromDb(): Promise<boolean> {
  const list = await loadUsersFromDb().catch((e: Error) => {
    log.warn('db', '用户缓存刷新失败:', e.message)
    return null
  })
  if (list === null) return false
  usersCache = list
  return true
}

/** 用户写入（fail-closed）：PG 成功才换缓存；users.json 仅备份（不再回读判权） */
async function persistUsers(list: UserRecord[]): Promise<void> {
  await upsertUsersDb(list)
  usersCache = list
  try {
    saveJson('users.json', list)
  } catch (e) {
    log.warn('users', 'users.json 备份写入失败（不影响判权，真源在 PG）:', (e as Error).message)
  }
}

/**
 * 启动时初始化用户存储（W3-S2）：
 * - PG 可用：缓存从 PG 加载；表空则按 seed-users.json 播种入 PG；
 * - PG 不可用：fail-closed——缓存保持空，一切登录与管理认证拒绝（不降级 JSON 判权）；
 * - ❗旧「JSON 优先合并回写数据库」初始化已移除（JSON 从此只是备份，不是来源）。
 */
export async function initUsers(): Promise<void> {
  if (!isDbAvailable()) await initDb()

  if (!isDbAvailable()) {
    log.warn('users', 'PostgreSQL 不可用：认证 fail-closed（拒绝登录与管理认证，不降级 users.json 判权）')
    return
  }

  if ((await loadUsersFromDb()).length === 0) {
    const seeds = loadSeedUsers()
    const current = getUsers()
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
      await persistUsers([...current, ...seeded])
      log.ok('users', `已按 seed-users.json 写入内置账号 ${seeded.length} 个（PG）`)
    } else {
      log.warn('users', '未配置内置账号（server/data/seed-users.json），可用 pnpm user:add 创建')
    }
  } else {
    await refreshUsersFromDb()
    log.ok('users', `用户存储已从 PostgreSQL 加载（${usersCache.length} 个；users.json 仅备份）`)
  }

  // 周期同步（S3 双进程预备）：进程内缓存最迟 60s 对齐 PG 真源
  if (usersSyncTimer === null) {
    usersSyncTimer = setInterval(() => {
      if (!isDbAvailable()) return
      void refreshUsersFromDb()
    }, 60_000)
    usersSyncTimer.unref()
  }
}

/** 新增用户（校验 + 查重），PG 成功才生效（fail-closed） */
export async function createUser(username: string, password: string, role: UserRole = 'user'): Promise<UserRecord> {
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
  await persistUsers([...list, record])
  return record
}

/** 修改密码（校验用户存在 + 密码长度），成功后该用户的全部会话失效 */
export async function updatePassword(username: string, password: string): Promise<UserRecord> {
  const name = String(username ?? '').trim()
  const pw = String(password ?? '')
  if (pw.length < 4 || pw.length > 64) throw badRequest('密码长度需在 4~64 位之间')
  const list = getUsers()
  const u = list.find((x) => x.username.toLowerCase() === name.toLowerCase())
  if (!u) throw badRequest(`用户 ${name} 不存在`)
  const updated: UserRecord = { ...u, passwordHash: hashPassword(pw), updatedAt: Date.now() }
  await persistUsers(list.map((x) => (x === u ? updated : x)))
  await destroySessionsFor(u.username)
  return updated
}

export function toPublic(u: UserRecord): PublicUser {
  return { username: u.username, role: u.role }
}

/**
 * 更新用户聊天管控（管理端）：合并 patch 后写 PG（fail-closed），
 * 保存即生效（本进程立即 + 其他进程最迟 60s 周期同步）；用户不存在返回 null。
 */
export async function updateChatPolicy(
  username: string,
  patch: { disabled?: boolean; dailyLimit?: number | null },
): Promise<UserRecord | null> {
  const name = String(username ?? '').trim()
  const list = getUsers()
  const u = list.find((x) => x.username.toLowerCase() === name.toLowerCase())
  if (!u) return null
  const prev = u.chatPolicy ?? { disabled: false, dailyLimit: null }
  const updated: UserRecord = {
    ...u,
    chatPolicy: {
      disabled: patch.disabled ?? prev.disabled,
      // dailyLimit 显式给 null = 解除上限；undefined = 不改动
      dailyLimit: patch.dailyLimit === undefined ? prev.dailyLimit : patch.dailyLimit,
    },
    updatedAt: Date.now(),
  }
  await persistUsers(list.map((x) => (x === u ? updated : x)))
  return updated
}

/**
 * 校验用户名密码；统一返回 null 以免区分「用户不存在 / 密码错误」。
 * 认证 fail-closed（W3-S2）：PG 不可用时一律拒绝（不降级 JSON 判权）。
 */
export function verifyLogin(username: string, password: string): UserRecord | null {
  if (!isDbAvailable()) return null
  const u = getUsers().find((x) => x.username === String(username ?? '').trim())
  if (!u || !verifyPassword(String(password ?? ''), u.passwordHash)) return null
  return u
}

/**
 * 按用户名查角色（不验证密码），用户名匹配语义与 verifyLogin 一致。
 * 登录验证前预检用：错误入口的账号在 scrypt 之前被拒（防爆破确认通道）。
 */
export function roleOfUsername(username: string): UserRole | null {
  const u = getUsers().find((x) => x.username === String(username ?? '').trim())
  return u ? u.role : null
}

// ---------------------------------------------------------------------------
// 会话（W3-S2）：PG（auth_sessions 表）唯一真源 + 进程内缓存（token → 记录）。
// - token 只存 sha256（库泄露不可直接重放）；缓存键仍是原 token（进程内存）；
// - ❗存量 sessions.json 不迁移不回读——升级即全部失效、要求重新登录（不猜测用途）；
// - 用途标记：createSession 按签发入口写 purpose；findSession 按 expectedPurpose 校验，
//   不匹配（跨用途使用）与过期/用户已删同待遇：无效。
// ---------------------------------------------------------------------------
let sessions: Map<string, SessionRecord> = new Map()

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/** 启动加载：从 PG 拉有效会话进缓存（过期行顺手清理）；不读 sessions.json */
export async function initSessions(): Promise<void> {
  if (!isDbAvailable()) return
  const conn = getDb()
  if (!conn) return
  const now = new Date()
  const rows = await conn.select().from(authSessions)
  sessions = new Map()
  const expired: string[] = []
  for (const r of rows) {
    if (r.expiresAt <= now) {
      expired.push(r.tokenHash)
      continue
    }
    if (!getUsers().some((u) => u.username === r.username)) {
      expired.push(r.tokenHash)
      continue
    }
    sessions.set(r.tokenHash, {
      token: r.tokenHash, // 缓存键=tokenHash（见 findSession：按哈希查）
      username: r.username,
      role: r.role as UserRole,
      purpose: r.purpose as SessionPurpose,
      expiresAt: r.expiresAt.getTime(),
    })
  }
  if (expired.length > 0) {
    const { inArray } = await import('drizzle-orm')
    await conn.delete(authSessions).where(inArray(authSessions.tokenHash, expired)).catch(() => {})
  }
  log.ok('users', `会话已从 PostgreSQL 加载（${sessions.size} 个有效；存量 sessions.json 已退役）`)
}

export async function createSession(u: UserRecord, purpose: SessionPurpose): Promise<SessionRecord> {
  const token = crypto.randomBytes(24).toString('hex')
  const record: SessionRecord = {
    token,
    username: u.username,
    role: u.role,
    purpose,
    expiresAt: Date.now() + SESSION_TTL_MS,
  }
  const conn = getDb()
  if (!conn) throw Object.assign(new Error('认证存储不可用，无法登录'), { statusCode: 503 })
  await conn.insert(authSessions).values({
    tokenHash: sha256Hex(token),
    username: record.username,
    role: record.role,
    purpose: record.purpose,
    expiresAt: new Date(record.expiresAt),
  })
  // 缓存键存 tokenHash：findSession 以哈希查（进程内不留原 token 明文的第二份索引）
  sessions.set(sha256Hex(token), { ...record, token: sha256Hex(token) })
  return record
}

/**
 * 有效会话返回记录；无效情形（过期 / 用户已删 / **用途不匹配**）清理并返回 null。
 * expectedPurpose：调用方按访问入口传（admin 域名='admin'，其余='user'）；
 * 省略 = 不校验用途（仅日志类旁路读取）。
 */
export function findSession(token: string | undefined, expectedPurpose?: SessionPurpose): SessionRecord | null {
  if (!token) return null
  const key = sha256Hex(token)
  const s = sessions.get(key)
  if (!s) return null
  if (s.expiresAt <= Date.now() || !getUsers().some((u) => u.username === s.username)) {
    sessions.delete(key)
    void deleteSessionRow(key)
    return null
  }
  if (expectedPurpose !== undefined && s.purpose !== expectedPurpose) return null
  return { ...s, token }
}

async function deleteSessionRow(tokenHash: string): Promise<void> {
  const conn = getDb()
  if (!conn) return
  const { eq } = await import('drizzle-orm')
  await conn.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash)).catch(() => {})
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return
  const key = sha256Hex(token)
  if (sessions.delete(key)) await deleteSessionRow(key)
}

/** 销毁某用户的全部会话（改密码/管控掐断后调用），返回销毁数量 */
export async function destroySessionsFor(username: string): Promise<number> {
  let n = 0
  for (const [key, s] of sessions) {
    if (s.username === username) {
      sessions.delete(key)
      await deleteSessionRow(key)
      n++
    }
  }
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
