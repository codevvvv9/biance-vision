/**
 * 行情数据共享契约：市场/价格类型、周期、研究期限、K 线行、快照引用与数据质量。
 * 对应 docs/specs/market-data.md；OHLCV 与金额一律用十进制字符串保持精度，
 * 时间统一为 UTC 毫秒整数。
 */

import { z } from 'zod'

/** 精确十进制字符串（整数或小数，可带负号） */
export const DECIMAL_RE = /^-?\d+(\.\d+)?$/
export const DecimalStringSchema = z.string().regex(DECIMAL_RE, '必须是十进制数字符串')
export type DecimalString = z.infer<typeof DecimalStringSchema>

/** 大于 0 的十进制字符串（数量、金额等） */
export const PositiveDecimalStringSchema = DecimalStringSchema.refine(
  (v) => Number(v) > 0,
  '必须是大于 0 的十进制数',
)

/** 交易对代码：大写字母/数字、无分隔符，如 BTCUSDT */
export const SYMBOL_RE = /^[A-Z0-9]{2,30}$/
export const SymbolSchema = z.string().regex(SYMBOL_RE, '交易对须为大写无分隔符形式，如 BTCUSDT')
export type Symbol = z.infer<typeof SymbolSchema>

/** 交易所（预留扩展） */
export const VenueSchema = z.enum(['binance'])
export type Venue = z.infer<typeof VenueSchema>

export const MarketTypeSchema = z.enum(['spot', 'usdm_perp'])
export type MarketType = z.infer<typeof MarketTypeSchema>

export const PriceTypeSchema = z.enum(['trade', 'mark', 'index'])
export type PriceType = z.infer<typeof PriceTypeSchema>

export const INTERVALS = [
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w',
] as const
export const IntervalSchema = z.enum(INTERVALS)
export type Interval = z.infer<typeof IntervalSchema>

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** 各周期的毫秒长度 */
export const INTERVAL_MS: Record<Interval, number> = {
  '1m': MINUTE_MS,
  '3m': 3 * MINUTE_MS,
  '5m': 5 * MINUTE_MS,
  '15m': 15 * MINUTE_MS,
  '30m': 30 * MINUTE_MS,
  '1h': HOUR_MS,
  '2h': 2 * HOUR_MS,
  '4h': 4 * HOUR_MS,
  '6h': 6 * HOUR_MS,
  '8h': 8 * HOUR_MS,
  '12h': 12 * HOUR_MS,
  '1d': DAY_MS,
  '3d': 3 * DAY_MS,
  '1w': 7 * DAY_MS,
}

/** 研究期限桶（官方事件合约为 10m/30m/1h/1d，1w 仅研究模式） */
export const RESEARCH_HORIZONS = ['10m', '30m', '1h', '1d', '1w'] as const
export const ResearchHorizonSchema = z.enum(RESEARCH_HORIZONS)
export type ResearchHorizon = z.infer<typeof ResearchHorizonSchema>

/** 各期限桶的毫秒长度 */
export const HORIZON_MS: Record<ResearchHorizon, number> = {
  '10m': 10 * MINUTE_MS,
  '30m': 30 * MINUTE_MS,
  '1h': HOUR_MS,
  '1d': DAY_MS,
  '1w': 7 * DAY_MS,
}

/** 仅研究模式的期限：界面须显著标注，不得显示为官方事件合约产品 */
export const HORIZON_RESEARCH_ONLY: readonly ResearchHorizon[] = ['1w']

/** 期限匹配容差：|剩余期限 − 模型期限| / 模型期限 超过该值即返回 unavailable */
export const HORIZON_TOLERANCE_RATIO = 0.2

/** 落库/传输用 K 线行（market_candles 表的契约形态） */
export const CandleRowSchema = z.object({
  venue: VenueSchema,
  marketType: MarketTypeSchema,
  priceType: PriceTypeSchema,
  symbol: SymbolSchema,
  interval: IntervalSchema,
  openTime: z.number().int(),
  /** 收盘判断依据（UTC 毫秒） */
  closeTime: z.number().int(),
  open: DecimalStringSchema,
  high: DecimalStringSchema,
  low: DecimalStringSchema,
  close: DecimalStringSchema,
  /** 指数 K 线的占位成交量归一化为 null，不得当作成交量使用 */
  volume: DecimalStringSchema.nullable(),
  quoteVolume: DecimalStringSchema.nullable(),
  trades: z.number().int().nullable(),
  isClosed: z.boolean(),
  /** 交易所事件时间；REST 采集无事件时间为 null */
  eventTime: z.number().int().nullable(),
  receivedAt: z.number().int(),
  source: z.enum(['rest', 'ws', 'backfill']),
  revision: z.number().int().default(0),
})
export type CandleRow = z.infer<typeof CandleRowSchema>

/** 引擎消费的简化 K 线（与 BrooksCandle 对齐，数值为 number） */
export const CandleSchema = z.object({
  time: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().optional(),
  closed: z.boolean().optional(),
  closeTime: z.number().optional(),
})
export type Candle = z.infer<typeof CandleSchema>

/** 研究冻结快照引用：各周期 closeTime<=asOf 的最后已收盘 openTime 集合 */
export const SnapshotRefSchema = z.object({
  snapshotId: z.string().min(1),
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  asOf: z.number().int(),
  /** 部分记录：无数据的周期缺省 */
  perInterval: z.record(
    IntervalSchema,
    z.object({ lastClosedOpenTime: z.number().int() }),
  ),
  /** 实时价格时间戳，独立于闭合 K 线，不混入信号 */
  priceAsOf: z.number().int().nullable(),
  createdAt: z.number().int(),
})
export type SnapshotRef = z.infer<typeof SnapshotRefSchema>

/** 单序列数据质量统计（缺口/延迟），供 /api/market/quality 与监控 */
export const DataQualitySchema = z.object({
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  priceType: PriceTypeSchema,
  interval: IntervalSchema,
  gapCount: z.number().int().nonnegative(),
  /** 当前时间距最后收盘的毫秒数 */
  lagMs: z.number().int().nonnegative(),
  lastClosedOpenTime: z.number().int(),
  checkedAt: z.number().int(),
})
export type DataQuality = z.infer<typeof DataQualitySchema>
