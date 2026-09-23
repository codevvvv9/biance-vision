import { useEffect, useMemo, useRef, useState } from 'react'
import { useMarket } from '../market/MarketContext'
import { fmtPct, fmtPrice, fmtVol } from '../utils'
import type { Ticker } from '../types'

type SortKey = 'symbol' | 'last' | 'changePct' | 'high' | 'low' | 'quoteVolume'

interface SortState {
  key: SortKey
  dir: 1 | -1
}

function PriceCell({ value }: { value: number }): JSX.Element {
  const prev = useRef(value)
  const [flash, setFlash] = useState('')
  useEffect(() => {
    if (value > prev.current) setFlash('flash-up')
    else if (value < prev.current) setFlash('flash-down')
    prev.current = value
    const t = setTimeout(() => setFlash(''), 650)
    return () => clearTimeout(t)
  }, [value])
  return <span className={`mono price ${flash}`}>{fmtPrice(value)}</span>
}

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'symbol', label: '交易对', className: 'col-sym' },
  { key: 'last', label: '最新价' },
  { key: 'changePct', label: '24h涨跌幅' },
  { key: 'high', label: '24h最高' },
  { key: 'low', label: '24h最低' },
  { key: 'quoteVolume', label: '24h成交额' },
]

interface Props {
  selected?: string
  onSelect?: (symbol: string) => void
}

export default function MarketTable({ selected, onSelect }: Props): JSX.Element {
  const { tickers, order, status } = useMarket()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'quoteVolume', dir: -1 })

  const list = useMemo<Ticker[]>(() => {
    const q = query.trim().toUpperCase()
    let arr = order.map((s) => tickers[s]).filter((t): t is Ticker => Boolean(t))
    if (q) arr = arr.filter((t) => t.symbol.includes(q))
    return [...arr].sort((a, b) => {
      const va = a[sort.key]
      const vb = b[sort.key]
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb)) * sort.dir
      }
      return (va - vb) * sort.dir
    })
  }, [order, tickers, query, sort])

  const toggleSort = (key: SortKey): void => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'symbol' ? 1 : -1 }))
  }

  return (
    <section className="panel market-panel">
      <div className="panel-head">
        <h2 className="panel-title">
          <i className="title-glyph" />
          实时行情
          <span className="title-badge">{list.length}</span>
        </h2>
        <div className="table-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.5" y2="16.5" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索交易对，如 BTC"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={`${c.className ?? ''} ${sort.key === c.key ? 'sorted' : ''}`}
                  onClick={() => toggleSort(c.key)}
                >
                  {c.label}
                  {sort.key === c.key && <i className="sort-arrow">{sort.dir === 1 ? '▲' : '▼'}</i>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((t) => {
              const up = t.changePct >= 0
              return (
                <tr
                  key={t.symbol}
                  className={t.symbol === selected ? 'selected' : ''}
                  onClick={() => onSelect?.(t.symbol)}
                >
                  <td className="col-sym">
                    <b>{t.symbol.replace('USDT', '')}</b>
                    <em>/USDT</em>
                  </td>
                  <td><PriceCell value={t.last} /></td>
                  <td><span className={`chg ${up ? 'up' : 'down'}`}>{fmtPct(t.changePct)}</span></td>
                  <td className="mono dim">{fmtPrice(t.high)}</td>
                  <td className="mono dim">{fmtPrice(t.low)}</td>
                  <td className="mono dim">{fmtVol(t.quoteVolume)}</td>
                </tr>
              )
            })}
            {list.length === 0 && (
              <tr className="empty-row">
                <td colSpan={COLUMNS.length}>
                  {status === 'connected' ? '没有匹配的交易对' : '正在连接币安行情流…'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel-foot muted">点击行切换 K 线 · 数据每秒推送</div>
    </section>
  )
}
