/**
 * 研究工作台表单：永续持仓录入 / 事件报价录入。
 * 字段与 shared PositionInputSchema / EventQuoteInputSchema 一致；
 * 数值为十进制字符串（服务端 numeric 同源），confirmedAt/asOf 由提交时刻生成。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import type { EventQuote, Position } from 'biance-vision-brooks'
import { Dropdown } from './Dropdown'

const input = (label: string, node: JSX.Element, hint?: string): JSX.Element => (
  <label className="field">
    <span className="field-label">{label}</span>
    {node}
    {hint && <em className="field-hint">{hint}</em>}
  </label>
)

export function PositionForm({ symbol, onSaved }: { symbol: string; onSaved: (p: Position) => void }): JSX.Element {
  const { t } = useTranslation()
  const [side, setSide] = useState<'long' | 'short'>('long')
  const [qty, setQty] = useState('0.01')
  const [entryPrice, setEntryPrice] = useState('')
  const [leverage, setLeverage] = useState(10)
  const [marginMode, setMarginMode] = useState<'cross' | 'isolated'>('isolated')
  const [riskBudget, setRiskBudget] = useState('')
  const [stopPrice, setStopPrice] = useState('')
  const [liquidationPrice, setLiquidationPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const r = await api<{ position: Position }>('/portfolio', {
        method: 'POST',
        body: {
          symbol,
          side,
          qty,
          entryPrice,
          leverage,
          marginMode,
          riskBudget,
          stopPrice: stopPrice === '' ? undefined : stopPrice,
          liquidationPrice: liquidationPrice === '' ? null : liquidationPrice,
          confirmedAt: Date.now(),
        },
      })
      onSaved(r.position)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="research-form">
      <h4>{t('research:form.positionTitle')}</h4>
      <div className="form-grid">
        {input(t('research:form.side'), (
          <Dropdown value={side} onChange={(v) => setSide(v)} options={[{ value: 'long', label: t('research:form.long') }, { value: 'short', label: t('research:form.short') }]} />
        ))}
        {input(t('research:form.qty'), <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" placeholder="0.01" />)}
        {input(t('research:form.entryPrice'), <input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} inputMode="decimal" placeholder="60000" />)}
        {input(t('research:form.leverage'), <input type="number" min={1} max={125} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />)}
        {input(t('research:form.marginMode'), (
          <Dropdown value={marginMode} onChange={(v) => setMarginMode(v)} options={[{ value: 'isolated', label: t('research:form.isolated') }, { value: 'cross', label: t('research:form.cross') }]} />
        ))}
        {input(t('research:form.riskBudget'), <input value={riskBudget} onChange={(e) => setRiskBudget(e.target.value)} inputMode="decimal" placeholder={t('research:form.riskBudgetPlaceholder')} />)}
        {input(t('research:form.stopPrice'), <input value={stopPrice} onChange={(e) => setStopPrice(e.target.value)} inputMode="decimal" placeholder={t('research:form.stopPlaceholder')} />)}
        {input(t('research:form.liqPrice'), <input value={liquidationPrice} onChange={(e) => setLiquidationPrice(e.target.value)} inputMode="decimal" placeholder={t('research:form.liqPlaceholder')} />, t('research:form.liqNote'))}
      </div>
      {error && <p className="err-text">{error}</p>}
      <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
        {busy ? t('research:form.saving') : t('research:form.savePosition')}
      </button>
    </div>
  )
}

export function QuoteForm({ symbol, onSaved }: { symbol: string; onSaved: (q: EventQuote) => void }): JSX.Element {
  const { t } = useTranslation()
  const [strikePrice, setStrikePrice] = useState('')
  const [minutes, setMinutes] = useState(10)
  const [stake, setStake] = useState('')
  const [totalPayout, setTotalPayout] = useState('')
  const [direction, setDirection] = useState<'above' | 'below'>('above')
  const [refPrice, setRefPrice] = useState('')
  const [orderState, setOrderState] = useState<'preview' | 'submitted'>('preview')
  const [eventRiskBudget, setEventRiskBudget] = useState('')
  // 到期时间来源：duration=录入时刻+期限（预览）；exact=直接录入 App 显示的固定到期时刻（已提交订单）
  const [expiryMode, setExpiryMode] = useState<'duration' | 'exact'>('duration')
  const [expiryExact, setExpiryExact] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const onOrderStateChange = (next: 'preview' | 'submitted'): void => {
    setOrderState(next)
    // 已提交订单的到期时间在 App 内已固定：到期方式锁死为「App 固定到期时刻」，
    // 不预填（等待用户抄录 App 实际值，预填值会被误当成 App 数据）；
    // 否则「9 分钟前买的 10 分钟单」会再得 10 分钟剩余，污染监控与期限桶匹配
    if (next === 'submitted') {
      setExpiryMode('exact')
      setExpiryExact('')
    }
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError('')
    const now = Date.now()
    if (orderState === 'submitted' && expiryMode !== 'exact') {
      setError(t('research:form.errSubmittedNeedsExact'))
      setBusy(false)
      return
    }
    const expiryAt =
      expiryMode === 'exact'
        ? expiryExact === ''
          ? NaN
          : new Date(expiryExact).getTime()
        : now + minutes * 60_000
    if (!Number.isFinite(expiryAt)) {
      setError(expiryMode === 'exact' ? t('research:form.errExactRequired') : t('research:form.errInvalidExpiry'))
      setBusy(false)
      return
    }
    if (orderState === 'submitted' && expiryAt <= now) {
      setError(t('research:form.errExpiryInPast'))
      setBusy(false)
      return
    }
    try {
      const r = await api<{ quote: EventQuote }>('/event-quotes', {
        method: 'POST',
        body: {
          symbol,
          strikePrice,
          expiryAt,
          asOf: now,
          stake,
          totalPayout,
          direction,
          refPrice: refPrice === '' ? null : refPrice,
          orderState,
          strikeStatus: orderState === 'submitted' ? 'locked' : 'preview',
          eventRiskBudget: eventRiskBudget === '' ? undefined : eventRiskBudget,
          // 服务端契约必填：duration=录入时刻+期限（默认）；exact=App 固定到期时刻（已提交订单强制）
          expiryKind: expiryMode,
        },
      })
      onSaved(r.quote)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="research-form">
      <h4>{t('research:form.quoteTitle')}</h4>
      <div className="form-grid">
        {input(t('research:form.strike'), <input value={strikePrice} onChange={(e) => setStrikePrice(e.target.value)} inputMode="decimal" />)}
        {input(t('research:form.expiryMode'), (
          <Dropdown
            value={expiryMode}
            onChange={(v) => {
              // 已提交订单不允许切回「现在+期限」（App 到期时间已固定）
              if (orderState === 'submitted' && v === 'duration') return
              setExpiryMode(v)
            }}
            options={[
              { value: 'duration', label: t('research:form.expiryDuration'), disabled: orderState === 'submitted' },
              { value: 'exact', label: t('research:form.expiryExact') },
            ]}
          />
        ), orderState === 'submitted' ? t('research:form.expiryModeNote') : undefined)}
        {expiryMode === 'duration'
          ? input(t('research:form.horizonMinutes'), (
              <Dropdown value={minutes} onChange={(v) => setMinutes(v)} options={[
                { value: 10, label: t('research:form.h10m') },
                { value: 30, label: t('research:form.h30m') },
                { value: 60, label: t('research:form.h1h') },
                { value: 1440, label: t('research:form.h1d') },
                { value: 10080, label: t('research:form.h1w') },
              ]} />
            ), t('research:form.weekNote'))
          : input(t('research:form.expiryTime'), (
              <input
                type="datetime-local"
                value={expiryExact}
                onChange={(e) => setExpiryExact(e.target.value)}
                step={1}
                placeholder={t('research:form.expiryPlaceholder')}
              />
            ), orderState === 'submitted' ? t('research:form.expiryNoteSubmitted') : t('research:form.expiryNotePreview'))}
        {input(t('research:form.stake'), <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" />)}
        {input(t('research:form.totalPayout'), <input value={totalPayout} onChange={(e) => setTotalPayout(e.target.value)} inputMode="decimal" />, t('research:form.totalPayoutNote'))}
        {input(t('research:form.direction'), (
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'above' | 'below')}>
            <option value="above">{t('research:form.above')}</option>
            <option value="below">{t('research:form.below')}</option>
          </select>
        ))}
        {input(t('research:form.refPrice'), <input value={refPrice} onChange={(e) => setRefPrice(e.target.value)} inputMode="decimal" placeholder={t('research:form.refPricePlaceholder')} />)}
        {input(t('research:form.orderState'), (
          <select value={orderState} onChange={(e) => onOrderStateChange(e.target.value as 'preview' | 'submitted')}>
            <option value="preview">{t('research:form.orderPreview')}</option>
            <option value="submitted">{t('research:form.orderSubmitted')}</option>
          </select>
        ))}
        {input(t('research:form.eventRiskBudget'), <input value={eventRiskBudget} onChange={(e) => setEventRiskBudget(e.target.value)} inputMode="decimal" placeholder={t('research:form.eventRiskPlaceholder')} />, t('research:form.eventRiskNote'))}
      </div>
      {error && <p className="err-text">{error}</p>}
      <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
        {busy ? t('research:form.saving') : t('research:form.saveQuote')}
      </button>
    </div>
  )
}
