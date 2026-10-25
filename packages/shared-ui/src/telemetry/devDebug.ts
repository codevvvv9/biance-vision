/**
 * 浏览器 debug façade（P3-1，方案 §7）：
 * - 仅开发构建挂载 window.__BV_DEBUG__（只读快照：版本/环境/防护模式/遥测状态/
 *   最近请求 ≤100 条 15 分钟）；enableDiagnostics/clear 仅开发额外提供；
 * - ❗生产默认完全不挂对象（DBG-01/03：typeof window.__BV_DEBUG__ === 'undefined'）；
 *   详细生产诊断走 P3-2 受控授权（管理域 grant），前端开关不控制服务端安全；
 * - 不冻结浏览器原型；刷新即清（不跨会话持久化）。
 */
import { telemetryStats } from './index'

export interface BvDebugSnapshot {
  version: string
  environment: 'development' | 'production'
  protectionMode: 'shadow' | 'enforce'
  telemetryState: 'ready' | 'degraded' | 'disabled'
  recentRequests: Array<{ requestId: string; status?: number; code?: string }>
}

const RECENT_MAX = 100
const RECENT_TTL_MS = 15 * 60_000
const recent: Array<{ requestId: string; status?: number; code?: string; at: number }> = []

/** 记录最近请求（由 api() 成功/失败路径调用；有界、过期淘汰） */
export function debugRecordRequest(entry: { requestId: string; status?: number; code?: string }): void {
  if (typeof window === 'undefined' || window.__BV_DEBUG__ === undefined) return // 生产未挂=零成本
  recent.push({ ...entry, at: Date.now() })
  while (recent.length > RECENT_MAX || (recent.length > 0 && Date.now() - recent[0].at > RECENT_TTL_MS)) recent.shift()
}

function snapshot(): BvDebugSnapshot {
  const st = telemetryStats()
  return {
    version: typeof __BV_RELEASE__ !== 'undefined' ? __BV_RELEASE__ : 'dev',
    environment: import.meta.env.MODE === 'production' ? 'production' : 'development',
    protectionMode: 'shadow',
    telemetryState: st.dropped > 100 ? 'degraded' : 'ready',
    recentRequests: recent.map(({ requestId, status, code }) => ({ requestId, status, code })),
  }
}

declare const __BV_RELEASE__: string | undefined

declare global {
  interface Window {
    __BV_DEBUG__?: { snapshot(): Readonly<BvDebugSnapshot> }
  }
}

/** 仅开发入口调用（admin-main/main 的 import.meta.env.DEV 分支）；生产永不挂载 */
export function mountDevDebug(): void {
  if (typeof window === 'undefined' || !import.meta.env.DEV) return
  if (window.__BV_DEBUG__ !== undefined) return
  window.__BV_DEBUG__ = { snapshot }
}
