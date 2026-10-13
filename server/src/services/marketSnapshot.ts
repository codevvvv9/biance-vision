/**
 * MarketSnapshotService（P1，docs/brooks-agent-improvement-plan.md §2.1）：
 * - 近期窗口：asOf 前最近 N 根已收盘（DESC 取数回正序，readCandles 已实现）；
 * - 历史范围：from/to 升序分页（训练用，不受单页 1500 限制）；
 * - 快照升级为「可复现输入集合」：实际使用的 K 线/资金费率/参考价 + 内容哈希，
 *   元数据落 PG（market_snapshots.inputPackKey/inputHash/quality），输入包存 BlobStore；
 * - 质量规则（版本化工程参数）：最新收盘距 asOf ≤ 周期长度+30s；事件实时指数参考 ≤5s；
 *   必要窗口缺口/错位 → 返回 reason code 阻止动作与概率输出（历史复盘不按当前时间判过期）。
 */
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { INTERVAL_MS } from 'biance-vision-brooks'
import { getDb } from '../db.js'
import { marketSnapshots } from '../models.js'
import { getBlobStore } from '../knowledge/blobstore.js'
import { readCandles } from '../market/read.js'
import { listFunding } from '../market/funding.js'
import { getProvider } from '../market/providers/registry.js'
import { baseIntervalFor } from '../research/features.js'
import { kv, log } from '../logger.js'

export type QualityCode =
  | 'stale_market'
  | 'stale_reference_price'
  | 'window_gap'
  | 'source_mismatch'
  | 'insufficient_history'

export interface SnapshotQualityIssue {
  code: QualityCode
  detail: string
}

export interface FrozenSnapshot {
  snapshotId: string
  asOf: number
  symbol: string
  marketType: 'spot' | 'usdm_perp'
  perInterval: Record<string, { lastClosedOpenTime: number }>
  /** 质量问题（空 = 通过）。存在 stale/gap 类问题时调用方必须阻止动作与概率输出 */
  issues: SnapshotQualityIssue[]
  /** 输入包（研究期内实际使用的数据；回放与图表从快照读取，不重查当前行情） */
  inputPack: {
    candles: { interval: string; priceType: string; rows: { t: number; o: string; h: string; l: string; c: string; v: string | null; rev: number }[] }[]
    funding: { t: number; rate: string }[]
    indexRef: { price: string; at: number } | null
  }
  inputHash: string
  inputPackKey: string | null
}

/** 研究周期 → 执行周期（固定映射）+ 背景周期（高一级） */
export const EXEC_TF: Record<string, string> = { '10m': '1m', '30m': '5m', '1h': '15m', '1d': '1h', '1w': '4h' }
export const BACKGROUND_TF: Record<string, string> = { '10m': '5m', '30m': '15m', '1h': '1h', '1d': '4h', '1w': '1d' }

const COLLECT_GRACE_MS = 30_000
const REF_PRICE_MAX_AGE_MS = 5_000
const WINDOW_BARS = 400

