import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMarket } from '../market/MarketContext'
import { fmtPct, fmtPrice, fmtVol, lsGet, lsSet } from '../utils'
import type { Ticker } from '../types'

export default function MoversPage(): JSX.Element {
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
    const set = new Set([...upList, ...downList].map((t) => t.symbol))
    const prev = prevSetRef.current
    if (prev) {
      const fresh = [...set].filter((s) => !prev.has(s)).slice(0, 3)
      for (const s of fresh) {
        const t = tickers[s]
        if (!t) continue
        pushToast({
          kind: 'alert',
          title: `${s} · 异动上榜`,
          body: `24h ${fmtPct(t.changePct)}，现价 ${fmtPrice(t.last)}，进入 ±${threshold}% 异动榜`,
        })
      }
    }
    prevSetRef.current = set
  }, [upList, downList, pushOn, threshold, tickers, pushToast])

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
            24h 异动榜
          </h2>
          <div className="mover-controls">
            <label className="mover-threshold">
              <span className="muted">涨跌幅阈值</span>
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
              {pushOn ? '🔔 新上榜推送：开' : '🔕 新上榜推送：关'}
            </button>
          </div>
        </div>

        <div className="mover-tabs">
          <button className={tab === 'up' ? 'on up' : ''} onClick={() => setTab('up')}>
            涨幅榜 <span className="tab-count">{upList.length}</span>
          </button>
          <button className={tab === 'down' ? 'on down' : ''} onClick={() => setTab('down')}>
            跌幅榜 <span className="tab-count">{downList.length}</span>
          </button>
          <span className="muted mover-hint">
            统计范围：成交额前 {order.length} 的 USDT 交易对 · 实时刷新
          </span>
        </div>

        <div className="table-wrap mover-table">
          <table className="table">
            <thead>
              <tr>
                <th className="col-rank">#</th>
                <th className="col-sym">交易对</th>
                <th>最新价</th>
                <th>24h涨跌幅</th>
                <th>24h成交额</th>
                <th>24h最高</th>
                <th>24h最低</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t, i) => {
                const up = t.changePct >= 0
                return (
                  <tr key={t.symbol} onClick={() => navigate(`/?symbol=${t.symbol}`)}>
                    <td className="col-rank mono">{i + 1}</td>
                    <td className="col-sym">
                      <b>{t.symbol.replace('USDT', '')}</b>
                      <em>/USDT</em>
                    </td>
                    <td className="mono">{fmtPrice(t.last)}</td>
                    <td>
                      <span className={`chg lg ${up ? 'up' : 'down'}`}>{fmtPct(t.changePct)}</span>
                    </td>
                    <td className="mono dim">{fmtVol(t.quoteVolume)}</td>
                    <td className="mono dim">{fmtPrice(t.high)}</td>
                    <td className="mono dim">{fmtPrice(t.low)}</td>
                  </tr>
                )
              })}
              {list.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={7}>当前没有 24h 涨跌幅超过 ±{threshold}% 的交易对，试试调低阈值</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
