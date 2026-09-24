/** 前后端共享的数据结构（与服务端 server/src/types.ts 对应） */

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

/** 服务端 → 前端 WS 消息 */
export type ServerMessage =
  | { type: 'market'; ts: number; stats: MarketStats; tickers: { s: string; c: string; P: string; h: string; l: string; q: string }[] }
  | { type: 'kline'; symbol: string; interval: string; kline: KlineBar }
  | { type: 'alert'; alert: AlertEntry }
