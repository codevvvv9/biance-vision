/**
 * 上下文卡（P1-4，vertical-agent-architecture.md §4.D Context Card）：
 * 常驻研究台，显示「当前分析对象」三态——持仓 / 报价 / 裸 symbol+周期——
 * 与有效期徽章（新鲜 / 过期需确认）；切换/清除仍走既有 context PATCH（不改语义）。
 * 内联长期画像快捷编辑（trader_profiles：风险偏好/经验；leverageHabitMax 为
 * 描述性字段「历史习惯」，不作授权上限——文案明示）。
 */
import { useEffect, useState } from 'react'
import type { EventQuote, Position, TraderProfile } from 'biance-vision-brooks'
import { api } from '../api'
import { Dropdown } from './Dropdown'

interface Props {
  symbol: string
  horizon: string
  product: string
  position: Position | null
  quote: EventQuote | null
  /** 打开「持仓/报价」录入工具（过期重新确认的入口） */
  onOpenTools: () => void
  loggedIn: boolean
}

const RISK_OPTIONS = [
  { value: '', label: '风险偏好未设置' },
  { value: 'conservative', label: '保守' },
  { value: 'balanced', label: '均衡' },
  { value: 'aggressive', label: '激进' },
]
const EXP_OPTIONS = [
  { value: '', label: '经验未设置' },
  { value: 'novice', label: '新手' },
  { value: 'intermediate', label: '有经验' },
  { value: 'pro', label: '专业' },
]

export function ContextCard({ symbol, horizon, product, position, quote, onOpenTools, loggedIn }: Props): JSX.Element {
  const [profile, setProfile] = useState<TraderProfile | null>(null)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!loggedIn) return
    let alive = true
    void api<{ profile: TraderProfile | null }>('/users/me/profile')
      .then((d) => { if (alive) setProfile(d.profile) })
      .catch(() => { /* 画像读取失败不阻塞 */ })
    return () => { alive = false }
  }, [loggedIn])

  const saveProfile = (patch: Partial<TraderProfile>): void => {
    if (profileBusy) return
    setProfileBusy(true)
    setProfileError('')
    void api<{ profile: TraderProfile }>('/users/me/profile', { method: 'PATCH', body: patch })
      .then((d) => setProfile(d.profile))
      .catch((e: Error) => setProfileError(e.message))
      .finally(() => setProfileBusy(false))
  }

  // 三态判定：持仓（perp 且已关联）/ 报价（event 且已关联）/ 裸 symbol+周期
  const stale = position?.isStale === true
  const quoteSoon = quote !== null && quote.expiryAt - Date.now() < 5 * 60_000
  return (
    <section className="context-card" aria-label="当前分析对象">
      <div className="context-main">
        <span className="context-obj">
          {position !== null
            ? `持仓：${position.symbol} ${position.side === 'long' ? '多' : '空'} · ${position.qty} @ ${position.entryPrice}（${position.leverage}x）`
            : quote !== null
              ? `报价：${quote.symbol} ${quote.direction === 'above' ? '高于' : '低于'} ${quote.strikePrice} · ${new Date(quote.expiryAt).toLocaleTimeString()} 到期`
              : `对象：${symbol} · ${horizon}${product === 'teaching' ? ' · 结构研究' : product === 'perp' ? ' · 永续' : product === 'event' ? ' · 事件' : ''}`}
        </span>
        {position !== null && (
          <span className={`ctx-badge ${stale ? 'ctx-stale' : 'ctx-fresh'}`} role="note">
            {stale ? '已过期，需重新确认' : '已确认，新鲜'}
          </span>
        )}
        {quote !== null && (
          <span className={`ctx-badge ${quoteSoon ? 'ctx-stale' : 'ctx-fresh'}`} role="note">
            {quoteSoon ? '临近到期' : '报价新鲜'}
          </span>
        )}
        {stale && (
          <button className="btn btn-ghost btn-sm" onClick={onOpenTools}>
            重新确认持仓
          </button>
        )}
        <button className="context-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起画像' : '研究画像'}
        </button>
      </div>
      {expanded && (
        <div className="context-profile">
          {profileError !== '' && <p className="err-text" role="alert">{profileError}</p>}
          <label>
            风险偏好
            <Dropdown ariaLabel="风险偏好" value={profile?.riskProfile ?? ''} disabled={profileBusy || !loggedIn} onChange={(v) => saveProfile({ riskProfile: v === '' ? null : (v as 'conservative' | 'balanced' | 'aggressive') })} options={RISK_OPTIONS} />
          </label>
          <label>
            交易经验
            <Dropdown ariaLabel="交易经验" value={profile?.experienceLevel ?? ''} disabled={profileBusy || !loggedIn} onChange={(v) => saveProfile({ experienceLevel: v === '' ? null : (v as 'novice' | 'intermediate' | 'pro') })} options={EXP_OPTIONS} />
          </label>
          <p className="context-profile-note">画像只影响解释详略与措辞（如新手附术语解释），不改变研究结论；历史杠杆习惯为描述性记录，不作为授权上限。</p>
        </div>
      )}
    </section>
  )
}
