/**
 * 上下文卡（P1-4，vertical-agent-architecture.md §4.D Context Card）：
 * 常驻研究台，显示「当前分析对象」三态——持仓 / 报价 / 裸 symbol+周期——
 * 与有效期徽章（新鲜 / 过期需确认）；切换/清除仍走既有 context PATCH（不改语义）。
 * 内联长期画像快捷编辑（trader_profiles：风险偏好/经验；leverageHabitMax 为
 * 描述性字段「历史习惯」，不作授权上限——文案明示）。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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

export function ContextCard({ symbol, horizon, product, position, quote, onOpenTools, loggedIn }: Props): JSX.Element {
  const { t } = useTranslation()
  const [profile, setProfile] = useState<TraderProfile | null>(null)
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [expanded, setExpanded] = useState(false)
  const riskOptions = [
    { value: '', label: t('research:ctx.riskUnset') },
    { value: 'conservative', label: t('research:ctx.riskConservative') },
    { value: 'balanced', label: t('research:ctx.riskBalanced') },
    { value: 'aggressive', label: t('research:ctx.riskAggressive') },
  ]
  const expOptions = [
    { value: '', label: t('research:ctx.expUnset') },
    { value: 'novice', label: t('research:ctx.expNovice') },
    { value: 'intermediate', label: t('research:ctx.expIntermediate') },
    { value: 'pro', label: t('research:ctx.expPro') },
  ]

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
    <section className="context-card" aria-label={t('research:ctx.aria')}>
      <div className="context-main">
        <span className="context-obj">
          {position !== null
            ? t('research:ctx.positionLine', {
                symbol: position.symbol,
                side: t(position.side === 'long' ? 'research:ctx.long' : 'research:ctx.short'),
                qty: position.qty,
                price: position.entryPrice,
                leverage: position.leverage,
              })
            : quote !== null
              ? t('research:ctx.quoteLine', {
                  symbol: quote.symbol,
                  direction: t(quote.direction === 'above' ? 'research:main.above' : 'research:main.below'),
                  strike: quote.strikePrice,
                  time: new Date(quote.expiryAt).toLocaleTimeString(),
                })
              : t('research:ctx.objectLine', {
                  symbol,
                  horizon,
                  suffix: product === 'teaching' ? t('research:ctx.suffixTeaching') : product === 'perp' ? t('research:ctx.suffixPerp') : product === 'event' ? t('research:ctx.suffixEvent') : '',
                })}
        </span>
        {position !== null && (
          <span className={`ctx-badge ${stale ? 'ctx-stale' : 'ctx-fresh'}`} role="note">
            {stale ? t('research:ctx.staleReconfirm') : t('research:ctx.fresh')}
          </span>
        )}
        {quote !== null && (
          <span className={`ctx-badge ${quoteSoon ? 'ctx-stale' : 'ctx-fresh'}`} role="note">
            {quoteSoon ? t('research:ctx.expiringSoon') : t('research:ctx.quoteFresh')}
          </span>
        )}
        {stale && (
          <button className="btn btn-ghost btn-sm" onClick={onOpenTools}>
            {t('research:ctx.reconfirm')}
          </button>
        )}
        <button className="context-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? t('research:ctx.collapse') : t('research:ctx.expand')}
        </button>
      </div>
      {expanded && (
        <div className="context-profile">
          {profileError !== '' && <p className="err-text" role="alert">{profileError}</p>}
          <label>
            {t('research:ctx.riskProfile')}
            <Dropdown ariaLabel={t('research:ctx.riskProfile')} value={profile?.riskProfile ?? ''} disabled={profileBusy || !loggedIn} onChange={(v) => saveProfile({ riskProfile: v === '' ? null : (v as 'conservative' | 'balanced' | 'aggressive') })} options={riskOptions} />
          </label>
          <label>
            {t('research:ctx.experience')}
            <Dropdown ariaLabel={t('research:ctx.experience')} value={profile?.experienceLevel ?? ''} disabled={profileBusy || !loggedIn} onChange={(v) => saveProfile({ experienceLevel: v === '' ? null : (v as 'novice' | 'intermediate' | 'pro') })} options={expOptions} />
          </label>
          <p className="context-profile-note">{t('research:ctx.profileNote')}</p>
        </div>
      )}
    </section>
  )
}
