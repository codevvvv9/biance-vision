/**
 * worker 独立入口：行情采集/补洞的 pg-boss 消费进程（与网页是否打开无关）。
 * 启动序列：initDb → DB 不可用则黄色警告并以退出码 0 退出（compose 重启策略负责重试）
 * → startQueue → 注册任务处理器 → 周期调度（快/慢分开键）→ 首启动历史回补。
 */
import './env.js'
import { kv, log } from './logger.js'
import { initDb } from './db.js'
import { initUsers } from './users.js'
import { Q_BACKFILL, Q_FUNDING, Q_INGEST, Q_OI, Q_SWEEP_FAST, Q_SWEEP_SLOW, countCreatedBacklog, getBoss, startQueue, stopQueue } from './queue.js'
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

// BV_AUTO_MIGRATE=0：DDL 由独立 migrate 容器先行（W3-S2）；本地/缺省仍自动迁移
const dbOk = await initDb({ migrate: process.env.BV_AUTO_MIGRATE !== '0' })
if (!dbOk) {
  log.warn('worker', '数据库不可用，worker 退出（退出码 0，由重启策略重试）')
  process.exit(0)
}
// W3-S2：用户真源在 PG（研究 run 的 accessCtxForUser 按发起者角色过滤知识库）；
// users.json 已退役为备份——未加载时按保守语义全体视为普通用户
await initUsers()
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

// 知识库：文档解析任务（PDF/DOCX 走 research-py Docling 异步分批，TXT/MD/HTML 原生）
// W1-B：batchSize=1 显式串行——同一时刻只有一份文档在解析（research-py 内存预算
// 的全局闸，rag-pipeline §4.3；singletonKey 只防同文档重复，不承担全局限流）
await registerKnowledgeWorkers(boss, 1)
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
/** 增量采集积压告警阈值（created 条数）：sweep 每分钟重下发，正常稳态应接近 0；
 * 超阈值=消费停摆（2026-10-25 事故 pg-boss fetch 吞错静默 16h 的对策，logs 侧唯一信号） */
const INGEST_BACKLOG_WARN_THRESHOLD = 500

await boss.work(Q_SWEEP_SLOW, async () => {
  const b = getBoss()
  if (!b) return
  for (const s of watchlistSeriesBySpeed('slow')) {
    await b.send(Q_INGEST, s, { singletonKey: `ingest:${seriesKeyText(s)}`, singletonSeconds: 3000 })
  }
  for (const symbol of watchlistPerpSymbols()) {
    await b.send(Q_FUNDING, { symbol }, { singletonKey: `funding:${symbol}`, singletonSeconds: 3000 })
    await b.send(Q_OI, { symbol }, { singletonKey: `oi:${symbol}:${OI_INTERVAL}`, singletonSeconds: 3000 })
  }
  // 小时级自检：冗余队列本应被 retention 兜底，仍积压说明消费侧异常，必须留下日志证据
  const backlog = await countCreatedBacklog(Q_INGEST).catch(() => -1)
  if (backlog > INGEST_BACKLOG_WARN_THRESHOLD) {
    log.warn('queue', '行情采集积压超阈值（消费可能停摆）', kv({ 队列: Q_INGEST, created: backlog, 阈值: INGEST_BACKLOG_WARN_THRESHOLD, 处置: '查管理端队列健康页/重启 worker' }))
  }
})
await boss.schedule(Q_SWEEP_FAST, '* * * * *')
await boss.schedule(Q_SWEEP_SLOW, '11 * * * *')

// P2b：指标聚合（受控函数幂等）+ worker 心跳（管理 overview 新鲜度）
await boss.work('observability:aggregate', async () => {
  const { getDb } = await import('./db.js')
  const { sql } = await import('drizzle-orm')
  const db = getDb()
  if (!db) return
  try {
    await db.execute(sql`SELECT observability_aggregate_batches(100)`)
    await db.execute(sql`INSERT INTO app_settings (key, value) VALUES ('observability:worker:heartbeat', jsonb_build_object('at', (extract(epoch FROM now())*1000)::bigint, 'pid', ${String(process.pid)}))
      ON CONFLICT (key) DO UPDATE SET value = jsonb_build_object('at', (extract(epoch FROM now())*1000)::bigint, 'pid', ${String(process.pid)})`)
  } catch (e) {
    log.warn('observability', '指标聚合/心跳失败（下轮重试）：', (e as Error).message)
  }
})
await boss.schedule('observability:aggregate', '* * * * *')

