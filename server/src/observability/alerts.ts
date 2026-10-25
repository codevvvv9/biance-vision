/**
 * 运维告警（P2b-3，方案 §12.3/§12.4）：心跳类规则先行——worker 心跳新鲜度与
 * 核心依赖可用性。评估器为纯函数（evaluate(rule, obs, prev)），状态转换在
 * worker 每分钟评估任务里落库（活跃事件唯一：同规则同维度一个 incident）。
 *
 * 状态机：open（首次触发）→ acknowledged（有人接手，≠恢复）→ resolved
 * （连续 2 个评估窗正常才恢复——恢复验证；resolved 后再触发=新 incident，
 * 不覆盖历史 resolved_at）。规则维护中可 suppress（记录原因）。
 * 同机故障边界：PG 与 worker 同时失效时无法生成/送达告警（§12.6）——恢复后
 * 评估继续、缺口以 first_seen 表达，不凭无数据自动 resolved。
 */

export type AlertLevel = 'normal' | 'firing'

export interface AlertObservation {
  /** 观察值（如心跳年龄 ms；null=数据源不可用——不评估、保留既有事件） */
  value: number | null
  evidence: Record<string, unknown>
}

export interface AlertRuleDef {
  key: string
  version: number
  severity: 'medium' | 'high' | 'critical'
  /** 触发阈值（观察值 > threshold 为 firing；value=null 不评估） */
  threshold: number
  /** 恢复需连续正常评估窗数（≥1；2=防抖） */
  recoveryWindows: number
  runbook: string
}

/** 心跳类规则注册表（具名；新增规则在此声明，评估任务自动覆盖） */
export const ALERT_RULES: AlertRuleDef[] = [
  {
    key: 'worker.heartbeat',
    version: 1,
    severity: 'high',
    threshold: 90_000, // 心跳年龄 >90s 触发（方案 §12.2）
    recoveryWindows: 2,
    runbook: 'worker-heartbeat',
  },
  {
    key: 'db.available',
    version: 1,
    severity: 'critical',
    threshold: 0, // value=1（不可用）触发
    recoveryWindows: 1,
    runbook: 'db-available',
  },
]

export interface AlertRowState {
  state: 'open' | 'acknowledged' | 'resolved'
  normalStreak: number
}

export type Transition =
  | { action: 'create' }
  | { action: 'keep-firing' }
  | { action: 'normal'; normalStreak: number }
  | { action: 'resolve' }
  | { action: 'reopen' }
  | { action: 'none' }

/**
 * 纯评估：数据源不可用（value=null）→ none（保留既有事件，不凭缺数据恢复）；
 * firing：无事件 create；open/ack 事件 keep-firing（resolved 事件 reopen）；
 * normal：连续窗计数，达到 recoveryWindows 且事件未 resolved → resolve。
 */
export function evaluateAlert(rule: AlertRuleDef, obs: AlertObservation, prev: AlertRowState | null): Transition {
  if (obs.value === null) return { action: 'none' }
  const firing = rule.key === 'db.available' ? obs.value > rule.threshold : obs.value > rule.threshold
  if (firing) {
    if (prev === null || prev.state === 'resolved') return { action: 'create' }
    return { action: 'keep-firing' }
  }
  if (prev === null || prev.state === 'resolved') return { action: 'none' }
  const streak = prev.normalStreak + 1
  if (streak >= rule.recoveryWindows) return { action: 'resolve' }
  return { action: 'normal', normalStreak: streak }
}
