/**
 * 补洞：检测缺口（相邻 open_time 差 > 一个周期）→ 分段 REST 回补（每段 ≤1000 根，
 * 段间 sleep 退避尊重权重），全部走 ingest 同一 upsert 路径（幂等，不产生重复行）。
 * 补完后重算缺口登记；断网/限流中断后按游标恢复。
 */
import { INTERVAL_MS } from 'biance-vision-brooks'
import type { Interval } from 'biance-vision-brooks'
import { and, asc, eq } from 'drizzle-orm'
import { kv, log } from '../logger.js'
import { ingestState, marketCandles } from '../models.js'
import { requireDb } from './common.js'
import { isValidOhlc, persistBars, seriesWhere } from './ingest.js'
import { getProvider } from './providers/registry.js'
import { seriesKeyText } from './watchlist.js'
import type { SeriesKey } from './watchlist.js'

const VENUE = 'binance'
/** 每段最多 1000 根（klines 上限）；段间退避间隔 */
const SEGMENT_BARS = 1000
const SEGMENT_SLEEP_MS = 250

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface GapRange {
  fromOpenTime: number
  toOpenTime: number
  missingBars: number
}

/** 从库内已落数据检测缺口段（闭区间，单位 openTime） */
export async function detectGaps(series: SeriesKey): Promise<GapRange[]> {
  const db = requireDb()
  const intervalMs = INTERVAL_MS[series.interval as Interval]
  const rows = await db
    .select({ openTime: marketCandles.openTime })
    .from(marketCandles)
    .where(
      and(
        eq(marketCandles.venue, VENUE),
        eq(marketCandles.marketType, series.marketType),
        eq(marketCandles.priceType, series.priceType),
        eq(marketCandles.symbol, series.symbol),
        eq(marketCandles.interval, series.interval),
      ),
    )
    .orderBy(asc(marketCandles.openTime))
  const gaps: GapRange[] = []
  for (let i = 1; i < rows.length; i++) {
    const diff = rows[i].openTime - rows[i - 1].openTime
    if (diff > intervalMs) {
      gaps.push({
        fromOpenTime: rows[i - 1].openTime + intervalMs,
        toOpenTime: rows[i].openTime - intervalMs,
        missingBars: Math.round(diff / intervalMs) - 1,
      })
    }
  }
  return gaps
}

/** 分段回补指定区间；返回实际落库 bar 数 */
export async function backfillRange(series: SeriesKey, fromOpenTime: number, toOpenTime: number): Promise<number> {
  const provider = getProvider(series.marketType)
  const intervalMs = INTERVAL_MS[series.interval as Interval]
  const now = Date.now()
  let cursor = fromOpenTime
  let total = 0
  while (cursor <= toOpenTime) {
    const endTime = Math.min(toOpenTime, cursor + SEGMENT_BARS * intervalMs - 1)
    const fetched = await provider.fetchKlines({
      priceType: series.priceType,
      symbol: series.symbol,
      interval: series.interval,
      startTime: cursor,
      endTime,
      limit: SEGMENT_BARS,
    })
    // 与 ingest 同一路径：只取已收盘 + OHLC 合法性 + 幂等 upsert；source 标记为 backfill
    const rows = fetched
      .filter((r) => r.closeTime <= now && isValidOhlc(r))
      .map((r) => ({ ...r, source: 'backfill' as const }))
    await persistBars(rows)
    total += rows.length
    const lastOpenTime = fetched.length > 0 ? Math.max(...fetched.map((r) => r.openTime)) : 0
    if (lastOpenTime < cursor) break // 交易所该区间无数据（如上币前），避免死循环
    cursor = lastOpenTime + intervalMs
    if (cursor <= toOpenTime) await sleep(SEGMENT_SLEEP_MS)
  }
  log.info('market', '区间回补完成', kv({
    序列: seriesKeyText(series),
    区间: `${new Date(fromOpenTime).toISOString()} → ${new Date(toOpenTime).toISOString()}`,
    落库: total,
  }))
  return total
}

/** 全量重算缺口登记（补洞后调用，与库内实际数据对齐） */
export async function refreshGapCount(series: SeriesKey): Promise<number> {
  const gaps = await detectGaps(series)
  const count = gaps.reduce((acc, g) => acc + g.missingBars, 0)
  const db = requireDb()
  await db
    .update(ingestState)
    .set({ gapCount: count, lastSyncAt: new Date() })
    .where(seriesWhere(series))
  return count
}

/** 检测并回补全部缺口段；返回回补的段数 */
export async function backfillGaps(series: SeriesKey): Promise<number> {
  const gaps = await detectGaps(series)
  for (const gap of gaps) {
    await backfillRange(series, gap.fromOpenTime, gap.toOpenTime)
  }
  const remaining = await refreshGapCount(series)
  if (gaps.length > 0) {
    log.ok('market', '缺口回补完成', kv({
      序列: seriesKeyText(series),
      回补段数: gaps.length,
      剩余缺口: remaining,
    }))
  }
  return gaps.length
}

/** 首启动历史回补：最近 N 根（够结构引擎与特征用即可） */
export async function backfillRecent(series: SeriesKey, bars: number): Promise<number> {
  const intervalMs = INTERVAL_MS[series.interval as Interval]
  const toOpenTime = Date.now() - intervalMs
  const fromOpenTime = toOpenTime - bars * intervalMs
  return backfillRange(series, fromOpenTime, toOpenTime)
}

/** 供 worker 判断序列是否首采（无游标） */
export async function isFreshSeries(series: SeriesKey): Promise<boolean> {
  const db = requireDb()
  const rows = await db
    .select({ lastClosedOpenTime: ingestState.lastClosedOpenTime })
    .from(ingestState)
    .where(seriesWhere(series))
    .limit(1)
  return rows.length === 0 || rows[0].lastClosedOpenTime === null
}