// P2b-3 告警评估（心跳类规则；同机全失效时无法评估——恢复后继续，缺口以 first_seen 表达）
await boss.work('observability:alert', async () => {
  const { getDb } = await import('./db.js')
  const { sql } = await import('drizzle-orm')
  const { ALERT_RULES, evaluateAlert } = await import('./observability/alerts.js')
  const db = getDb()
  if (!db) return
  try {
    // 观察值：worker 心跳年龄（本进程刚写心跳=≈0；查库值以防多 worker 全停场景
    // 由后续评估轮发现）与核心依赖（本 worker 视角 PG 可用性）
    const hb = await db.execute(sql`SELECT value->>'at' AS at FROM app_settings WHERE key = 'observability:worker:heartbeat' LIMIT 1`)
    const hbAt = Number((hb as unknown as Array<{ at: string }>)[0]?.at ?? 0)
    const heartbeatAge = hbAt > 0 ? Date.now() - hbAt : null
    for (const rule of ALERT_RULES) {
      const obs = rule.key === 'worker.heartbeat'
        ? { value: heartbeatAge, evidence: { heartbeatAgeMs: heartbeatAge } }
        : { value: db !== null ? 0 : 1, evidence: { dbAvailable: db !== null } }
      const prevRows = await db.execute(sql`SELECT state, normal_streak FROM observability_alerts WHERE rule_key = ${rule.key} AND dimension = '' LIMIT 1`)
      const prev = (prevRows as unknown as Array<{ state: string; normal_streak: number }>)[0]
      const prevState = prev === undefined ? null : { state: prev.state as 'open' | 'acknowledged' | 'resolved', normalStreak: Number(prev.normal_streak) }
      const t = evaluateAlert(rule, obs, prevState)
      const evidence = JSON.stringify(obs.evidence)
      if (t.action === 'create') {
        await db.execute(sql`INSERT INTO observability_alerts (rule_key, rule_version, dimension, state, severity, evidence)
          VALUES (${rule.key}, ${rule.version}, '', 'open', ${rule.severity}, ${evidence}::jsonb)
          ON CONFLICT (rule_key, dimension) DO UPDATE SET state = 'open', last_seen = now(), normal_streak = 0,
            first_seen = now(), resolved_at = NULL, evidence = ${evidence}::jsonb`)
        log.warn('observability', '告警触发', kv({ 规则: rule.key, 证据: evidence.slice(0, 120) }))
      } else if (t.action === 'keep-firing') {
        await db.execute(sql`UPDATE observability_alerts SET last_seen = now(), normal_streak = 0, evidence = ${evidence}::jsonb WHERE rule_key = ${rule.key} AND dimension = ''`)
      } else if (t.action === 'resolve') {
        await db.execute(sql`UPDATE observability_alerts SET state = 'resolved', resolved_at = now(), normal_streak = 0,
          resolved_evidence = ${evidence}::jsonb WHERE rule_key = ${rule.key} AND dimension = ''`)
        log.ok('observability', '告警恢复（连续正常评估窗通过）', kv({ 规则: rule.key }))
      } else if (t.action === 'normal') {
        await db.execute(sql`UPDATE observability_alerts SET normal_streak = ${t.normalStreak}, last_seen = now() WHERE rule_key = ${rule.key} AND dimension = ''`)
      }
    }
  } catch (e) {
    log.warn('observability', '告警评估失败（下轮重试）：', (e as Error).message)
  }
})
await boss.schedule('observability:alert', '* * * * *')

// P2a-1 观测清理（独立并发 1，每分钟）：inbox 原始 14 天 / error_groups 30 天
// 无新事件 / 限流与幂等桶过期；批 1000 行内（方案 §11.3）
await boss.work('observability:cleanup', async () => {
  const { getDb } = await import('./db.js')
  const { sql } = await import('drizzle-orm')
  const db = getDb()
  if (!db) return
  try {
    await db.execute(sql`DELETE FROM observability_inbox WHERE received_at < now() - interval '14 days'`)
    await db.execute(sql`DELETE FROM observability_error_groups WHERE last_seen < now() - interval '30 days'`)
    await db.execute(sql`DELETE FROM security_rate_buckets WHERE expires_at < now() - interval '1 hour'`)
    await db.execute(sql`DELETE FROM request_idempotency WHERE expires_at < now() - interval '1 day'`)
    await db.execute(sql`DELETE FROM observability_alerts WHERE state = 'resolved' AND resolved_at < now() - interval '30 days'`)
    await db.execute(sql`DELETE FROM observability_metric_batches WHERE created_at < now() - interval '24 hours'`)
    await db.execute(sql`DELETE FROM observability_metrics_minute WHERE minute < now() - interval '30 days'`)
  } catch (e) {
    log.warn('observability', '清理任务失败（下轮重试）：', (e as Error).message)
  }
})
await boss.schedule('observability:cleanup', '* * * * *')

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
