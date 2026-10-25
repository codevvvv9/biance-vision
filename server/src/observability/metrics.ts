/**
 * 分钟指标采集（P2b-1，方案 §9.3/§13）：进程内存全量分桶计数 → 每分钟批量快照
 * 入 observability_metric_batches → worker 聚合（受控函数幂等合并）。
 *
 * - 延迟桶：≤100/≤500/≤1000/≤2500/≤10000ms 与 +Inf（分桶即直方图；p95 展示为
 *   命中桶上界，不伪精确）；
 * - 维度标签有限：routeTemplate（注册路由模板，未知归 unmatched）+method+statusClass；
 *   不以 IP/用户/runId 生成标签（高基数）；
 * - 进程每分钟序列 ≤2,000 上限：超出聚合到维度 overflow（防随机 URL 打爆）；
 * - 计数在采样之前（内存全量），快照才是采样点——不拿抽样推总量。
 */
import crypto from 'node:crypto'
import { sql } from 'drizzle-orm'
import { getDb, isDbAvailable } from '../db.js'

const LATENCY_BUCKETS = ['le100', 'le500', 'le1000', 'le2500', 'le10000', 'inf'] as const
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number]
const MAX_DIMENSIONS = 2000

export interface HttpCounter {
  count: number
  latency: Record<LatencyBucket, number>
}

const counters = new Map<string, HttpCounter>()
let bootId = crypto.randomUUID()
let seq = 0
let snapshotTimer: NodeJS.Timeout | null = null

function bucketOf(ms: number): LatencyBucket {
  if (ms <= 100) return 'le100'
  if (ms <= 500) return 'le500'
  if (ms <= 1000) return 'le1000'
  if (ms <= 2500) return 'le2500'
  if (ms <= 10000) return 'le10000'
  return 'inf'
}

export function statusClassOf(status: number): string {
  if (status < 400) return 'ok'
  if (status < 500) return '4xx'
  return '5xx'
}

/** onResponse 计数（内存，同步；路由模板未知归 unmatched） */
export function recordHttpMetric(service: string, routeTemplate: string | null, method: string, status: number, durationMs: number): void {
  const route = (routeTemplate ?? 'unmatched').slice(0, 96)
  const dim = `${method} ${route} ${statusClassOf(status)}`
  let c = counters.get(dim)
  if (c === undefined) {
    if (counters.size >= MAX_DIMENSIONS) {
      c = counters.get('overflow') ?? { count: 0, latency: { le100: 0, le500: 0, le1000: 0, le2500: 0, le10000: 0, inf: 0 } }
      counters.set('overflow', c)
    } else {
      c = { count: 0, latency: { le100: 0, le500: 0, le1000: 0, le2500: 0, le10000: 0, inf: 0 } }
      counters.set(dim, c)
    }
  }
  c.count += 1
  c.latency[bucketOf(durationMs)] += 1
}

/** 分钟快照：当前计数原子换出 → INSERT metric_batches（幂等键 producer/instance/boot/seq） */
export async function snapshotMetrics(service: string, instanceId: string): Promise<boolean> {
  if (counters.size === 0) return true
  const taken = [...counters.entries()]
  counters.clear()
  seq += 1
  const payload: Record<string, { count: number; latency: Record<string, number> }> = {}
  for (const [dim, c] of taken) payload[dim] = { count: c.count, latency: { ...c.latency } }
  const db = getDb()
  if (db === null || !isDbAvailable()) return false // 快照丢弃（计数已换出——丢失本轮，不回灌
  const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000)
  await db.execute(sql`
    INSERT INTO observability_metric_batches (producer, instance_id, boot_id, seq, minute, payload)
    VALUES (${`${service}:http`}, ${instanceId}, ${bootId}, ${seq}, ${minute.toISOString()}, ${JSON.stringify(payload)}::jsonb)
    ON CONFLICT DO NOTHING`)
  return true
}

/** 组合根启动周期快照（幂等；service=入口名） */
export function startMetricSnapshot(service: string, instanceId: string): void {
  if (snapshotTimer !== null) return
  snapshotTimer = setInterval(() => {
    void snapshotMetrics(service, instanceId).catch(() => { counters.clear() })
  }, 60_000)
  snapshotTimer.unref()
}

/** 计数清零（测试） */
export function resetMetricsForTest(): void {
  counters.clear()
  bootId = crypto.randomUUID()
  seq = 0
}
