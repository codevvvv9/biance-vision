/**
 * 增量采集：按 ingest_state 游标拉取已收盘 K 线，合法性校验后幂等 upsert，
 * 推进游标并登记缺口（只登记不补平盘，补洞走 backfill.ts）。
 */
import { INTERVAL_MS } from 'biance-vision-brooks'
import type { CandleRow, Interval } from 'biance-vision-brooks'
import { and, eq, sql } from 'drizzle-orm'
import { kv, log } from '../logger.js'
import { ingestState, marketCandles } from '../models.js'
import { requireDb } from './common.js'
import { getProvider } from './providers/registry.js'
import type { MarketDataProvider } from './providers/types.js'
import { seriesKeyText } from './watchlist.js'
import type { SeriesKey } from './watchlist.js'

const VENUE = 'binance'

export interface IngestResult {
  series: SeriesKey
  /** provider 返回的总行数 */
  fetched: number
  /** 已收盘参与 upsert 的行数 */
  closed: number
  /** OHLC 非法被跳过的行数 */
  skippedInvalid: number
  /** 本批新登记缺口（缺失 bar 数） */
  gaps: number
  lastClosedOpenTime: number | null
}

/** OHLC 合法性：high>=low、high>=max(open,close)、low<=min(open,close)、volume>=0（校验用 number，存储仍为十进制字符串） */
export function isValidOhlc(row: CandleRow): boolean {
  const o = Number(row.open)
  const h = Number(row.high)
  const l = Number(row.low)
  const c = Number(row.close)
  if (![o, h, l, c].every(Number.isFinite)) return false
  if (h < l || h < Math.max(o, c) || l > Math.min(o, c)) return false
  if (row.volume !== null && Number(row.volume) < 0) return false
  return true
}

/** 只保留已收盘 K 线：closeTime <= now（REST 返回的未收盘尾根在此丢弃） */
function closedOnly(rows: CandleRow[], now: number): CandleRow[] {
  return rows.filter((r) => r.closeTime <= now)
}

/** 相邻 open_time 与周期推算的缺口（缺失 bar 数）；prev 可为游标 */
function countGaps(rows: CandleRow[], intervalMs: number, prevOpenTime: number | null): number {
  let gaps = 0
  let prev = prevOpenTime
  for (const r of rows) {
    if (prev !== null && r.openTime > prev + intervalMs) {
      gaps += Math.round((r.openTime - prev) / intervalMs) - 1
    }
    prev = r.openTime
  }
  return gaps
}

/**
 * 采集与补洞共用的幂等 upsert：冲突时仅在 revision 更高或字段变化时更新
 * （相同数据重复推送不产生写入，满足幂等）。
 */
export async function persistBars(rows: CandleRow[]): Promise<number> {
  if (rows.length === 0) return 0
  const db = requireDb()
  const values = rows.map((r) => ({
    venue: r.venue,
    marketType: r.marketType,
    priceType: r.priceType,
    symbol: r.symbol,
    interval: r.interval,
    openTime: r.openTime,
    closeTime: r.closeTime,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    quoteVolume: r.quoteVolume,
    trades: r.trades,
    isClosed: r.isClosed,
    eventTime: r.eventTime,
    receivedAt: new Date(r.receivedAt),
    source: r.source,
    revision: r.revision,
  }))
  const res = await db
    .insert(marketCandles)
    .values(values)
    .onConflictDoUpdate({
      target: [
        marketCandles.venue,
        marketCandles.marketType,
        marketCandles.priceType,
        marketCandles.symbol,
        marketCandles.interval,
        marketCandles.openTime,
      ],
      set: {
        closeTime: sql`excluded.close_time`,
        open: sql`excluded.open`,
        high: sql`excluded.high`,
        low: sql`excluded.low`,
        close: sql`excluded.close`,
        volume: sql`excluded.volume`,
        quoteVolume: sql`excluded.quote_volume`,
        trades: sql`excluded.trades`,
        isClosed: sql`excluded.is_closed`,
        eventTime: sql`excluded.event_time`,
        receivedAt: sql`excluded.received_at`,
        source: sql`excluded.source`,
        revision: sql`excluded.revision`,
      },
      setWhere: sql`(
        excluded.revision > ${marketCandles.revision}
        OR (
          excluded.revision = ${marketCandles.revision} AND (
            ${marketCandles.open} IS DISTINCT FROM excluded.open
            OR ${marketCandles.high} IS DISTINCT FROM excluded.high
            OR ${marketCandles.low} IS DISTINCT FROM excluded.low
            OR ${marketCandles.close} IS DISTINCT FROM excluded.close
            OR ${marketCandles.closeTime} IS DISTINCT FROM excluded.close_time
            OR ${marketCandles.volume} IS DISTINCT FROM excluded.volume
            OR ${marketCandles.quoteVolume} IS DISTINCT FROM excluded.quote_volume
            OR ${marketCandles.trades} IS DISTINCT FROM excluded.trades
            OR ${marketCandles.isClosed} IS DISTINCT FROM excluded.is_closed
          )
        )
      )`,
    })
  return res.count ?? values.length
}

