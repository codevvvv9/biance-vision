/**
 * 共享限流原语（P1-2，方案 §4.1/§13.2）：唯一入口 rateLimitConsume(policy, subject)。
 *
 * - 存储：PG security_rate_buckets 经受控函数 security_consume_rate_limit（原子
 *   UPSERT+条件 UPDATE；双进程并发/重启/窗口边界不丢不重）；
 * - 固定窗口（第一版不做 token bucket 等多套算法）；新 scope 按数据库时间对齐窗口；
 * - 主体经 HMAC（security/subjectHash.ts）后入桶——任意 URL/查询串/原始 token
 *   不作为标签；IP 明文不落表（诊断存储默认 HMAC，方案 §9.1）；
 * - 模式：enforce 命中 → 调用方 429；shadow 命中 → 业务放行 + 记录
 *   event=rate_limit_shadow / decision=should_block（独立 'shadow:' 桶，不消费
 *   正式额度；7 自然日 shadow 后按 scope 切 enforce，方案 §13.2）；
 * - 故障语义：enforce 策略存储不可用 → 503 security_state_unavailable（fail-closed，
 *   不退回无限制）；shadow 存储不可用 → 业务放行 + shadow_unavailable 告警
 *   （模拟故障不拒绝本应合法的请求）。
 * - 路由只经 registerRateLimitGuard 注册策略 id，不另写限流 SQL。
 */
import { sql } from 'drizzle-orm'
import { getDb, isDbAvailable } from '../db.js'
import { record } from '../logger.js'
import { subjectHashOf } from './subjectHash.js'

export interface RatePolicy {
  /** 策略 id（注册表键；日志/切 enforce 的口径单位） */
  id: string
  limit: number
  windowMs: number
  mode: 'shadow' | 'enforce'
}

/**
 * 策略注册表（OCP 具名注册）：P1-2 起按批次登记；未知 id 调用即抛错（启动期
 * 静态注册，不接受客户端动态定义）。阈值是待压测验证的初始配置（方案 §4.2）。
 */
export const RATE_POLICIES: Readonly<Record<string, RatePolicy>> = {
  // P1-2 交付的最小策略：CSRF 签发端点（P0-2b 端点的强制入口配额，30/分/IP）
  'csrf.issue:ip': { id: 'csrf.issue:ip', limit: 30, windowMs: 60_000, mode: 'enforce' },
}

export interface RateDecision {
  /** 业务是否放行（shadow 命中恒 true；enforce 超限 false） */
  allowed: boolean
  decision: 'allow' | 'should_block' | 'block'
  counter: number
  remaining: number
  retryAfterSeconds: number
}

function shadowId(policy: RatePolicy): string {
  return policy.mode === 'shadow' ? `shadow:${policy.id}` : policy.id
}

/** 消费一次配额；subject 为服务端规范化主体（IP 经统一 clientIp / 用户名 / 管理员） */
export async function rateLimitConsume(policy: RatePolicy, subject: string): Promise<RateDecision> {
  const conn = getDb()
  if (conn === null || !isDbAvailable()) {
    if (policy.mode === 'enforce') {
      throw Object.assign(new Error('安全状态暂不可用，请稍后重试'), { statusCode: 503, code: 'security_state_unavailable' })
    }
    record({ level: 'warn', tag: 'ratelimit', message: 'shadow 存储不可用（本请求放行，模拟计数缺失）', attributes: { policy: policy.id } })
    return { allowed: true, decision: 'allow', counter: 0, remaining: policy.limit, retryAfterSeconds: 0 }
  }
  const rows = await conn.execute(
    sql`SELECT security_consume_rate_limit(${shadowId(policy)}, ${subjectHashOf(subject)}, ${policy.limit}, ${policy.windowMs}) AS r`)
  const r = (rows as unknown as Array<{ r: { allowed: boolean; counter: number; limit: number; retry_after_seconds: number } }>)[0]?.r
  if (r === undefined) {
    throw Object.assign(new Error('安全状态暂不可用，请稍后重试'), { statusCode: 503, code: 'security_state_unavailable' })
  }
  const overLimit = !r.allowed
  const decision: RateDecision['decision'] = overLimit ? (policy.mode === 'enforce' ? 'block' : 'should_block') : 'allow'
  if (overLimit && policy.mode === 'shadow') {
    // shadow 命中：照常计数但不拒绝业务（不创建任务/不扣额度——本函数只做判定）
    record({ level: 'info', tag: 'ratelimit', message: 'rate_limit_shadow', attributes: { policy: policy.id, decision, counter: r.counter, limit: r.limit } })
  }
  return {
    allowed: !(overLimit && policy.mode === 'enforce'),
    decision,
    counter: r.counter,
    remaining: Math.max(0, r.limit - r.counter),
    retryAfterSeconds: r.retry_after_seconds,
  }
}

/** 429 响应构造（调用方在拒绝时使用；Retry-After 整数秒） */
export function rateLimitedError(retryAfterSeconds: number): Error {
  return Object.assign(new Error('请求过于频繁，请稍后再试'), { statusCode: 429, code: 'rate_limited', retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)) })
}
