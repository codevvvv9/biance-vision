import { useMarket } from '../market/MarketContext'
import { fmtPct, fmtPrice, fmtVol } from '../utils'

function CoinCard({ symbol }: { symbol: string }): JSX.Element {
  const { tickers } = useMarket()
  const t = tickers[symbol]
  const up = (t?.changePct ?? 0) >= 0
  return (
    <div className="stat-card">
      <div className="stat-label">
        <i className="sym-dot" />
        {symbol.replace('USDT', '')} <em>/ USDT</em>
      </div>
      <div className="stat-value mono">{t ? fmtPrice(t.last) : '--'}</div>
      <div className="stat-sub">
        <span className={`chg ${up ? 'up' : 'down'}`}>{t ? fmtPct(t.changePct) : '--'}</span>
        <span className="stat-range">
          高 {t ? fmtPrice(t.high) : '--'} · 低 {t ? fmtPrice(t.low) : '--'}
        </span>
      </div>
    </div>
  )
}

export default function StatCards(): JSX.Element {
  const { stats, order, alertsHistory } = useMarket()
  const todayCount = alertsHistory.filter((a) => Date.now() - a.triggeredAt < 86400e3).length
  const up = stats?.up ?? 0
  const down = stats?.down ?? 0
  const total = up + down
  const upPct = total ? Math.round((up / total) * 100) : 50

  return (
    <div className="stat-grid">
      <CoinCard symbol="BTCUSDT" />
      <CoinCard symbol="ETHUSDT" />

      <div className="stat-card">
        <div className="stat-label">
          <i className="sym-dot teal" />
          市场情绪 <em>USDT 交易对</em>
        </div>
        <div className="stat-value sentiment">
          <span className="up mono">{up}</span>
          <span className="sent-sep">/</span>
          <span className="down mono">{down}</span>
        </div>
        <div className="market-bar" title={`上涨 ${up} 家 · 下跌 ${down} 家`}>
          <span className="bar-up" style={{ width: `${upPct}%` }} />
          <span className="bar-down" style={{ width: `${100 - upPct}%` }} />
        </div>
        <div className="stat-sub">
          <span className="muted">{upPct}% 上涨</span>
        </div>
      </div>

      <div className="stat-card">
        <div className="stat-label">
          <i className="sym-dot purple" />
          24h 总成交额 <em>USDT</em>
        </div>
        <div className="stat-value mono">{stats ? `$${fmtVol(stats.totalQuoteVolume)}` : '--'}</div>
        <div className="stat-sub">
          <span className="muted">
            监控 {order.length} 交易对 · 今日触发预警 {todayCount} 次
          </span>
        </div>
      </div>
    </div>
  )
}
