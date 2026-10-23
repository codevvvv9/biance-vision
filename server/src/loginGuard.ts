/**
 * 登录限速（W3-S2：计数入 PostgreSQL——跨域名合并 + 重启不丢）：
 * 每 IP 每分钟最多 5 次尝试（LOGIN_MAX_PER_WINDOW）；累计失败 10 次
 * （LOGIN_LOCK_FAILS）锁定 15 分钟；成功登录即清零。
 * 内存 Map 仅作写穿缓存（省热 IP 的重复读）；权威状态在 login_guards 表。
 * 调用方为登录路由（低频），每尝试一次 PG 往返可接受；并发下的计数以
 * 最后一次写为准（限速语义允许近似，不做行锁）。
 */
import { eq } from 'drizzle-orm'
import { getDb, isDbAvailable } from './db.js'
import { loginGuards } from './models.js'

export const LOGIN_WINDOW_MS = 60_000
export const LOGIN_LOCK_MS = 15 * 60_000
const GUARD_MAX_KEYS = 20_000

export interface LoginGuard {
  winStart: number
  winCount: number
  fails: number
  lockedUntil: number
}

const cache = new Map<string, LoginGuard>()

const fresh = (): LoginGuard => ({ winStart: Date.now(), winCount: 0, fails: 0, lockedUntil: 0 })

/** 读：内存缓存 → PG → 空记录（不写库） */
export async function loginGuardOf(ip: string): Promise<LoginGuard> {
  const hit = cache.get(ip)
  if (hit) return hit
  const conn = getDb()
  if (conn !== null && isDbAvailable()) {
    const rows = await conn.select().from(loginGuards).where(eq(loginGuards.ip, ip)).limit(1)
    if (rows.length > 0) {
      const g: LoginGuard = {
        winStart: rows[0].winStart,
        winCount: rows[0].winCount,
        fails: rows[0].fails,
        lockedUntil: rows[0].lockedUntil,
      }
      cache.set(ip, g)
      return g
    }
  }
  // 防内存膨胀：超限时先清一遍完全过期的条目
  if (cache.size >= GUARD_MAX_KEYS) {
    const now = Date.now()
    for (const [k, v] of cache) {
      if (v.lockedUntil < now && v.winStart + LOGIN_WINDOW_MS < now) cache.delete(k)
    }
  }
  const g = fresh()
  cache.set(ip, g)
  return g
}

/** 写：upsert PG + 更新缓存；PG 失败仅告警（登录本身已 fail-closed，计数尽力而为） */
export async function saveLoginGuard(ip: string, g: LoginGuard): Promise<void> {
  cache.set(ip, g)
  const conn = getDb()
  if (conn === null || !isDbAvailable()) return
  await conn
    .insert(loginGuards)
    .values({ ip, winStart: g.winStart, winCount: g.winCount, fails: g.fails, lockedUntil: g.lockedUntil })
    .onConflictDoUpdate({
      target: loginGuards.ip,
      set: { winStart: g.winStart, winCount: g.winCount, fails: g.fails, lockedUntil: g.lockedUntil },
    })
    .catch(() => {
      /* 计数写失败不阻断登录判定路径（读缓存仍有效） */
    })
}

/** 成功登录清零（删 PG 行 + 缓存） */
export async function clearLoginGuard(ip: string): Promise<void> {
  cache.delete(ip)
  const conn = getDb()
  if (conn === null || !isDbAvailable()) return
  await conn.delete(loginGuards).where(eq(loginGuards.ip, ip)).catch(() => {})
}
