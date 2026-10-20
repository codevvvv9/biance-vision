import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useMarket } from '../market/MarketContext'
import { fmtPct, fmtPrice, fmtVol } from '../utils'
import { useSpotlight } from './fx/useSpotlight'

function CoinCard({ symbol }: { symbol: string }): JSX.Element {
  const { tickers } = useMarket()
  const { t: tr } = useTranslation()
  const t = tickers[symbol]
  const up = (t?.changePct ?? 0) >= 0
  return (
    <div className="stat-card fx-spot">
      <div className="stat-label">
        <i className="sym-dot" />
        {symbol.replace('USDT', '')} <em>/ USDT</em>
      </div>
      <div className="stat-value mono">{t ? fmtPrice(t.last) : '--'}</div>
      <div className="stat-sub">
        <span className={`chg ${up ? 'up' : 'down'}`}>{t ? fmtPct(t.changePct) : '--'}</span>
        <span className="stat-range">
          {tr('dashboard:stat.high')} {t ? fmtPrice(t.high) : '--'} · {tr('dashboard:stat.low')} {t ? fmtPrice(t.low) : '--'}
        </span>
      </div>
    </div>
  )
}

export default function StatCards(): JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null)
  useSpotlight(gridRef)
  const { t } = useTranslation()
  const { stats, order } = useMarket()
  const up = stats?.up ?? 0
  const down = stats?.down ?? 0
  const total = up + down
  const upPct = total ? Math.round((up / total) * 100) : 50

  return (
    <div className="stat-grid" ref={gridRef}>
      <CoinCard symbol="BTCUSDT" />
      <CoinCard symbol="ETHUSDT" />

      <div className="stat-card fx-spot">
        <div className="stat-label">
          <i className="sym-dot teal" />
          {t('dashboard:stat.sentiment')} <em>{t('dashboard:stat.sentimentSub')}</em>
        </div>
        <div className="stat-value sentiment">
          <span className="up mono">{up}</span>
          <span className="sent-sep">/</span>
          <span className="down mono">{down}</span>
        </div>
        <div className="market-bar" title={t('dashboard:stat.marketBarTitle', { up, down })}>
          <span className="bar-up" style={{ width: `${upPct}%` }} />
          <span className="bar-down" style={{ width: `${100 - upPct}%` }} />
        </div>
        <div className="stat-sub">
          <span className="muted">{t('dashboard:stat.upPct', { pct: upPct })}</span>
        </div>
      </div>

      <div className="stat-card fx-spot">
        <div className="stat-label">
          <i className="sym-dot purple" />
          {t('dashboard:stat.totalVolume')} <em>USDT</em>
        </div>
        <div className="stat-value mono">{stats ? `$${fmtVol(stats.totalQuoteVolume)}` : '--'}</div>
        <div className="stat-sub">
          <span className="muted">
            {t('dashboard:stat.monitoring', { count: order.length })}
          </span>
        </div>
      </div>
    </div>
  )
}