/** 序列主键的 where 条件 */
export function seriesWhere(series: SeriesKey) {
  return and(
    eq(ingestState.venue, VENUE),
    eq(ingestState.marketType, series.marketType),
    eq(ingestState.priceType, series.priceType),
    eq(ingestState.symbol, series.symbol),
    eq(ingestState.interval, series.interval),
  )
}

/** 读取序列游标 */
export async function readIngestState(series: SeriesKey) {
  const db = requireDb()
  const rows = await db.select().from(ingestState).where(seriesWhere(series)).limit(1)
  return rows[0] ?? null
}

/** 推进游标并累计缺口登记 */
async function advanceState(series: SeriesKey, lastClosedOpenTime: number | null, newGaps: number, lastError: string | null): Promise<void> {
  const db = requireDb()
  await db
    .insert(ingestState)
    .values({
      venue: VENUE,
      marketType: series.marketType,
      priceType: series.priceType,
      symbol: series.symbol,
      interval: series.interval,
      lastClosedOpenTime,
      lastSyncAt: new Date(),
      gapCount: newGaps,
      status: 'ok',
      lastError,
    })
    .onConflictDoUpdate({
      target: [ingestState.venue, ingestState.marketType, ingestState.priceType, ingestState.symbol, ingestState.interval],
      set: {
        lastClosedOpenTime: lastClosedOpenTime ?? undefined,
        lastSyncAt: new Date(),
        gapCount: sql`${ingestState.gapCount} + ${newGaps}`,
        status: 'ok',
        lastError,
      },
    })
}

/** 采集失败登记（status=error），供 /api/market/quality 与日志排查 */
export async function markIngestError(series: SeriesKey, err: Error): Promise<void> {
  const db = requireDb()
  await db
    .insert(ingestState)
    .values({
      venue: VENUE,
      marketType: series.marketType,
      priceType: series.priceType,
      symbol: series.symbol,
      interval: series.interval,
      lastClosedOpenTime: null,
      lastSyncAt: new Date(),
      gapCount: 0,
      status: 'error',
      lastError: err.message.slice(0, 500),
    })
    .onConflictDoUpdate({
      target: [ingestState.venue, ingestState.marketType, ingestState.priceType, ingestState.symbol, ingestState.interval],
      set: { lastSyncAt: new Date(), status: 'error', lastError: err.message.slice(0, 500) },
    })
}

/**
 * 按游标增量拉取一个序列的已收盘 K 线并落库。
 * sinceOpenTime 显式指定起点（补洞/首采）；缺省从游标 +interval 续拉，无游标拉最新 500 根。
 */
export async function ingestSeries(series: SeriesKey, opts: { sinceOpenTime?: number; limit?: number } = {}): Promise<IngestResult> {
  const intervalMs = INTERVAL_MS[series.interval as Interval]
  const provider: MarketDataProvider = getProvider(series.marketType)
  const state = await readIngestState(series)
  const cursor = opts.sinceOpenTime ?? (state?.lastClosedOpenTime !== null && state?.lastClosedOpenTime !== undefined
    ? state.lastClosedOpenTime + intervalMs
    : undefined)
  const now = Date.now()
  const fetched = await provider.fetchKlines({
    priceType: series.priceType,
    symbol: series.symbol,
    interval: series.interval,
    startTime: cursor,
    limit: opts.limit ?? (cursor === undefined ? 500 : 1000),
  })
  const closed = closedOnly(fetched, now).sort((a, b) => a.openTime - b.openTime)

  // OHLC 合法性：非法行跳过并计入 last_error，不中断整批
  const valid: CandleRow[] = []
  let skippedInvalid = 0
  let firstInvalidOpenTime: number | null = null
  for (const r of closed) {
    if (isValidOhlc(r)) {
      valid.push(r)
    } else {
      skippedInvalid++
      firstInvalidOpenTime ??= r.openTime
      log.warn('market', '跳过非法 K 线', kv({
        序列: seriesKeyText(series),
        openTime: r.openTime,
        ohlc: `${r.open}/${r.high}/${r.low}/${r.close}`,
      }))
    }
  }

  // 缺口边界只对真实数据边界（游标）判定；显式 sinceOpenTime 可能未对齐周期，不作边界
  const gaps = countGaps(valid, intervalMs, state?.lastClosedOpenTime ?? null)
  await persistBars(valid)
  const lastClosedOpenTime = valid.length > 0 ? valid[valid.length - 1].openTime : (state?.lastClosedOpenTime ?? null)
  const lastError = skippedInvalid > 0
    ? `跳过 ${skippedInvalid} 根非法 K 线（首个 openTime=${firstInvalidOpenTime}）`
    : null
  await advanceState(series, lastClosedOpenTime, gaps, lastError)

  const result: IngestResult = {
    series,
    fetched: fetched.length,
    closed: valid.length,
    skippedInvalid,
    gaps,
    lastClosedOpenTime,
  }
  if (valid.length > 0 || gaps > 0 || skippedInvalid > 0) {
    log.info('market', '增量采集完成', kv({
      序列: seriesKeyText(series),
      拉取: fetched.length,
      落库: valid.length,
      非法跳过: skippedInvalid || undefined,
      新缺口: gaps || undefined,
    }))
  }
  return result
}
