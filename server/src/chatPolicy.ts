/**
 * 用户级聊天管控（ChatPolicy）：管理端可对单个用户禁用 AI 助手或设每日交互上限。
 *
 * 与 ai.ts 的档案级配额（checkAiQuota / recordAiUsage，每用户每日 LLM 对话数）
 * 相互独立、任一超限即拒（取严）：档案级限额防共享刷量，本模块是管理端对人的开关。
 *
 * 计数口径：按「成功完成的交互」计数，失败不计（区别于 recordAiUsage 含失败
 * 尝试的防刷口径）。按北京时间自然日计，跨天整体重置。
 *
 * 存储（W3 后修订）：PostgreSQL app_settings（key='chat_usage'，{date, counts}）
 * 为唯一真源——user-api 写计数、admin-api 用户列表读用量，双进程每次读写都直查
 * PG（读即最新，消除旧 JSON 内存快照跨进程陈旧问题）；chat-usage.json 已退役，
 * 首次启动一次性收编当日存量后改名 .migrated。
 *
 * 并发口径：assert 与 record 之间存在 await 窗口（业务流程在其间执行），
 * 并发请求可同时通过检查，日限可少量超发——本模块是管理端管控口径的非硬控制
 * （与 ai.ts 档案级配额同口径），不做并发互斥。单写者（user-api 计数）+管理端
 * 只读，无跨进程写竞态。
 */
import fs from 'node:fs'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { getDb, isDbAvailable } from './db.js'
import { appSettings } from './models.js'
import { DATA_DIR, loadJson } from './store.js'
import { log, kv } from './logger.js'
import { getUsers } from './users.js'
import type { ChatPolicy } from './users.js'

const USAGE_KEY = 'chat_usage'
const LEGACY_FILE = path.join(DATA_DIR, 'chat-usage.json')

interface ChatUsage {
  date: string
  counts: Record<string, number>
  [k: string]: unknown // jsonb 列的 index signature 兼容
}

const EMPTY: ChatUsage = { date: '', counts: {} }

function todayStr(): string {
  // 按北京时间计日（与 ai.ts / 日志时区一致）
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 读当日用量快照（直查 PG；不可用/无记录返回空——读不到按 0 放行，与非硬控制口径一致） */
async function loadUsage(): Promise<ChatUsage> {
  const conn = getDb()
  if (conn === null || !isDbAvailable()) return EMPTY
  try {
    const rows = await conn.select().from(appSettings).where(eq(appSettings.key, USAGE_KEY)).limit(1)
    const v = rows[0]?.value as Partial<ChatUsage> | undefined
    if (v === undefined || typeof v.date !== 'string' || typeof v.counts !== 'object' || v.counts === null) return EMPTY
    return { date: v.date, counts: v.counts as Record<string, number> }
  } catch {
    return EMPTY
  }
}

/** 写回（跨天自然重置在写路径；upsert 单行） */
async function saveUsage(u: ChatUsage): Promise<void> {
  const conn = getDb()
  if (conn === null || !isDbAvailable()) {
    log.warn('chatPolicy', '用量计数写失败（PG 不可用，本次计数丢失——非硬控制口径可接受）')
    return
  }
  await conn
    .insert(appSettings)
    .values({ key: USAGE_KEY, value: u })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: u } })
}

/**
 * 启动收编（幂等）：旧 chat-usage.json 的当日数据一次性导入 PG 后改名 .migrated。
 * 由 user-api 入口调用（单写者进程负责迁移；admin-api 只读无需迁移）。
 */
