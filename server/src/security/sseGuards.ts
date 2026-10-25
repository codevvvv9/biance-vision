/**
 * SSE 连接紧急硬限（P1-1，方案 §4.4）：进程内计数——4 条/用户、20 条/IP、
 * 100 条/进程，超额在写 SSE 响应头之前拒绝（429 + Retry-After）。
 *
 * 边界与语义：
 * - 这是单进程紧急上限，多副本部署时不声称跨实例全局上限（P1-2 接共享活动
 *   租约后才有跨进程口径）；本仓库当前单副本 user-api，即事实全局上限；
 * - acquire 在通过准入时返回 ticket；连接关闭/终态清理时 release(ticket)——
 *   释放幂等（ticket 自带 released 守卫，cleanup 双触发/重复注册只减一次）；
 * - Map 容量天然有界（进程上限 100 → 最多 100 个键），无需额外淘汰；
 * - 阈值为配置初值（方案：上线前覆盖多标签/多 run/重连重叠验证后调优），
 *   活动连接硬限始终执行，不走 shadow。
 */
const MAX_PER_USER = 4
const MAX_PER_IP = 20
const MAX_PER_PROCESS = 100

const byUser = new Map<string, number>()
const byIp = new Map<string, number>()
let total = 0

export interface SseTicket {
  user: string
  ip: string
  released: boolean
}

export interface SseAdmission {
  ok: boolean
  /** 通过时携带的释放凭据；拒绝时为拒绝范围（429 响应/日志用） */
  ticket?: SseTicket
  scope?: 'user' | 'ip' | 'process'
  retryAfterSeconds?: number
}

/** 准入：超额返回 ok:false（调用方在写任何 SSE 头之前拒绝并带 Retry-After） */
export function acquireSse(user: string, ip: string): SseAdmission {
  if ((byUser.get(user) ?? 0) >= MAX_PER_USER) return { ok: false, scope: 'user', retryAfterSeconds: 5 }
  if ((byIp.get(ip) ?? 0) >= MAX_PER_IP) return { ok: false, scope: 'ip', retryAfterSeconds: 5 }
  if (total >= MAX_PER_PROCESS) return { ok: false, scope: 'process', retryAfterSeconds: 10 }
  byUser.set(user, (byUser.get(user) ?? 0) + 1)
  byIp.set(ip, (byIp.get(ip) ?? 0) + 1)
  total += 1
  return { ok: true, ticket: { user, ip, released: false } }
}

/** 释放（幂等）：与 acquire 返回的 ticket 严格成对 */
export function releaseSse(ticket: SseTicket): void {
  if (ticket.released) return
  ticket.released = true
  const u = byUser.get(ticket.user) ?? 0
  if (u <= 1) byUser.delete(ticket.user)
  else byUser.set(ticket.user, u - 1)
  const i = byIp.get(ticket.ip) ?? 0
  if (i <= 1) byIp.delete(ticket.ip)
  else byIp.set(ticket.ip, i - 1)
  total = Math.max(0, total - 1)
}

/** 当前计数（诊断/测试断言） */
export function sseCounts(): { total: number; users: number; ips: number } {
  return { total, users: byUser.size, ips: byIp.size }
}

export const SSE_LIMITS = { MAX_PER_USER, MAX_PER_IP, MAX_PER_PROCESS } as const
