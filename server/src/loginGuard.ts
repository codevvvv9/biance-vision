/**
 * 登录限速（P1-3/L 前置原子修复）：每 IP 每分钟最多 5 次尝试（LOGIN_MAX_PER_WINDOW）；
 * 累计失败 10 次（LOGIN_LOCK_FAILS）锁定 15 分钟。
 *
 * 存储（W3-S2）：PostgreSQL login_guards（跨域名合并 + 重启不丢）。
 *
 * P1-3/L 修复（消除读-改-写竞态，方案 §14.4.1）：
 * - 全部状态变迁走单条原子条件 SQL（数据库内判断窗口重置/计数递增/锁定触发，
 *   以 aiAccess 为范本）——双进程并发、窗口边界、重启后计数均不丢不重；
 * - 尝试准入（consume）：锁定中冻结窗口计数（锁定不可被持续请求间接延长）；
 * - 失败记录（recordFailure）：行锁串行累加，达标即触发锁定并重置计数；
 * - 成功清理（clearFailures）：按本次尝试序号（win_count）条件重置 fails——
 *   并发后发生的失败不被清除；不清零窗口尝试计数（IP 总尝试桶保留）；
 * - 写失败不再吞错：原子函数抛错由调用方 503（安全状态不可用不执行密码计算）。
 *
 * 时间源统一用 PG 时钟（extract(epoch from now())），避免 JS/DB 时钟漂移分裂窗口。
 */
import { sql } from 'drizzle-orm'
import { getDb, isDbAvailable } from './db.js'

export const LOGIN_WINDOW_MS = 60_000
export const LOGIN_LOCK_MS = 15 * 60_000

/** 尝试准入结果：allowed=false 时按 429 拒绝（窗口或锁定），attemptSeq 供成功清理 */
export interface LoginAdmission {
  allowed: boolean
  locked: boolean
  lockedUntilMs: number
  windowCount: number
  /** 本次尝试序号（= 原子递增后的 win_count）：成功清理按它条件重置 fails */
  attemptSeq: number
}

function unavailable(): Error {
  return Object.assign(new Error('安全状态暂不可用，请稍后重试'), { statusCode: 503, code: 'security_state_unavailable' })
}

function unavailableCause(e: Error): Error {
  const err = unavailable()
  err.cause = e
  return err
}

/**
 * 原子尝试准入：锁定检查 + 窗口重置 + 计数递增一次完成。
 * 锁定中冻结计数（win_count 不变），不推远 locked_until。
 */
export async function consumeLoginAttempt(ip: string, maxPerWindow: number): Promise<LoginAdmission> {
  const conn = getDb()
  if (conn === null || !isDbAvailable()) throw unavailable()
  const rows = await conn.execute(sql`
    INSERT INTO login_guards (ip, win_start, win_count, fails, locked_until)
    VALUES (${ip}, (extract(epoch FROM now()) * 1000)::bigint, 1, 0, 0)
    ON CONFLICT (ip) DO UPDATE SET
      win_start = CASE
        WHEN login_guards.locked_until > (extract(epoch FROM now()) * 1000)::bigint THEN login_guards.win_start
        WHEN (extract(epoch FROM now()) * 1000)::bigint - login_guards.win_start >= ${LOGIN_WINDOW_MS} THEN (extract(epoch FROM now()) * 1000)::bigint
        ELSE login_guards.win_start END,
      win_count = CASE
        WHEN login_guards.locked_until > (extract(epoch FROM now()) * 1000)::bigint THEN login_guards.win_count
        WHEN (extract(epoch FROM now()) * 1000)::bigint - login_guards.win_start >= ${LOGIN_WINDOW_MS} THEN 1
        ELSE login_guards.win_count + 1 END
    RETURNING win_count, locked_until`)
    .catch((e: Error) => { throw unavailableCause(e) })
  const r = (rows as unknown as Array<{ win_count: number; locked_until: string | number }>)[0]
  if (r === undefined) throw unavailable()
  const lockedUntil = Number(r.locked_until)
  const windowCount = Number(r.win_count)
  const locked = lockedUntil > Date.now() + 500 // PG/JS 时钟差容忍
  return {
    allowed: !locked && windowCount <= maxPerWindow,
    locked,
    lockedUntilMs: lockedUntil,
    windowCount,
    attemptSeq: windowCount,
  }
}

/**
 * 原子失败记录：行锁串行累加 fails；达到阈值触发锁定并重置计数。
 * 锁定中冻结累计（并发下已过准入的请求不推远解锁时间，方案 §4.3）。
 */
export async function recordLoginFailure(ip: string, lockFails: number): Promise<void> {
  const conn = getDb()
  if (conn === null || !isDbAvailable()) throw unavailable()
  await conn.execute(sql`
    INSERT INTO login_guards (ip, win_start, win_count, fails, locked_until)
    VALUES (${ip}, (extract(epoch FROM now()) * 1000)::bigint, 0, 1, 0)
    ON CONFLICT (ip) DO UPDATE SET
      fails = CASE
        WHEN login_guards.locked_until > (extract(epoch FROM now()) * 1000)::bigint THEN login_guards.fails
        WHEN login_guards.fails + 1 >= ${lockFails} THEN 0
        ELSE login_guards.fails + 1 END,
      locked_until = CASE
        WHEN login_guards.locked_until > (extract(epoch FROM now()) * 1000)::bigint THEN login_guards.locked_until
        WHEN login_guards.fails + 1 >= ${lockFails} THEN (extract(epoch FROM now()) * 1000)::bigint + ${LOGIN_LOCK_MS}
        ELSE login_guards.locked_until END`)
    .catch((e: Error) => { throw unavailableCause(e) })
}

/**
 * 成功登录的条件清理：仅当行未被并发修改（win_count 仍等于本次尝试序号）时重置
 * fails——并发后发生的失败不被清除；不清零窗口尝试计数（IP 总尝试桶保留）。
 */
export async function clearLoginFailuresOnSuccess(ip: string, attemptSeq: number): Promise<void> {
  const conn = getDb()
  if (conn === null || !isDbAvailable()) throw unavailable()
  await conn.execute(sql`
    UPDATE login_guards SET fails = 0
    WHERE ip = ${ip} AND win_count = ${attemptSeq} AND locked_until <= (extract(epoch FROM now()) * 1000)::bigint`)
    .catch((e: Error) => { throw unavailableCause(e) })
}

// ---------------------------------------------------------------------------
// 兼容出口：旧读接口仅供诊断/测试观察状态（登录路径不再使用读-改-写）
// ---------------------------------------------------------------------------
export interface LoginGuard {
  winStart: number
  winCount: number
  fails: number
  lockedUntil: number
}

/** 读当前状态（诊断/测试断言用；不参与准入判定） */
export async function loginGuardOf(ip: string): Promise<LoginGuard> {
  const conn = getDb()
  if (conn !== null && isDbAvailable()) {
    const rows = await conn.execute(sql`SELECT win_start, win_count, fails, locked_until FROM login_guards WHERE ip = ${ip}`)
    const r = (rows as unknown as Array<{ win_start: string | number; win_count: number; fails: number; locked_until: string | number }>)[0]
    if (r !== undefined) {
      return { winStart: Number(r.win_start), winCount: Number(r.win_count), fails: Number(r.fails), lockedUntil: Number(r.locked_until) }
    }
  }
  return { winStart: Date.now(), winCount: 0, fails: 0, lockedUntil: 0 }
}
