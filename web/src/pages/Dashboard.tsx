import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import KlineChart from '../components/KlineChart'
import MarketTable from '../components/MarketTable'
import StatCards from '../components/StatCards'
import { useMarket } from '../market/MarketContext'
import { fmtDateTime } from '../utils'

function RecentAlerts(): JSX.Element {
  const { alertsHistory } = useMarket()
  const recent = alertsHistory.filter((a) => !a.test).slice(0, 8)
  return (
    <section className="panel alerts-panel">
      <div className="panel-head">
        <h2 className="panel-title">
          <i className="title-glyph amber" />
          最近预警
        </h2>
        <Link className="link-more" to="/alerts">
          进入预警中心 →
        </Link>
      </div>
      <div className="recent-alerts">
        {recent.length === 0 && (
          <div className="empty-tip">
            暂无预警记录。去{' '}
            <Link to="/alerts" className="link-more">
              预警中心
            </Link>{' '}
            添加「价格突破 / 涨跌幅超过」规则，触发后会在这里和右下角弹窗提示。
          </div>
        )}
        {recent.map((a) => (
          <div className="ra-item" key={a.id}>
            <i className={`ra-dot ${a.changePct >= 0 ? 'up' : 'down'}`} />
            <div className="ra-main">
              <div className="ra-msg">{a.message}</div>
              <div className="ra-time muted">{fmtDateTime(a.triggeredAt)}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function Dashboard(): JSX.Element {
  const [sp] = useSearchParams()
  const initSymbol = sp.get('symbol')
  const [symbol, setSymbol] = useState<string>(() =>
    initSymbol && /^[A-Z0-9]{4,20}$/.test(initSymbol) ? initSymbol : 'BTCUSDT',
  )
  const [interval, setIntervalState] = useState<string>('15m')

  return (
    <div className="page">
      <StatCards />
      <div className="dash-grid">
        <KlineChart symbol={symbol} interval={interval} onIntervalChange={setIntervalState} />
        <MarketTable selected={symbol} onSelect={setSymbol} />
      </div>
      <RecentAlerts />
    </div>
  )
}
