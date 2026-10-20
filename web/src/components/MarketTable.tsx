import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import FullscreenButton from './FullscreenButton'
import { useFullscreen } from '../hooks/useFullscreen'
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

const COLUMNS: { key: SortKey; labelKey: string; className?: string }[] = [
  { key: 'symbol', labelKey: 'dashboard:table.col.symbol', className: 'col-sym' },
  { key: 'last', labelKey: 'dashboard:table.col.last' },
  { key: 'changePct', labelKey: 'dashboard:table.col.changePct' },
  { key: 'high', labelKey: 'dashboard:table.col.high' },
  { key: 'low', labelKey: 'dashboard:table.col.low' },
  { key: 'quoteVolume', labelKey: 'dashboard:table.col.quoteVolume' },
]

interface Props {
  selected?: string
  onSelect?: (symbol: string) => void
}

export default function MarketTable({ selected, onSelect }: Props): JSX.Element {
  const { tickers, order, status } = useMarket()
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'quoteVolume', dir: -1 })
  const fs = useFullscreen<HTMLElement>()

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
    <section className="panel market-panel" ref={fs.ref}>
      <div className="panel-head">
        <h2 className="panel-title">
          <i className="title-glyph" />
          {t('dashboard:table.title')}
          <span className="title-badge">{list.length}</span>
        </h2>
        <div className="panel-head-tools">
          <div className="table-search">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.5" y2="16.5" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('dashboard:table.searchPlaceholder')}
              spellCheck={false}
            />
          </div>
          <FullscreenButton on={fs.isFullscreen} onClick={fs.toggle} label={t('dashboard:table.fullscreen')} />
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
                  {t(c.labelKey)}
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
                  {status === 'connected' ? t('dashboard:table.emptyMatch') : t('dashboard:table.connecting')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel-foot muted">{t('dashboard:table.foot')}</div>
    </section>
  )
}