export async function initChatUsage(): Promise<void> {
  const current = await loadUsage()
  if (current.date === todayStr() && Object.keys(current.counts).length > 0) return // PG 已有当日数据
  try {
    const legacy = loadJson<ChatUsage>('chat-usage.json', EMPTY)
    if (legacy.date === todayStr() && Object.keys(legacy.counts).length > 0) {
      await saveUsage(legacy)
      log.ok('chatPolicy', '当日用量已从 chat-usage.json 收编进 PostgreSQL', kv({ 用户数: Object.keys(legacy.counts).length }))
    }
    // 无论是否收编，JSON 即刻退役（改名保留痕迹，不再读写）
    fs.renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated`)
  } catch {
    /* 无旧文件或已迁移——正常 */
  }
}

/** 规范化用户聊天管控（缺省 = 不禁不限；非法 dailyLimit 归一为 null） */
export function normalizeChatPolicy(u: { chatPolicy?: ChatPolicy } | undefined): ChatPolicy {
  const raw = u?.chatPolicy
  const dailyLimit = raw?.dailyLimit
  return {
    disabled: raw?.disabled === true,
    dailyLimit: typeof dailyLimit === 'number' && dailyLimit > 0 ? dailyLimit : null,
  }
}

/** 读取某用户当前生效的聊天管控（用户不存在时按默认策略放行——会话层已校验用户存在） */
function policyOf(username: string): ChatPolicy {
  const u = getUsers().find((x) => x.username.toLowerCase() === username.toLowerCase())
  return normalizeChatPolicy(u)
}

/** 当日已计交互次数（直查 PG，双进程一致；跨天自然归零） */
export async function getChatUsageToday(username: string): Promise<number> {
  const u = await loadUsage()
  return u.date === todayStr() ? (u.counts[username] ?? 0) : 0
}

/**
 * 纯决策（抽出以便 scripts/chat-policy-check.ts 直接自测，不依赖用户/存储）：
 * 禁用 → 403 chat_disabled；达当日上限 → 429 chat_limit_exceeded。
 * message 面向最终用户，前端原样展示。
 */
export function checkChatAllowed(policy: ChatPolicy, usedToday: number): void {
  if (policy.disabled) {
    throw Object.assign(new Error('聊天已被管理员禁用'), { statusCode: 403, code: 'chat_disabled' })
  }
  const limit = policy.dailyLimit
  if (limit !== null && limit > 0 && usedToday >= limit) {
    throw Object.assign(new Error(`今日 AI 助手交互次数已达上限（${limit} 次/天）`), {
      statusCode: 429,
      code: 'chat_limit_exceeded',
    })
  }
}

/**
 * 交互前检查（挂点在鉴权之后、业务之前）：读取该用户生效策略与当日计数，
 * 委托 checkChatAllowed 判定（计数直查 PG——管理端刚改限额/他处计数立即可见）。
 */
export async function assertChatAllowed(username: string): Promise<void> {
  checkChatAllowed(policyOf(username), await getChatUsageToday(username))
}

/**
 * 成功完成一次交互后计数 +1（挂点在成功响应之前；失败/拒绝不计）。
 * P1-3/C：改单条原子 SQL（数据库内完成跨日重置判断 + 目标用户递增）——
 * 旧实现读整份 JSON → 内存加一 → 整份覆盖，并发下丢其他用户的更新；
 * 且保持「成功交互」软管控口径：写失败仅告警不抛（不擅自变硬控制）。
 * 注意：postMessage 有 10s 同内容幂等窗，幂等重放走到这里会重复计数——
 * 本模块按「交互次数」宽松口径统计，重放多计可接受，不另做去重。
 */
export async function recordChatMessage(username: string): Promise<void> {
  const conn = getDb()
  if (conn === null || !isDbAvailable()) {
    log.warn('chatPolicy', '用量计数写失败（PG 不可用，本次计数丢失——非硬控制口径可接受）')
    return
  }
  const today = todayStr()
  try {
    await conn.execute(sql`
      INSERT INTO app_settings (key, value)
      VALUES (${USAGE_KEY}, jsonb_build_object('date', ${today}::text, 'counts', jsonb_build_object(${username}::text, 1)))
      ON CONFLICT (key) DO UPDATE SET value = CASE
        WHEN app_settings.value->>'date' = ${today} THEN
          jsonb_set(app_settings.value, ARRAY['counts'::text, ${username}::text],
            to_jsonb(COALESCE((app_settings.value->'counts'->>${username})::int, 0) + 1))
        ELSE jsonb_build_object('date', ${today}::text, 'counts', jsonb_build_object(${username}::text, 1))
        END`)
  } catch (e) {
    log.warn('chatPolicy', '用量计数原子更新失败（本次计数丢失——非硬控制口径可接受）：', (e as Error).message)
  }
}

/** 跨天滚动（纯函数，抽出供 scripts/chat-policy-check 直接自测）：非当日整体归零 */
export function rollUsage(u: ChatUsage, today: string): ChatUsage {
  return u.date === today ? u : { date: today, counts: {} }
}
