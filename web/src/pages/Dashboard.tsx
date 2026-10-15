import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import KlineChart from '../components/KlineChart'
import MarketTable from '../components/MarketTable'
import StatCards from '../components/StatCards'
import CursorFx from '../components/fx/CursorFx'

export default function Dashboard(): JSX.Element {
  const [sp] = useSearchParams()
  const initSymbol = sp.get('symbol')
  const [symbol, setSymbol] = useState<string>(() =>
    initSymbol && /^[A-Z0-9]{4,20}$/.test(initSymbol) ? initSymbol : 'BTCUSDT',
  )
  const [interval, setIntervalState] = useState<string>('15m')

  return (
    <div className="page">
      <CursorFx />
      <StatCards />
      <div className="dash-grid">
        <KlineChart symbol={symbol} interval={interval} onIntervalChange={setIntervalState} />
        <MarketTable selected={symbol} onSelect={setSymbol} />
      </div>
    </div>
  )
}
