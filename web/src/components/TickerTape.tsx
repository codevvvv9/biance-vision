import { useMarket } from '../market/MarketContext'
import { fmtPct, fmtPrice } from '../utils'

export default function TickerTape(): JSX.Element {
  const { tickers, order, status } = useMarket()
  const items = order.slice(0, 22)
  const doubled = [...items, ...items]

  return (
    <div className="tape" aria-label="实时行情滚动条">
      <span className="tape-label">
        <i className="conn-dot live" />
        LIVE
      </span>
      {items.length === 0 ? (
        <span className="tape-empty">
          {status === 'connected' ? '正在接收币安实时行情…' : '正在连接币安行情流…'}
        </span>
      ) : (
        <div className="tape-track">
          {doubled.map((s, i) => {
            const t = tickers[s]
            if (!t) return null
            const up = t.changePct >= 0
            return (
              <span className="tape-item" key={`${s}-${i}`}>
                <span className="ti-sym">{s.replace('USDT', '')}<em>/USDT</em></span>
                <span className="mono">{fmtPrice(t.last)}</span>
                <span className={`ti-chg ${up ? 'up' : 'down'}`}>{fmtPct(t.changePct)}</span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