/** 冻结研究快照：按执行/背景周期取已收盘窗口 + 资金费率 + 指数参考价，做质量检查 */
export async function createFrozenSnapshot(input: {
  symbol: string
  marketType: 'spot' | 'usdm_perp'
  horizon: string
  asOf: number
  /** 持久化输入包到 BlobStore（研究运行用 true；临时结构预览可 false） */
  persist?: boolean
  /** 需要实时指数参考价（事件研究：strike_relative 目标用它）；缺省 true 保持事件链路
   * 不变。永续/方向研究传 false——决策用已收盘窗口价，不应被 5s 实时价时效门阻断 */
  needReferencePrice?: boolean
}): Promise<FrozenSnapshot> {
  const db = getDb()
  if (!db) throw Object.assign(new Error('数据库不可用'), { statusCode: 503 })
  // 窗口集合：执行/背景周期 + 1m（实时参考价与短线窗口）+ 预测基础周期
  // （事件/方向预测特征必须与训练同周期：1d/1w 事件的指数特征用 1h，不是 1m）
  const tfs = [...new Set([EXEC_TF[input.horizon] ?? '15m', BACKGROUND_TF[input.horizon] ?? '1h', '1m', baseIntervalFor(input.horizon)])]
  const issues: SnapshotQualityIssue[] = []
  const priceTypes = input.marketType === 'usdm_perp' ? (['trade', 'index'] as const) : (['trade'] as const)

  const candles: FrozenSnapshot['inputPack']['candles'] = []
  const perInterval: Record<string, { lastClosedOpenTime: number }> = {}
  for (const tf of tfs) {
    for (const pt of priceTypes) {
      const rows = await readCandles({
        marketType: input.marketType,
        priceType: pt,
        symbol: input.symbol,
        interval: tf as '1m',
        asOf: input.asOf,
        limit: WINDOW_BARS,
      })
      candles.push({
        interval: tf,
        priceType: pt,
        rows: rows.map((r) => ({ t: r.openTime, o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume, rev: r.revision })),
      })
      if (pt === 'trade') {
        perInterval[tf] = { lastClosedOpenTime: rows.length > 0 ? rows[rows.length - 1].openTime : 0 }
      }
      // 时效检查：trade 全周期 + 预测实际消费的 index 基础周期（评审 F2——
      // 指数特征窗口过期不能与「实时参考价请求成功」混为一谈）
      if (pt === 'trade' || (pt === 'index' && tf === baseIntervalFor(input.horizon))) {
        const intervalMs = INTERVAL_MS[tf as keyof typeof INTERVAL_MS] ?? 60_000
        const lastClose = rows.length > 0 ? rows[rows.length - 1].closeTime : 0
        if (rows.length < 30) {
          issues.push({ code: 'insufficient_history', detail: `${tf}/${pt} 已收盘仅 ${rows.length} 根` })
        } else if (lastClose + intervalMs / 2 < input.asOf - (intervalMs + COLLECT_GRACE_MS)) {
          issues.push({ code: 'stale_market', detail: `${tf}/${pt} 最新收盘距 asOf 超过 周期+30s（lastClose=${new Date(lastClose).toISOString()}）` })
        }
      }
    }
  }

  // 窗口缺口（trade 执行周期上逐根检查 openTime 连续性）
  const execTf = EXEC_TF[input.horizon] ?? '15m'
  const execRows = candles.find((c) => c.interval === execTf && c.priceType === 'trade')?.rows ?? []
  const stepMs = INTERVAL_MS[execTf as keyof typeof INTERVAL_MS] ?? 60_000
  for (let i = 1; i < execRows.length; i++) {
    if (execRows[i].t - execRows[i - 1].t !== stepMs) {
      issues.push({ code: 'window_gap', detail: `${execTf} 执行窗口在 ${new Date(execRows[i].t).toISOString()} 处不连续` })
      break
    }
  }
  // 指数特征窗口缺口（预测实际消费的 index 基础周期，评审 F2）
  const idxBaseTf = baseIntervalFor(input.horizon)
  const idxRows = candles.find((c) => c.interval === idxBaseTf && c.priceType === 'index')?.rows ?? []
  if (idxRows.length > 0) {
    const idxStepMs = INTERVAL_MS[idxBaseTf as keyof typeof INTERVAL_MS] ?? 60_000
    for (let i = 1; i < idxRows.length; i++) {
      if (idxRows[i].t - idxRows[i - 1].t !== idxStepMs) {
        issues.push({ code: 'window_gap', detail: `${idxBaseTf}/index 特征窗口在 ${new Date(idxRows[i].t).toISOString()} 处不连续` })
        break
      }
    }
  }

  // 资金费率（永续）与实时指数参考价（事件）
  let funding: { t: number; rate: string }[] = []
  if (input.marketType === 'usdm_perp') {
    const fr = await listFunding(input.symbol, 12, input.asOf)
    funding = fr.map((f) => ({ t: f.fundingTime, rate: f.fundingRate }))
  }
  // 实时指数参考价：最新一根（可能未收盘）index K 线的 close；要求距 asOf ≤5s（采集宽限）
  let indexRef: { price: string; at: number } | null = null
  if (input.marketType === 'usdm_perp' && input.needReferencePrice !== false) {
    try {
      const k = await getProvider('usdm_perp').fetchKlines({
        priceType: 'index',
        symbol: input.symbol,
        interval: '1m',
        limit: 1,
      })
      const last = k[k.length - 1]
      if (last !== undefined) {
        const at = Date.now()
        if (at - input.asOf > REF_PRICE_MAX_AGE_MS) {
          issues.push({ code: 'stale_reference_price', detail: `实时指数参考价时刻偏离 asOf 超过 5s（${at - input.asOf}ms）` })
        } else {
          indexRef = { price: last.close, at }
        }
      }
    } catch {
      issues.push({ code: 'stale_reference_price', detail: '实时参考价不可达（事件研究默认需要 ≤5s 参考价）' })
    }
  }

  const inputPack: FrozenSnapshot['inputPack'] = { candles, funding, indexRef }
  const inputHash = createHash('sha256').update(JSON.stringify(inputPack)).digest('hex')

  // 持久化：元数据 + 输入包
  let inputPackKey: string | null = null
  const rows = await db
    .insert(marketSnapshots)
    .values({
      symbol: input.symbol,
      marketType: input.marketType,
      asOf: new Date(input.asOf),
      perInterval,
      priceAsOf: indexRef !== null ? new Date(indexRef.at) : null,
      inputHash,
      quality: { ok: issues.length === 0, issues } as unknown as Record<string, unknown>,
    })
    .returning()
  const snapshotId = rows[0].id
  if (input.persist !== false) {
    try {
      inputPackKey = `snapshots/${snapshotId}/${inputHash}.json`
      await getBlobStore().put(inputPackKey, Buffer.from(JSON.stringify(inputPack), 'utf8'))
      await db.update(marketSnapshots).set({ inputPackKey }).where(eq(marketSnapshots.id, snapshotId))
    } catch (err) {
      log.warn('snapshot', '输入包持久化失败（仅影响回放复现）', kv({ 错误: (err as Error).message }))
      inputPackKey = null
    }
  }
    return { snapshotId, asOf: input.asOf, symbol: input.symbol, marketType: input.marketType, perInterval, issues, inputPack, inputHash, inputPackKey }
}

