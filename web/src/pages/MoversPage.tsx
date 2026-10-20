import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMarket } from '../market/MarketContext'
import { fmtPct, fmtPrice, fmtVol, lsGet, lsSet } from '../utils'
import type { Ticker } from '../types'

export default function MoversPage(): JSX.Element {
  const { t } = useTranslation()
  const { tickers, order, pushToast } = useMarket()
  const navigate = useNavigate()

  const [threshold, setThreshold] = useState<number>(() => lsGet<number>('bv.threshold', 5))
  const [tab, setTab] = useState<'up' | 'down'>('up')
  const [pushOn, setPushOn] = useState<boolean>(() => lsGet<boolean>('bv.moverPush', true))
  const prevSetRef = useRef<Set<string> | null>(null)

  const all = useMemo<Ticker[]>(
    () => order.map((s) => tickers[s]).filter((t): t is Ticker => Boolean(t)),
    [order, tickers],
  )
  const upList = useMemo<Ticker[]>(
    () => all.filter((t) => t.changePct >= threshold).sort((a, b) => b.changePct - a.changePct),
    [all, threshold],
  )
  const downList = useMemo<Ticker[]>(
    () => all.filter((t) => t.changePct <= -threshold).sort((a, b) => a.changePct - b.changePct),
    [all, threshold],
  )

  // 新登上异动榜的交易对 → 弹窗提示（边缘触发：落榜后再次上榜才会再提示）
  useEffect(() => {
    if (!pushOn) {
      prevSetRef.current = null
      return
    }
    const set = new Set([...upList, ...downList].map((tk) => tk.symbol))
    const prev = prevSetRef.current
    if (prev) {
      const fresh = [...set].filter((s) => !prev.has(s)).slice(0, 3)
      for (const s of fresh) {
        const tk = tickers[s]
        if (!tk) continue
        pushToast({
          kind: 'alert',
          title: t('movers:toast.listed', { symbol: s }),
          body: t('movers:toast.body', { pct: fmtPct(tk.changePct), price: fmtPrice(tk.last), threshold }),
        })
      }
    }
    prevSetRef.current = set
  }, [upList, downList, pushOn, threshold, tickers, pushToast, t])

  const updateThreshold = (v: string | number): void => {
    const n = Math.min(Math.max(Number(v) || 0.5, 0.5), 30)
    setThreshold(n)
    lsSet('bv.threshold', n)
    prevSetRef.current = null // 阈值变化后重新初始化，避免批量误报
  }

  const togglePush = (): void => {
    setPushOn((v) => {
      lsSet('bv.moverPush', !v)
      return !v
    })
  }

  const list = tab === 'up' ? upList : downList

  return (
    <div className="page">
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            <i className="title-glyph purple" />
            {t('movers:title')}
          </h2>
          <div className="mover-controls">
            <label className="mover-threshold">
              <span className="muted">{t('movers:thresholdLabel')}</span>
              <input
                type="range"
                min="0.5"
                max="20"
                step="0.5"
                value={threshold}
                onChange={(e) => updateThreshold(e.target.value)}
              />
              <input
                className="threshold-num mono"
                type="number"
                min="0.5"
                max="30"
                step="0.5"
                value={threshold}
                onChange={(e) => updateThreshold(e.target.value)}
              />
              <span className="muted">%</span>
            </label>
            <button className={`btn btn-sm ${pushOn ? 'btn-primary' : 'btn-ghost'}`} onClick={togglePush}>
              {pushOn ? t('movers:pushOn') : t('movers:pushOff')}
            </button>
          </div>
        </div>

        <div className="mover-tabs">
          <button className={tab === 'up' ? 'on up' : ''} onClick={() => setTab('up')}>
            {t('movers:tabs.up')} <span className="tab-count">{upList.length}</span>
          </button>
          <button className={tab === 'down' ? 'on down' : ''} onClick={() => setTab('down')}>
            {t('movers:tabs.down')} <span className="tab-count">{downList.length}</span>
          </button>
          <span className="muted mover-hint">
            {t('movers:hint', { count: order.length })}
          </span>
        </div>

        <div className="table-wrap mover-table">
          <table className="table">
            <thead>
              <tr>
                <th className="col-rank">#</th>
                <th className="col-sym">{t('movers:col.symbol')}</th>
                <th>{t('movers:col.last')}</th>
                <th>{t('movers:col.changePct')}</th>
                <th>{t('movers:col.quoteVolume')}</th>
                <th>{t('movers:col.high')}</th>
                <th>{t('movers:col.low')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((tk, i) => {
                const up = tk.changePct >= 0
                return (
                  <tr key={tk.symbol} onClick={() => navigate(`/?symbol=${tk.symbol}`)}>
                    <td className="col-rank mono">{i + 1}</td>
                    <td className="col-sym">
                      <b>{tk.symbol.replace('USDT', '')}</b>
                      <em>/USDT</em>
                    </td>
                    <td className="mono">{fmtPrice(tk.last)}</td>
                    <td>
                      <span className={`chg lg ${up ? 'up' : 'down'}`}>{fmtPct(tk.changePct)}</span>
                    </td>
                    <td className="mono dim">{fmtVol(tk.quoteVolume)}</td>
                    <td className="mono dim">{fmtPrice(tk.high)}</td>
                    <td className="mono dim">{fmtPrice(tk.low)}</td>
                  </tr>
                )
              })}
              {list.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={7}>{t('movers:empty', { threshold })}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
