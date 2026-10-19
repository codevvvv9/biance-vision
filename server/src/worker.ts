/**
 * worker 独立入口：行情采集/补洞的 pg-boss 消费进程（与网页是否打开无关）。
 * 启动序列：initDb → DB 不可用则黄色警告并以退出码 0 退出（compose 重启策略负责重试）
 * → startQueue → 注册任务处理器 → 周期调度（快/慢分开键）→ 首启动历史回补。
 */
import './env.js'
import { kv, log } from './logger.js'
import { initDb } from './db.js'
import { Q_BACKFILL, Q_FUNDING, Q_INGEST, Q_OI, Q_SWEEP_FAST, Q_SWEEP_SLOW, getBoss, startQueue, stopQueue } from './queue.js'
import { backfillRange, backfillRecent, detectGaps, isFreshSeries, refreshGapCount } from './market/backfill.js'
import { ingestFunding } from './market/funding.js'
import { ingestSeries, markIngestError } from './market/ingest.js'
import { ingestOpenInterest } from './market/oi.js'
import { OI_INTERVAL, seriesKeyText, watchlistPerpSymbols, watchlistSeries, watchlistSeriesBySpeed } from './market/watchlist.js'
import type { SeriesKey } from './market/watchlist.js'
import { registerKnowledgeWorkers } from './knowledge/jobs.js'
import { currentBlobStoreKind } from './knowledge/blobstore.js'
import { probeVectorSupport } from './knowledge/vector.js'
import { registerResearchWorkers } from './research/runs/jobs.js'
import { registerAdminWorkers } from './admin/jobs.js'

type IngestJob = SeriesKey
type BackfillJob = SeriesKey & { fromOpenTime: number; toOpenTime: number }
type FundingJob = { symbol: string }
type OiJob = { symbol: string; interval: typeof OI_INTERVAL }

/** 首启动历史回补根数（够结构引擎与特征用即可） */
const INITIAL_BACKFILL_BARS = 2000
/** 单次缺口回补任务展开的最大段数（防爆队列） */
const MAX_BACKFILL_SEGMENTS = 10

const dbOk = await initDb()
if (!dbOk) {
  log.warn('worker', '数据库不可用，worker 退出（退出码 0，由重启策略重试）')
  process.exit(0)
}
const boss = await startQueue()
if (!boss) {
  log.warn('worker', '队列启动失败，worker 退出（退出码 0，由重启策略重试）')
  process.exit(0)
}

/** 增量采集一条序列；发现缺口时展开回补任务 */
async function handleIngest(series: IngestJob): Promise<void> {
  try {
    const r = await ingestSeries(series)
    if (r.gaps > 0) await planBackfill(series)
  } catch (err) {
    await markIngestError(series, err as Error).catch(() => {})
    throw err
  }
}

/** 按库内实际缺口展开 market:backfill 任务（singleton 防重） */
async function planBackfill(series: SeriesKey): Promise<void> {
  const b = getBoss()
  if (!b) return
  const gaps = await detectGaps(series)
  for (const g of gaps.slice(0, MAX_BACKFILL_SEGMENTS)) {
    await b.send(
      Q_BACKFILL,
      { ...series, fromOpenTime: g.fromOpenTime, toOpenTime: g.toOpenTime },
      { singletonKey: `backfill:${seriesKeyText(series)}:${g.fromOpenTime}`, singletonSeconds: 3600 },
    )
  }
  if (gaps.length > 0) {
    log.warn('market', '检测到缺口，已登记回补任务', kv({ 序列: seriesKeyText(series), 段数: Math.min(gaps.length, MAX_BACKFILL_SEGMENTS) }))
  }
}

await boss.work<IngestJob>(Q_INGEST, async (jobs) => {
  for (const job of jobs) await handleIngest(job.data)
})

await boss.work<BackfillJob>(Q_BACKFILL, async (jobs) => {
  for (const job of jobs) {
    const { fromOpenTime, toOpenTime, ...series } = job.data
    await backfillRange(series, fromOpenTime, toOpenTime)
    await refreshGapCount(series)
  }
})