/** 历史复盘读取：从（已冻结的）快照输入包还原窗口，不重查当前行情 */
export async function loadSnapshotPack(snapshotId: string): Promise<FrozenSnapshot['inputPack'] | null> {
  const db = getDb()
  if (!db) return null
  const rows = await db.select().from(marketSnapshots).where(eq(marketSnapshots.id, snapshotId)).limit(1)
  const row = rows[0]
  if (!row || row.inputPackKey === null) return null
  const buf = await getBlobStore().get(row.inputPackKey)
  if (buf === null) return null
  const parsed = JSON.parse(buf.toString('utf8')) as FrozenSnapshot['inputPack']
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex') === row.inputHash ? parsed : null
}

/** 历史范围读取（训练用）：按时间块升序拼接，不受单次 1500 根契约限制。
 * readCandles 的窗口语义是「范围内最近 N 根」，直接移动游标只会拿到末段——
 * 因此把 [from,to] 切成每块 ≤1500 根的时间窗逐块升序取，块间按 openTime 去重。 */
export async function readHistoricalRange(q: {
  marketType: 'spot' | 'usdm_perp'
  priceType: string
  symbol: string
  interval: string
  from: number
  to: number
}): Promise<{ t: number; o: number; h: number; l: number; c: number; v: number | null }[]> {
  const intervalMs = INTERVAL_MS[q.interval as keyof typeof INTERVAL_MS] ?? 60_000
  const chunkMs = 1500 * intervalMs
  const out: { t: number; o: number; h: number; l: number; c: number; v: number | null }[] = []
  const seen = new Set<number>()
  for (let chunkStart = q.from; chunkStart < q.to; chunkStart += chunkMs) {
    const chunkEnd = Math.min(q.to, chunkStart + chunkMs - 1)
    const part = await readCandles({
      marketType: q.marketType,
      priceType: q.priceType as 'trade',
      symbol: q.symbol,
      interval: q.interval as '1m',
      from: chunkStart,
      to: chunkEnd,
      limit: 1500,
    })
    for (const r of part) {
      if (seen.has(r.openTime)) continue
      seen.add(r.openTime)
      out.push({ t: r.openTime, o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close), v: r.volume === null ? null : Number(r.volume) })
    }
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

