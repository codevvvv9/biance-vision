/**
 * Brooks 复盘图表：klinecharts 主图 + BROOKS 自定义指标（结构标注）。
 * 页面负责取数与分析重算；本组件只做渲染与增量更新（WS tick 直接进图表，
 * 收盘K线通过 bars 属性替换触发重算），保证复盘滚动流畅。
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { Chart } from 'klinecharts'
import { dispose, init } from 'klinecharts'
import { ensureStyles, upDownOverrides } from '../components/KlineChart'
import type { UpColorMode } from '../utils'
import { precisionFor } from '../utils'
import type { KlineBar } from '../types'
import { ensureBrooksIndicator } from './indicator'
import type { BrooksAnalysis, BrooksDisplay } from './types'

export interface BrooksChartHandle {
  /** WS tick：直接更新图表最后一根（不影响分析） */
  updateBar: (b: KlineBar) => void
  /** 信号面板点击后定位到对应K线 */
  scrollTo: (index: number) => void
}

interface Props {
  bars: KlineBar[]
  analysis: BrooksAnalysis | null
  display: BrooksDisplay
  upColor: UpColorMode
}

const BrooksChart = forwardRef<BrooksChartHandle, Props>(function BrooksChart(
  { bars, analysis, display, upColor },
  ref,
) {
  const boxRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<Chart | null>(null)
  const extRef = useRef({ analysis, display, upColor })

  useEffect(() => {
    ensureStyles()
    ensureBrooksIndicator()
    const el = boxRef.current
    if (!el) return undefined
    const chart = init(el, { locale: 'zh-CN', styles: 'bv-dark' })
    chartRef.current = chart
    chart?.setStyles(upDownOverrides(upColor))
    chart?.createIndicator({ name: 'BROOKS', extendData: extRef.current }, false, { id: 'candle_pane' })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 分析结果 / 绘制开关 / 配色变化 → 注入指标重绘
  useEffect(() => {
    extRef.current = { analysis, display, upColor }
    chartRef.current?.overrideIndicator({ name: 'BROOKS', extendData: extRef.current })
    chartRef.current?.setStyles(upDownOverrides(upColor))
  }, [analysis, display, upColor])

  // 收盘K线集合变化 → 整体替换
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || bars.length === 0) return
    chart.applyNewData(
      bars.map((k) => ({
        timestamp: k.time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
      })),
    )
    chart.setPriceVolumePrecision(precisionFor(bars[bars.length - 1].close), 2)
  }, [bars])

  useImperativeHandle(
    ref,
    () => ({
      updateBar: (b) => {
        chartRef.current?.updateData({
          timestamp: b.time,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        })
      },
      scrollTo: (i) => chartRef.current?.scrollToDataIndex(Math.max(0, i - 30)),
    }),
    [],
  )

  return <div className="brooks-chart-wrap" ref={boxRef} />
})

export default BrooksChart
