import { useEffect, useRef } from 'react'

import { dispose, init } from 'klinecharts'

/**
 * AI 聊天内的图表卡片：渲染服务端 render_chart 工具生成的 ```chart 数据块。
 * - kline：klinecharts 蜡烛图 + VOL 副图（深色内联样式，独立于 Dashboard 的注册样式）
 * - bar：纯 CSS 横向条形图（涨绿/跌红，跟随全局涨跌配色）
 */

export interface ChartSpec {
  type: 'kline' | 'bar'
  title: string
  times?: number[]
  ohlc?: number[][]
  volumes?: number[]
  labels?: string[]
  values?: number[]
  fmt?: 'pct' | 'price'
}

const KL_STYLES = {
  grid: {
    horizontal: { color: 'rgba(36, 48, 74, 0.5)' },
    vertical: { color: 'rgba(36, 48, 74, 0.35)' },
  },
  candle: {
    bar: {
      upColor: '#00d68f',
      downColor: '#ff4d6a',
      upBorderColor: '#00d68f',
      downBorderColor: '#ff4d6a',
      upWickColor: '#00d68f',
      downWickColor: '#ff4d6a',
      noChangeColor: '#5a6b8c',
    },
    priceMark: {
      high: { color: '#5a6b8c' },
      low: { color: '#5a6b8c' },
      last: { upColor: '#00d68f', downColor: '#ff4d6a' },
    },
    tooltip: {
      rect: { color: 'rgba(10, 16, 30, 0.92)', borderColor: '#24304a' },
      text: { color: '#8ea0c2' },
    },
  },
  indicator: {
    bars: [{ upColor: 'rgba(0,214,143,0.45)', downColor: 'rgba(255,77,106,0.45)', noChangeColor: '#3a4a6a' }],
    tooltip: { text: { color: '#8ea0c2' } },
  },
  xAxis: {
    axisLine: { color: '#24304a' },
    tickText: { color: '#5a6b8c' },
    tickLine: { color: '#24304a' },
  },
  yAxis: {
    axisLine: { color: '#24304a' },
    tickText: { color: '#5a6b8c' },
    tickLine: { color: '#24304a' },
  },
  separator: { color: '#1a2438' },
  crosshair: {
    horizontal: {
      line: { color: '#3d5a8a' },
      text: { borderColor: '#00e5ff', backgroundColor: '#16203a', color: '#e8eefc' },
    },
    vertical: {
      line: { color: '#3d5a8a' },
      text: { borderColor: '#00e5ff', backgroundColor: '#16203a', color: '#e8eefc' },
    },
  },
}

function KlineView({ spec }: { spec: ChartSpec }): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !spec.times?.length || !spec.ohlc) return
    const chart = init(el, { styles: KL_STYLES })
    if (!chart) return
    chart.applyNewData(
      spec.times.map((t, i) => ({
        timestamp: t * 1000,
        open: spec.ohlc![i][0],
        high: spec.ohlc![i][1],
        low: spec.ohlc![i][2],
        close: spec.ohlc![i][3],
        volume: spec.volumes?.[i] ?? 0,
      })),
    )
    chart.createIndicator('VOL', false, { id: 'pane_vol', height: 64 })
    return () => dispose(el)
  }, [spec])
  return <div ref={ref} className="ai-chart-kline" />
}

function BarView({ spec }: { spec: ChartSpec }): JSX.Element {
  const values = spec.values ?? []
  const labels = spec.labels ?? []
  const max = Math.max(...values.map((v) => Math.abs(v)), 0.0001)
  return (
    <div className="ai-chart-bars">
      {values.map((v, i) => (
        <div key={`${labels[i] ?? i}`} className="ai-chart-barrow">
          <span className="ai-chart-barlabel">{labels[i] ?? '?'}</span>
          <span className="ai-chart-bartrack">
            <span
              className={`ai-chart-barfill ${v >= 0 ? 'up' : 'down'}`}
              style={{ width: `${Math.max((Math.abs(v) / max) * 100, 2)}%` }}
            />
          </span>
          <span className={`ai-chart-barval ${v >= 0 ? 'up' : 'down'}`}>
            {spec.fmt === 'pct' ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : v.toLocaleString('en-US')}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function ChartCard({ spec }: { spec: ChartSpec }): JSX.Element {
  return (
    <div className="ai-chart-card">
      <p className="ai-chart-card-title">📈 {spec.title}</p>
      {spec.type === 'kline' ? <KlineView spec={spec} /> : <BarView spec={spec} />}
    </div>
  )
}
