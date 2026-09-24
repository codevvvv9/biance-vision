import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Chart } from 'klinecharts'
import { dispose, init, registerStyles } from 'klinecharts'
import FullscreenButton from './FullscreenButton'
import { api } from '../api'
import { useFullscreen } from '../hooks/useFullscreen'
import { useMarket } from '../market/MarketContext'
import { fmtPct, fmtPrice, precisionFor } from '../utils'
import type { KlineBar } from '../types'

interface IntervalOption {
  v: string
  t: string
}

const INTERVALS: IntervalOption[] = [
  { v: '1m', t: '1分' },
  { v: '5m', t: '5分' },
  { v: '15m', t: '15分' },
  { v: '1h', t: '1时' },
  { v: '4h', t: '4时' },
  { v: '1d', t: '日线' },
]

let stylesRegistered = false
function ensureStyles(): void {
  if (stylesRegistered) return
  stylesRegistered = true
  registerStyles('bv-dark', {
    grid: {
      horizontal: { color: 'rgba(36, 48, 74, 0.55)' },
      vertical: { color: 'rgba(36, 48, 74, 0.4)' },
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
      bars: [{ upColor: '#00d68f', downColor: '#ff4d6a', noChangeColor: '#3a4a6a' }],
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
  })
}

interface Props {
  symbol: string
  interval: string
  onIntervalChange?: (v: string) => void
}

export default function KlineChart({ symbol, interval, onIntervalChange }: Props): JSX.Element {
  const { tickers, subscribeKline } = useMarket()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<Chart | null>(null)
  const lastBarRef = useRef(0)
  const fs = useFullscreen<HTMLElement>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    ensureStyles()
    const el = boxRef.current
    if (!el) return undefined
    const chart = init(el, { locale: 'zh-CN', styles: 'bv-dark' })
    chartRef.current = chart
    if (chart) {
      chart.createIndicator('MA', false, { id: 'candle_pane' })
      chart.createIndicator('VOL')
    }
    const ro = new ResizeObserver(() => chart?.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      try {
        dispose(el)
      } catch {
        /* noop */
      }
      chartRef.current = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const chart = chartRef.current
    if (!chart) return undefined
    setLoading(true)
    setError('')

    void api<{ klines: KlineBar[] }>(`/klines?symbol=${symbol}&interval=${interval}&limit=300`)
      .then((d) => {
        if (cancelled || !chartRef.current) return
        // klinecharts 9.8 的 KLineData 字段为 timestamp（毫秒）
        const data = d.klines.map((k) => ({
          timestamp: k.time,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
        }))
        lastBarRef.current = data.length ? data[data.length - 1].timestamp : 0
        chartRef.current.applyNewData(data)
        const lastClose = data.length ? data[data.length - 1].close : 0
        chartRef.current.setPriceVolumePrecision(precisionFor(lastClose), 2)
        setLoading(false)
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message || 'K 线加载失败')
          setLoading(false)
        }
      })

    const off = subscribeKline(symbol, interval, (k: KlineBar) => {
      const c = chartRef.current
      if (!c || k.time < lastBarRef.current) return
      lastBarRef.current = k.time
      c.updateData({
        timestamp: k.time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
      })
    })

    return () => {
      cancelled = true
      off()
    }
  }, [symbol, interval, subscribeKline, reload])

  const t = tickers[symbol]
  const up = (t?.changePct ?? 0) >= 0

  return (
    <section className="panel chart-panel" ref={fs.ref}>
      <div className="panel-head">
        <div className="chart-title">
          <h2>
            {symbol.replace('USDT', '')}
            <em className="pair-quote">/USDT</em>
          </h2>
          {t && (
            <>
              <span className="mono price-lg">{fmtPrice(t.last)}</span>
              <span className={`chg ${up ? 'up' : 'down'}`}>{fmtPct(t.changePct)}</span>
            </>
          )}
          <Link className="btn btn-ghost btn-sm" to={`/alerts?symbol=${symbol}`} title="为该交易对配置预警">
            ⚡ 设预警
          </Link>
        </div>
        <div className="panel-head-tools">
          <div className="interval-group" role="tablist">
            {INTERVALS.map((iv) => (
              <button
                key={iv.v}
                className={iv.v === interval ? 'on' : ''}
                onClick={() => onIntervalChange?.(iv.v)}
              >
                {iv.t}
              </button>
            ))}
          </div>
          <FullscreenButton on={fs.isFullscreen} onClick={fs.toggle} label="全屏显示 K 线" />
        </div>
      </div>
      <div className="chart-box" ref={boxRef}>
        {loading && <div className="chart-mask">加载 {symbol} K 线…</div>}
        {error && (
          <div className="chart-mask error">
            <span>{error}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setReload((n) => n + 1)}>
              重试
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
