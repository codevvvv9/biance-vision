import { useEffect, useRef, useState } from 'react'
import type { Chart, DeepPartial, Styles } from 'klinecharts'
import { dispose, init, registerStyles } from 'klinecharts'
import { useTranslation } from 'react-i18next'
import FullscreenButton from './FullscreenButton'
import { api } from '../api'
import { useFullscreen } from '../hooks/useFullscreen'
import { useMarket } from '../market/MarketContext'
import { fmtPct, fmtPrice, precisionFor } from '../utils'
import { klinechartsLocale, default as i18n } from '../i18n'
import type { UpColorMode } from '../utils'
import type { KlineBar } from '../types'

interface IntervalOption {
  v: string
  t: string
}

const INTERVALS: IntervalOption[] = [
  { v: '1m', t: 'dashboard:kline.intervals.1m' },
  { v: '5m', t: 'dashboard:kline.intervals.5m' },
  { v: '15m', t: 'dashboard:kline.intervals.15m' },
  { v: '1h', t: 'dashboard:kline.intervals.1h' },
  { v: '4h', t: 'dashboard:kline.intervals.4h' },
  { v: '1d', t: 'dashboard:kline.intervals.1d' },
]

let stylesRegistered = false
export function ensureStyles(): void {
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

/** 涨跌配色覆写：跟随用户配色习惯（绿涨红跌 / 红涨绿跌）同步蜡烛、最新价线、成交量柱 */
export function upDownOverrides(mode: UpColorMode): DeepPartial<Styles> {
  const up = mode === 'red' ? '#ff4d6a' : '#00d68f'
  const down = mode === 'red' ? '#00d68f' : '#ff4d6a'
  return {
    candle: {
      bar: {
        upColor: up,
        downColor: down,
        upBorderColor: up,
        downBorderColor: down,
        upWickColor: up,
        downWickColor: down,
      },
      priceMark: { last: { upColor: up, downColor: down } },
    },
    indicator: { bars: [{ upColor: up, downColor: down }] },
  }
}

interface Props {
  symbol: string
  interval: string
  onIntervalChange?: (v: string) => void
}

export default function KlineChart({ symbol, interval, onIntervalChange }: Props): JSX.Element {
  const { tickers, subscribeKline, upColor } = useMarket()
  const { t, i18n } = useTranslation()
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
    const chart = init(el, { locale: klinechartsLocale(), styles: 'bv-dark' })
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

  // 配色习惯切换时，同步重绘 K 线蜡烛/成交量颜色
  useEffect(() => {
    chartRef.current?.setStyles(upDownOverrides(upColor))
  }, [upColor])

  // UI 语言切换时同步图表内置文案（klinecharts 支持 setLocale 热切换）
  useEffect(() => {
    chartRef.current?.setLocale(klinechartsLocale())
  }, [i18n.language])

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
          setError(e.message || i18n.t('dashboard:kline.loadFailed'))
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

  const ticker = tickers[symbol]
  const up = (ticker?.changePct ?? 0) >= 0

  return (
    <section className="panel chart-panel" ref={fs.ref}>
      <div className="panel-head">
        <div className="chart-title">
          <h2>
            {symbol.replace('USDT', '')}
            <em className="pair-quote">/USDT</em>
          </h2>
          {ticker && (
            <>
              <span className="mono price-lg">{fmtPrice(ticker.last)}</span>
              <span className={`chg ${up ? 'up' : 'down'}`}>{fmtPct(ticker.changePct)}</span>
            </>
          )}
        </div>
        <div className="panel-head-tools">
          <div className="interval-group" role="tablist">
            {INTERVALS.map((iv) => (
              <button
                key={iv.v}
                className={iv.v === interval ? 'on' : ''}
                onClick={() => onIntervalChange?.(iv.v)}
              >
                {t(iv.t)}
              </button>
            ))}
          </div>
          <FullscreenButton on={fs.isFullscreen} onClick={fs.toggle} label={t('dashboard:kline.fullscreen')} />
        </div>
      </div>
      <div className="chart-box" ref={boxRef}>
        {loading && <div className="chart-mask">{t('dashboard:kline.loading', { symbol })}</div>}
        {error && (
          <div className="chart-mask error">
            <span>{error}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setReload((n) => n + 1)}>
              {t('dashboard:kline.retry')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
