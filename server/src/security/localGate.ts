/**
 * 本地入口闸门（P1-2，方案 §4.1）：每个进程内的便宜硬闸门，先于鉴权/密码计算/
 * 大请求体解析执行（onRequest 阶段）；不能替代跨进程配额（PG 原语），
 * 但保证无限新 IP 不带来无限资源消耗，且 PG 故障时仍有兜底。
 *
 * 额度（初始配置）：每 IP 10 次/秒 突发 20；全进程 100 次/秒 突发 200。
 * 桶容量有界：最多 10,000 个 IP 桶，超界先清过期桶（仍超则丢弃最旧——
 * 宁可个别 IP 计数重置，不让 Map 无限增长）。
 */
const PER_IP_RATE = 10
const PER_IP_BURST = 20
const PER_PROCESS_RATE = 100
const PER_PROCESS_BURST = 200
const MAX_BUCKETS = 10_000

interface TokenBucket {
  tokens: number
  updatedAt: number
}

const buckets = new Map<string, TokenBucket>()
let processBucket: TokenBucket = { tokens: PER_PROCESS_BURST, updatedAt: Date.now() }

function refill(b: TokenBucket, rate: number, burst: number, now: number): void {
  b.tokens = Math.min(burst, b.tokens + ((now - b.updatedAt) / 1000) * rate)
  b.updatedAt = now
}

export interface GateVerdict {
  allowed: boolean
  retryAfterMs: number
}

/** 消费一个令牌（进程 + IP 两级）；非 /api 路径由调用方跳过 */
export function localGateConsume(ip: string): GateVerdict {
  const now = Date.now()
  refill(processBucket, PER_PROCESS_RATE, PER_PROCESS_BURST, now)
  if (processBucket.tokens < 1) {
    return { allowed: false, retryAfterMs: 250 }
  }
  processBucket.tokens -= 1

  let b = buckets.get(ip)
  if (b === undefined) {
    if (buckets.size >= MAX_BUCKETS) evictExpired(now)
    b = { tokens: PER_IP_BURST, updatedAt: now }
    buckets.set(ip, b)
  }
  refill(b, PER_IP_RATE, PER_IP_BURST, now)
  if (b.tokens < 1) {
    const waitMs = Math.ceil(((1 - b.tokens) / PER_IP_RATE) * 1000)
    return { allowed: false, retryAfterMs: Math.min(5000, waitMs) }
  }
  b.tokens -= 1
  return { allowed: true, retryAfterMs: 0 }
}

function evictExpired(now: number): void {
  for (const [ip, b] of buckets) {
    if (now - b.updatedAt > 120_000) buckets.delete(ip) // 空闲 2 分钟过期
    if (buckets.size < MAX_BUCKETS) return
  }
  // 仍超界：丢弃最旧（首插入键——Map 保序）；个别 IP 计数重置优于无界增长
  const oldest = buckets.keys().next().value
  if (oldest !== undefined) buckets.delete(oldest)
}

/** 当前计数（诊断/断言） */
export function localGateCounts(): { ips: number; processTokens: number } {
  return { ips: buckets.size, processTokens: processBucket.tokens }
}

export const LOCAL_GATE_LIMITS = { PER_IP_RATE, PER_IP_BURST, PER_PROCESS_RATE, PER_PROCESS_BURST, MAX_BUCKETS } as const