await boss.work<FundingJob>(Q_FUNDING, async (jobs) => {
  for (const job of jobs) await ingestFunding(job.data.symbol)
})

await boss.work<OiJob>(Q_OI, async (jobs) => {
  for (const job of jobs) await ingestOpenInterest(job.data.symbol, job.data.interval)
})

// 知识库：文档解析任务（PDF/DOCX 走 research-py Docling，TXT/MD/HTML 原生）
await registerKnowledgeWorkers(boss)
void probeVectorSupport().catch(() => {})

// 研究流程：固定流水线执行 + 报价到期研究估算（*/10 分钟）
await registerResearchWorkers(boss)

// Admin 域：评测运行 + 模型训练（research-py）
await registerAdminWorkers(boss)

// 周期调度：快序列每分钟扇出；慢序列 + funding/OI 每小时扇出（分开键避免互相阻塞）
await boss.work(Q_SWEEP_FAST, async () => {
  const b = getBoss()
  if (!b) return
  for (const s of watchlistSeriesBySpeed('fast')) {
    await b.send(Q_INGEST, s, { singletonKey: `ingest:${seriesKeyText(s)}`, singletonSeconds: 50 })
  }
})
await boss.work(Q_SWEEP_SLOW, async () => {
  const b = getBoss()
  if (!b) return
  for (const s of watchlistSeriesBySpeed('slow')) {
    await b.send(Q_INGEST, s, { singletonKey: `ingest:${seriesKeyText(s)}`, singletonSeconds: 3000 })
  }
  for (const symbol of watchlistPerpSymbols()) {
    await b.send(Q_FUNDING, { symbol }, { singletonKey: `funding:${symbol}`, singletonSeconds: 3000 })
    await b.send(Q_OI, { symbol, interval: OI_INTERVAL }, { singletonKey: `oi:${symbol}:${OI_INTERVAL}`, singletonSeconds: 3000 })
  }
})
await boss.schedule(Q_SWEEP_FAST, '* * * * *')
await boss.schedule(Q_SWEEP_SLOW, '11 * * * *')

/** 首启动：无游标的序列回补最近 INITIAL_BACKFILL_BARS 根；已有游标的入队追平 */
async function initialBackfill(): Promise<void> {
  const series = watchlistSeries()
  let fresh = 0
  for (const s of series) {
    try {
      if (await isFreshSeries(s)) {
        fresh++
        log.info('worker', '首启动历史回补', kv({ 序列: seriesKeyText(s), 根数: INITIAL_BACKFILL_BARS }))
        await backfillRecent(s, INITIAL_BACKFILL_BARS)
        await ingestSeries(s)
        await refreshGapCount(s)
      } else {
        const b = getBoss()
        if (b) {
          await b.send(Q_INGEST, s, { singletonKey: `ingest:${seriesKeyText(s)}`, singletonSeconds: 60 })
        }
      }
    } catch (err) {
      log.warn('worker', '首采失败（等待周期任务重试）', kv({ 序列: seriesKeyText(s), 错误: (err as Error).message }))
      await markIngestError(s, err as Error).catch(() => {})
    }
  }
  for (const symbol of watchlistPerpSymbols()) {
    try {
      await ingestFunding(symbol)
      await ingestOpenInterest(symbol, OI_INTERVAL)
    } catch (err) {
      log.warn('worker', '资金费率/持仓量首采失败', kv({ 交易对: symbol, 错误: (err as Error).message }))
    }
  }
  log.ok('worker', '首启动回补完成', kv({ 序列数: series.length, 首采: fresh }))
}

await initialBackfill()
log.ok('worker', '行情 worker 已就绪', kv({ pid: process.pid, 调度: 'fast=* * * * * / slow=11 * * * *', 对象存储: currentBlobStoreKind() }))

const shutdown = (signal: string): void => {
  log.info('worker', `收到 ${signal}，正在停止`)
  void stopQueue().finally(() => process.exit(0))
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => {
  log.error('worker', 'unhandled rejection:', err)
})
