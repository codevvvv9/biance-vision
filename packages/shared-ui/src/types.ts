/** 前后端共享的数据结构（与服务端 server/src/types.ts 对应） */

import type { ConversationMessage, ResearchRunStatus } from 'biance-vision-brooks'

export type RuleType = 'price_above' | 'price_below' | 'change_above' | 'change_below'

export interface Ticker {
  symbol: string
  last: number
  changePct: number
  high: number
  low: number
  quoteVolume: number
}

export interface MarketStats {
  up: number
  down: number
  totalQuoteVolume: number
}

export interface KlineBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume?: number
  closed?: boolean
}

export interface AlertRule {
  id: string
  symbol: string
  type: RuleType
  value: number
  note: string
  enabled: boolean
  createdAt: number
  lastTriggeredAt: number | null
  armed: boolean
}

export interface AlertEntry {
  id: string
  ruleId?: string
  test?: boolean
  symbol: string
  type?: RuleType
  value?: number
  note?: string
  message: string
  price: number
  changePct: number
  triggeredAt: number
}

export type ConnStatus = 'connecting' | 'connected' | 'offline'

/** 登录用户（与服务端 /api/auth/* 对应） */
export interface AuthUser {
  username: string
  role: 'user' | 'superadmin'
}

/** 系统用户（与 /api/admin/users 对应，仅超管可见，不含密码） */
export interface AdminUser {
  username: string
  role: AuthUser['role']
  createdAt: number
}

/** 用户级聊天管控策略（与 PUT /api/admin/users/:username/chat-policy 对应） */
export interface ChatPolicy {
  disabled: boolean
  /** 每日交互上限；null = 不限 */
  dailyLimit: number | null
}

/** 管理端用户列表行（GET /api/admin/users）：附带聊天管控、当日用量与活跃近似（5 分钟内有审计写动作） */
export interface AdminUserRow extends AdminUser {
  chatPolicy: ChatPolicy
  chatUsage: { today: number; limit: number | null }
  activeRecently: boolean
}

export interface Settings {
  webhookUrl: string
}

/** 操作审计（与服务端 /api/admin/audit-logs 对应，会话聚合式） */
export type AuditAction =
  | 'login'
  | 'login_failed'
  | 'logout'
  | 'rule_create'
  | 'rule_update'
  | 'rule_delete'
  | 'settings_update'
  | 'settings_test'
  | 'chat_policy_update'
  | 'chat_cutoff'

/** 会话内单次操作 */
export interface AuditEntry {
  at: number
  action: AuditAction
  target: string
  detail: string
  ok: boolean
}

/** 一次登录 = 一条会话记录；登录失败为独立事件 */
export interface AuditRecord {
  id: string
  kind: 'session' | 'login_failed'
  username: string
  ip: string
  userAgent: string
  /** 会话 = 登录时间；失败事件 = 发生时间 */
  at: number
  /** 会话结束时间（登出）；null = 未结束 */
  endedAt: number | null
  actions: AuditEntry[]
  lastActiveAt: number
  /** 会话状态（失败事件为 null）：active 进行中 / ended 已登出 / expired 已过期 */
  status: 'active' | 'ended' | 'expired' | null
}

export interface ToastItem {
  id: number
  kind: 'alert' | 'info'
  title: string
  body?: string
}

/** 管理端 AI 使用统计（与 /api/admin/ai/overview 对应，仅超管） */
export interface AiUserStat {
  username: string
  profileName: string
  conversations: number
  messages: number
  memories: number
  lastActiveAt: number
}

/** AI 会话消息（用户/助手） */
export interface AiStoredMessage {
  role: 'user' | 'assistant'
  content: string
  at: number
}

/** AI 会话摘要与详情 */
export interface AiConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface AiConversationDetail extends AiConversationSummary {
  username: string
  messages: AiStoredMessage[]
}

/** 长期记忆（服务端自动从对话提取） */
export interface AiMemoryItem {
  id: string
  kind: 'preference' | 'fact' | 'interest' | 'habit'
  content: string
  createdAt: number
  updatedAt: number
}

/** 生效档案配置（脱敏，与 /api/admin/ai/user 对应） */
export interface AiProfileMasked {
  baseUrl: string
  model: string
  apiKeyMasked: string
  temperature?: number
  maxTokens?: number
  extraPrompt?: string
  dailyLimit?: number
  allowedUsers?: string[]
}

/** 研究会话上下文（链路 B conversations.context；与服务端会话同步字段一致，其余键原样保留） */
export interface AdminConversationContext {
  product?: 'perp' | 'event' | 'teaching'
  symbol?: string
  marketType?: 'spot' | 'usdm_perp'
  horizon?: '10m' | '30m' | '1h' | '1d' | '1w'
  positionId?: string | null
  quoteId?: string | null
  /** 待确认的持仓草稿（确认卡未落库前挂在上下文上） */
  draft?: Record<string, unknown> | null
  [key: string]: unknown
}

/** 研究会话摘要（GET /api/admin/conversations?username=，仅超管） */
export interface AdminConversationSummary {
  id: string
  title: string
  context: AdminConversationContext
  updatedAt: number
  messageCount: number
}

/** 消息意图（从 shared ConversationMessage['intent'] 同源提取；值集与 server Intent 一致，避免双源漂移） */
export type ChatIntent = NonNullable<ConversationMessage['intent']>

/** 会话内联卡片：confirm_position 持仓确认卡 / completion */
export interface AdminMessageCard {
  kind: 'confirm_position' | 'completion'
  draft: Record<string, unknown>
  missingFields?: string[]
  complete?: boolean
}

/**
 * 研究会话消息（GET /api/admin/conversations/:id）。
 * 与 shared ConversationMessage 的实质差异（故保留本地定义）：admin 详情接口不返回 conversationId；
 * card 为 DB 原样结构，多 missingFields/complete 两个字段（shared schema 未覆盖）
 */
export interface AdminConversationMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  intent: ChatIntent | null
  content: string
  card: AdminMessageCard | null
  runId: string | null
  createdAt: number
}

/** 研究运行状态：re-export shared/contract/research.ts 的同源定义，避免双源漂移 */
export type { ResearchRunStatus }

/** 会话引用的研究运行摘要（按 runId 去重后随详情返回） */
export interface AdminRunRef {
  id: string
  status: ResearchRunStatus
  product: string
  symbol: string
  horizon: string
  createdAt: number
}

/** 研究会话详情（GET /api/admin/conversations/:id）：完整消息 + 引用运行摘要 */
export interface AdminConversationDetail {
  conversation: {
    id: string
    userId: string
    title: string
    context: AdminConversationContext
    createdAt: number
    updatedAt: number
  }
  messages: AdminConversationMessage[]
  runs: Record<string, AdminRunRef>
}

/** 服务端 → 前端 WS 消息 */
export type ServerMessage =
  | { type: 'market'; ts: number; stats: MarketStats; tickers: { s: string; c: string; P: string; h: string; l: string; q: string }[] }
  | { type: 'kline'; symbol: string; interval: string; kline: KlineBar }
  | { type: 'alert'; alert: AlertEntry }
