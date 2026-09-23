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

export interface Settings {
  webhookUrl: string
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
