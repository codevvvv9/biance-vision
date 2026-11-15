/**
 * 进入研究终端的自动首轮分析（2026-11 需求 3）：
 * 会话就绪且消息流仍为初始问候时，自动以固定速览问题发起一轮研究——
 * 复用聊天链路（上下文同步 / SSE 运行气泡 / 结果卡），产出「该不该操作」的建议。
 *
 * 额度保护（用户实时触发方案拍板时的约束）：
 * - sessionStorage：本浏览器会话只自动触发一次（刷新不重复）
 * - localStorage：同账号+同标的 15 分钟冷却（跨会话防刷新烧额度）
 * - 失败静默（额度不足 403 / 网络错误不打扰用户；手动发送不受任何节流限制）
 */
import { useEffect, useRef } from 'react'
import i18n from '../i18n'

const SESSION_KEY = 'bv.research.autorun.session.v1'
const COOLDOWN_KEY = 'bv.research.autorun.cooldown.v1'
const COOLDOWN_MS = 15 * 60_000

interface CooldownRecord {
  owner: string | null
  symbol: string
  at: number
}

function sessionTriggered(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === '1'
  } catch {
    return true // Storage 被禁用时保守视为已触发（不自动跑）
  }
}

function markSession(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, '1')
  } catch { /* optional */ }
}

function cooldownActive(owner: string | null, symbol: string): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(COOLDOWN_KEY) ?? 'null') as CooldownRecord | null
    if (!raw || raw.owner !== owner || raw.symbol !== symbol) return false
    return Date.now() - raw.at < COOLDOWN_MS
  } catch {
    return false
  }
}

function markCooldown(owner: string | null, symbol: string): void {
  try {
    localStorage.setItem(COOLDOWN_KEY, JSON.stringify({ owner, symbol, at: Date.now() } satisfies CooldownRecord))
  } catch { /* optional */ }
}

export interface UseAutoAnalysisOptions {
  /** 会话就绪（恢复/建会话完成，消息不会发到错误的会话） */
  ready: boolean
  /** 无研究权限（readOnly）不触发 */
  disabled: boolean
  /** 当前标的：证券不触发（AI 研究仅加密货币） */
  symbol: string
  /** 消息流条数：仅初始问候（<=1）时视为「进入终端」场景 */
  messageCount: number
  /** 会话发送（直接传文本，不污染输入框） */
  send: (text: string) => Promise<boolean>
  /** 账号标识（节流隔离） */
  owner: string | null
}

export function useAutoAnalysis(opts: UseAutoAnalysisOptions): void {
  const ref = useRef(opts)
  ref.current = opts
  const fired = useRef(false)

  useEffect(() => {
    if (fired.current) return
    if (!opts.ready || opts.disabled) return
    if (opts.messageCount > 1) return // 已有历史消息（恢复会话）——不是「进入终端」首屏
    if (sessionTriggered() || cooldownActive(opts.owner, opts.symbol)) {
      fired.current = true
      return
    }
    fired.current = true
    markSession()
    markCooldown(opts.owner, opts.symbol)
    const question = i18n.t('research:main.autoQuestion', { symbol: opts.symbol })
    void ref.current.send(question).catch((e) => {
      // 静默：自动触发的失败不打扰用户（手动入口仍可用）
      console.warn('[auto-analysis] 首轮自动分析触发失败', e)
    })
    // 依赖一次性触发：条件齐备即 fire（fired ref 防重复）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.ready, opts.disabled, opts.messageCount, opts.symbol, opts.owner])
}
