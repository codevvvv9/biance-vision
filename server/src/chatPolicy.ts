/**
 * 用户级聊天管控（ChatPolicy）：管理端可对单个用户禁用 AI 助手或设每日交互上限。
 *
 * 与 ai.ts 的档案级配额（checkAiQuota / recordAiUsage，每用户每日 LLM 对话数）
 * 相互独立、任一超限即拒（取严）：档案级限额防共享刷量，本模块是管理端对人的开关。
 *
 * 计数口径：按「成功完成的交互」计数，失败不计（区别于 recordAiUsage 含失败
 * 尝试的防刷口径）。存储 server/data/chat-usage.json，结构同 ai-usage.json
 * （{ date, counts }），按北京时间自然日计，跨天整体重置。
 */
import { loadJson, saveJson } from './store.js'
import { getUsers } from './users.js'
import type { ChatPolicy } from './users.js'

interface ChatUsage {
  date: string
  counts: Record<string, number>
}

let usage = loadJson<ChatUsage>('chat-usage.json', { date: '', counts: {} })

function todayStr(): string {
  // 按北京时间计日（与 ai.ts / 日志时区一致）
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
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

/** 当日已计交互次数（跨天自然归零，与存储重置口径一致） */
export function getChatUsageToday(username: string): number {
  return usage.date === todayStr() ? (usage.counts[username] ?? 0) : 0
}

/**
 * 交互前检查（挂点在鉴权之后、业务之前）：
 * 禁用 → 403 chat_disabled；达当日上限 → 429 chat_limit_exceeded。
 * message 面向最终用户，前端原样展示。
 */
export function assertChatAllowed(username: string): void {
  const policy = policyOf(username)
  if (policy.disabled) {
    throw Object.assign(new Error('聊天已被管理员禁用'), { statusCode: 403, code: 'chat_disabled' })
  }
  const limit = policy.dailyLimit
  if (limit !== null && limit > 0 && getChatUsageToday(username) >= limit) {
    throw Object.assign(new Error(`今日 AI 助手交互次数已达上限（${limit} 次/天）`), {
      statusCode: 429,
      code: 'chat_limit_exceeded',
    })
  }
}

/**
 * 成功完成一次交互后计数 +1（挂点在成功响应之前；失败/拒绝不计）。
 * 注意：postMessage 有 10s 同内容幂等窗，幂等重放走到这里会重复计数——
 * 本模块按「交互次数」宽松口径统计，重放多计可接受，不另做去重。
 */
export function recordChatMessage(username: string): void {
  const today = todayStr()
  if (usage.date !== today) usage = { date: today, counts: {} }
  usage.counts[username] = (usage.counts[username] ?? 0) + 1
  saveJson('chat-usage.json', usage)
}
