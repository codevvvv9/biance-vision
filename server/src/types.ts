/** 预警规则类型：价格突破 / 价格跌破 / 24h涨幅超过 / 24h跌幅超过 */
export type RuleType = 'price_above' | 'price_below' | 'change_above' | 'change_below'

/** 币安 !miniTicker@arr 原始字段（值均为字符串；P 为服务端派生写入） */
export interface RawTicker {
  e: string
  E: number
  s: string
  c: string
  o: string
  h: string
  l: string
  v: string
  q: string
  P: string
}

/** 归一化后的行情快照（数值型） */
export interface TickerSnapshot {
  last: number
  changePct: number
  high: number
  low: number
  quoteVolume: number
}

/** 推送给前端的紧凑行情（保持币安短字段名以减小体积） */
export interface CompactTicker {
  s: string
  c: string
  P: string
  h: string
  l: string
  q: string
}

export interface MarketStats {
  up: number
  down: number
  totalQuoteVolume: number
}

export interface AlertRule {
  id: string
  symbol: string
  type: RuleType
  value: number
  note: string
  enabled: boolean
  createdAt: number
  /** 最后修改时间；数据库恢复后与 JSON 镜像按此合并 */
  updatedAt: number
  lastTriggeredAt: number | null
  /** 边缘触发布防状态：true 时条件满足才会触发 */
  armed: boolean
}

/** 新建/更新规则的入参 */
export interface RuleInput {
  symbol?: unknown
  type?: unknown
  value?: unknown
  note?: unknown
  enabled?: unknown
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

export interface Settings {
  webhookUrl: string
}

/** K 线（时间为开盘时间毫秒） */
export interface KlineBar {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number
  closed: boolean
}

/** 币安 kline WS 事件 */
export interface RawKlineEvent {
  e: 'kline'
  E: number
  s: string
  k: {
    t: number
    T: number
    s: string
    i: string
    o: string
    h: string
    l: string
    c: string
    v: string
    q: string
    x: boolean
  }
}

/** REST /api/v3/klines 返回的原始行 */
export type RawKlineRow = [number, string, string, string, string, string, number, string, number, string, string, string]

/** 行情流回调事件 */
export type StreamEvent =
  | { type: 'tickers'; data: RawTicker[] }
  | { type: 'kline'; data: RawKlineEvent }
  | { type: 'status'; connected: boolean }

/** 服务端 → 前端 WS 消息 */
export type ServerMessage =
  | { type: 'market'; ts: number; stats: MarketStats; tickers: CompactTicker[] }
  | { type: 'kline'; symbol: string; interval: string; kline: KlineBar }
  | { type: 'alert'; alert: AlertEntry }

/** 前端 → 服务端 WS 消息 */
export type ClientMessage =
  | { type: 'subscribe'; channel: 'market' }
  | { type: 'subscribe'; channel: 'kline'; symbol: string; interval: string }
  | { type: 'unsubscribe'; channel: 'kline'; symbol: string; interval: string }
