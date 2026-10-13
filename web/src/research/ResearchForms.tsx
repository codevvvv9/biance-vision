/**
 * 研究工作台表单：永续持仓录入 / 事件报价录入。
 * 字段与 shared PositionInputSchema / EventQuoteInputSchema 一致；
 * 数值为十进制字符串（服务端 numeric 同源），confirmedAt/asOf 由提交时刻生成。
 */
import { useState } from 'react'
import { api } from '../api'
import type { EventQuote, Position } from 'biance-vision-brooks'

const input = (label: string, node: JSX.Element, hint?: string): JSX.Element => (
  <label className="field">
    <span className="field-label">{label}</span>
    {node}
    {hint && <em className="field-hint">{hint}</em>}
  </label>
)

export function PositionForm({ symbol, onSaved }: { symbol: string; onSaved: (p: Position) => void }): JSX.Element {
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
      <h4>录入持仓（App 抄录）</h4>
      <div className="form-grid">
        {input('方向', (
          <select value={side} onChange={(e) => setSide(e.target.value as 'long' | 'short')}>
            <option value="long">做多 long</option>
            <option value="short">做空 short</option>
          </select>
        ))}
        {input('数量', <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" placeholder="0.01" />)}
        {input('开仓价', <input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} inputMode="decimal" placeholder="60000" />)}
        {input('杠杆', <input type="number" min={1} max={125} value={leverage} onChange={(e) => setLeverage(Number(e.target.value))} />)}
        {input('保证金模式', (
          <select value={marginMode} onChange={(e) => setMarginMode(e.target.value as 'cross' | 'isolated')}>
            <option value="isolated">逐仓 isolated</option>
            <option value="cross">全仓 cross</option>
          </select>
        ))}
        {input('风险预算', <input value={riskBudget} onChange={(e) => setRiskBudget(e.target.value)} inputMode="decimal" placeholder="可承受损失金额" />)}
        {input('止损价', <input value={stopPrice} onChange={(e) => setStopPrice(e.target.value)} inputMode="decimal" placeholder="可留空" />)}
        {input('强平价', <input value={liquidationPrice} onChange={(e) => setLiquidationPrice(e.target.value)} inputMode="decimal" placeholder="从 App 抄录；未知留空" />, '未知留空：不显示简化估算')}
      </div>
      {error && <p className="err-text">{error}</p>}
      <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
        {busy ? '保存中…' : '保存持仓'}
      </button>
    </div>
  )
}

export function QuoteForm({ symbol, onSaved }: { symbol: string; onSaved: (q: EventQuote) => void }): JSX.Element {
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
      setError('已提交订单必须录入 App 显示的固定到期时刻（不能用「现在+期限」推算）')
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
      setError(expiryMode === 'exact' ? '请抄录 App 订单页显示的固定到期时刻' : '到期时间无效')
      setBusy(false)
      return
    }
    if (orderState === 'submitted' && expiryAt <= now) {
      setError('已提交订单的到期时间必须晚于当前时刻（订单应尚未结算）')
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
      <h4>录入事件报价（App 抄录）</h4>
      <div className="form-grid">
        {input('执行价', <input value={strikePrice} onChange={(e) => setStrikePrice(e.target.value)} inputMode="decimal" />)}
        {input('到期方式', (
          <select
            value={expiryMode}
            onChange={(e) => {
              const next = e.target.value as 'duration' | 'exact'
              // 已提交订单不允许切回「现在+期限」（App 到期时间已固定）
              if (orderState === 'submitted' && next === 'duration') return
              setExpiryMode(next)
            }}
            aria-disabled={orderState === 'submitted'}
          >
            <option value="duration" disabled={orderState === 'submitted'}>录入时刻 + 期限（预览）</option>
            <option value="exact">App 固定到期时刻（已提交订单必选）</option>
          </select>
        ), orderState === 'submitted' ? '已提交订单锁定为固定到期时刻，不能改回「现在+期限」' : undefined)}
        {expiryMode === 'duration'
          ? input('期限（分钟）', (
              <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                <option value={10}>10 分钟</option>
                <option value={30}>30 分钟</option>
                <option value={60}>1 小时</option>
                <option value={1440}>1 天</option>
                <option value={10080}>1 周（研究模式）</option>
              </select>
            ), '1 周为研究期限，非币安已有事件合约产品')
          : input('到期时刻', (
              <input
                type="datetime-local"
                value={expiryExact}
                onChange={(e) => setExpiryExact(e.target.value)}
                step={1}
                placeholder="抄录 App 订单页的到期时间"
              />
            ), orderState === 'submitted' ? '必填：抄录 App 订单页显示的到期时间（本地时区），不要自行推算' : '抄录 App 显示的到期时间（本地时区）')}
        {input('投入金额', <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" />)}
        {input('总返还（含本金）', <input value={totalPayout} onChange={(e) => setTotalPayout(e.target.value)} inputMode="decimal" />, '不是净收益')}
        {input('方向', (
          <select value={direction} onChange={(e) => setDirection(e.target.value as 'above' | 'below')}>
            <option value="above">到期高于执行价</option>
            <option value="below">到期低于执行价</option>
          </select>
        ))}
        {input('结算参考价', <input value={refPrice} onChange={(e) => setRefPrice(e.target.value)} inputMode="decimal" placeholder="App 展示值，可留空" />)}
        {input('订单状态', (
          <select value={orderState} onChange={(e) => onOrderStateChange(e.target.value as 'preview' | 'submitted')}>
            <option value="preview">参与前（预览价 60s 时效）</option>
            <option value="submitted">已提交（固定值，只研究剩余期限）</option>
          </select>
        ))}
        {input('事件风险预算', <input value={eventRiskBudget} onChange={(e) => setEventRiskBudget(e.target.value)} inputMode="decimal" placeholder="单笔可承受损失（参与门槛必填）" />, '未填写时参与建议会被门槛拒绝')}
      </div>
      {error && <p className="err-text">{error}</p>}
      <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
        {busy ? '保存中…' : '保存报价'}
      </button>
    </div>
  )
}
