import crypto from 'node:crypto'
import { loadJson, saveJson } from './store.js'
import { isDbAvailable, mergeMissingAuditRecords, upsertAuditRecord } from './db.js'
import { log } from './logger.js'
import type { SessionRecord } from './users.js'
import { SESSION_TTL_MS } from './users.js'

/** 审计动作类型（label 映射在 web 端 AdminPage 维护） */
export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'rule_create'
  | 'rule_update'
  | 'rule_delete'
  | 'settings_update'
  | 'settings_test'

/** 会话内单次操作 */
export interface AuditEntry {
  at: number
  action: AuditAction
  target: string
  detail: string
  ok: boolean
}

/**
 * 审计记录：一次登录 = 一条 session 记录，登录后的全部操作按时间序
 * 追加在 actions 里；登录失败没有会话，记为独立的 login_failed 事件。
 */
export interface AuditSessionRecord {
  id: string
  kind: 'session' | 'login_failed'
  /** 会话 token 的 sha256 前缀（失败事件为空） */
  sessionKey: string
  username: string
  ip: string
  userAgent: string
  /** 会话 = 登录时间；失败事件 = 发生时间 */
  at: number
  /** 会话结束时间（登出）；null = 未结束 */
  endedAt: number | null
  actions: AuditEntry[]
  lastActiveAt: number
}

export interface AuditRecordView extends AuditSessionRecord {
  /** 会话状态（失败事件为 null）：active 进行中 / ended 已登出 / expired 已过期 */
  status: 'active' | 'ended' | 'expired' | null
}

/** 记录条数上限（会话 + 失败事件混合，按最后活动时间裁剪） */
const KEEP = 200
/** 单会话操作数上限（防异常刷量撑爆记录） */
const ACTIONS_KEEP = 500

// 内存态始终以 audit.json 为准；数据库可用时 fire-and-forget 双写
let records: AuditSessionRecord[] = loadJson<AuditSessionRecord[]>('audit.json', []).filter(
  (r) => r?.kind === 'session' || r?.kind === 'login_failed', // 丢弃旧版平铺事件格式
)
// 活跃/历史会话索引：sessionKey → 记录（重启后由 audit.json 重建）
const byKey = new Map<string, AuditSessionRecord>()
for (const r of records) if (r.kind === 'session' && r.sessionKey) byKey.set(r.sessionKey, r)

function persist(changed: AuditSessionRecord): void {
  records.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  if (records.length > KEEP) {
    for (const dropped of records.slice(KEEP)) {
      if (dropped.sessionKey) byKey.delete(dropped.sessionKey)
    }
    records = records.slice(0, KEEP)
  }
  saveJson('audit.json', records)
  void upsertAuditRecord(changed).catch((e: Error) =>
    log.warn('audit', '数据库写入失败:', e.message),
  )
}

function sessionKeyOf(session: SessionRecord): string {
  return crypto.createHash('sha256').update(session.token).digest('hex').slice(0, 32)
}

/** 登录成功：为本次会话建档，登录本身作为时间线的第一条操作 */
export function startSessionAudit(
  session: SessionRecord,
  ctx: { ip?: string; userAgent?: string },
): void {
  const rec: AuditSessionRecord = {
    id: crypto.randomUUID(),
    kind: 'session',
    sessionKey: sessionKeyOf(session),
    username: session.username,
    ip: String(ctx.ip ?? '').slice(0, 64),
    userAgent: String(ctx.userAgent ?? '').slice(0, 160),
    at: Date.now(),
    endedAt: null,
    actions: [
      {
        at: Date.now(),
        action: 'login',
        target: '',
        detail: `登录成功（${session.role === 'superadmin' ? '超级管理员' : '普通用户'}）`,
        ok: true,
      },
    ],
    lastActiveAt: Date.now(),
  }
  byKey.set(rec.sessionKey, rec)
  records.unshift(rec)
  persist(rec)
}

/** 登录失败：无会话，记为独立事件（含尝试的用户名，便于发现撞库） */
export function recordFailedLogin(input: { username: string; ip?: string; userAgent?: string }): void {
  const rec: AuditSessionRecord = {
    id: crypto.randomUUID(),
    kind: 'login_failed',
    sessionKey: '',
    username: String(input.username ?? '').slice(0, 64) || '(未提供)',
    ip: String(input.ip ?? '').slice(0, 64),
    userAgent: String(input.userAgent ?? '').slice(0, 160),
    at: Date.now(),
    endedAt: null,
    actions: [
      {
        at: Date.now(),
        action: 'login_failed',
        target: '',
        detail: '登录失败：用户名或密码错误',
        ok: false,
      },
    ],
    lastActiveAt: Date.now(),
  }
  records.unshift(rec)
  persist(rec)
}

/**
 * 会话内操作：追加到所属会话的时间线。找不到记录（如审计数据已被裁剪、
 * 或会话早于审计功能上线）时就地重建一条，保证操作不丢。
 */
export function recordAudit(
  session: SessionRecord,
  entry: Omit<AuditEntry, 'at' | 'ok'> & { ok?: boolean },
): void {
  const key = sessionKeyOf(session)
  let rec = byKey.get(key)
  if (!rec) {
    rec = {
      id: crypto.randomUUID(),
      kind: 'session',
      sessionKey: key,
      username: session.username,
      ip: '',
      userAgent: '',
      at: Date.now(),
      endedAt: null,
      actions: [
        {
          at: Date.now(),
          action: 'login',
          target: '',
          detail: '会话恢复记录（登录时间早于本条记录）',
          ok: true,
        },
      ],
      lastActiveAt: Date.now(),
    }
    byKey.set(key, rec)
    records.unshift(rec)
  }
  if (rec.actions.length < ACTIONS_KEEP) {
    rec.actions.push({ ...entry, at: Date.now(), ok: entry.ok !== false })
  }
  rec.lastActiveAt = Date.now()
  persist(rec)
}

/** 登出：时间线补上登出操作并封存会话 */
export function endSessionAudit(session: SessionRecord): void {
  const rec = byKey.get(sessionKeyOf(session))
  if (!rec || rec.endedAt !== null) return
  rec.endedAt = Date.now()
  if (rec.actions.length < ACTIONS_KEEP) {
    rec.actions.push({ at: rec.endedAt, action: 'logout', target: '', detail: '退出登录', ok: true })
  }
  rec.lastActiveAt = rec.endedAt
  persist(rec)
}

/** 查询：username 精确过滤；同时返回出现过的用户名列表（供筛选下拉） */
export function queryAudit(filter: { username?: string; limit?: number } = {}): {
  records: AuditRecordView[]
  usernames: string[]
} {
  const usernames = [...new Set(records.map((r) => r.username))]
  const name = filter.username?.trim()
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), KEEP)
  const now = Date.now()
  const filtered = name ? records.filter((r) => r.username === name) : records
  const view: AuditRecordView[] = filtered.slice(0, limit).map((r) => ({
    ...r,
    status:
      r.kind !== 'session'
        ? null
        : r.endedAt !== null
          ? 'ended'
          : now - r.at > SESSION_TTL_MS
            ? 'expired'
            : 'active',
  }))
  return { records: view, usernames }
}

/** 启动时把 JSON 镜像里数据库缺失的记录补进数据库（宕机期间写入的部分） */
export async function initAudit(): Promise<void> {
  if (!isDbAvailable() || records.length === 0) return
  await mergeMissingAuditRecords(records).catch((e: Error) =>
    log.warn('audit', '数据库回补失败:', e.message),
  )
}
