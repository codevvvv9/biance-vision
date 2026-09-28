/**
 * K 线特征层：把 Brooks「逐根K线分析」的读法量化。
 * 阈值出处：趋势棒 bodyRatio ≥0.55、doji ≤0.30（开源实现共识，ByteBard 0.60/0.30、AxisJu 0.45/0.25）；
 * 内包/外包判定允许边界相等（ByteBard 实现），分类优先级 inside → outside。
 */

import type { KlineBar } from '../types.js'
import type { BarFeature } from './types.js'

/** 趋势棒实体占比阈值 */
export const TREND_BAR_RATIO = 0.55
/** doji 实体占比阈值 */
export const DOJI_RATIO = 0.3

export function computeBarFeatures(bars: KlineBar[]): BarFeature[] {
  const out: BarFeature[] = []
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const range = b.high - b.low
    const body = Math.abs(b.close - b.open)
    const bodyRatio = range > 0 ? body / range : 0
    const closePos = range > 0 ? (b.close - b.low) / range : 0.5
    const upperTail = b.high - Math.max(b.open, b.close)
    const lowerTail = Math.min(b.open, b.close) - b.low
    const barDir = b.close > b.open ? 'up' : b.close < b.open ? 'down' : 'flat'

    const prev = i > 0 ? bars[i - 1] : null
    const isInside = prev !== null && b.high <= prev.high && b.low >= prev.low
    const isOutside =
      prev !== null && !isInside && b.high >= prev.high && b.low <= prev.low

    const pf = i > 0 ? out[i - 1] : null
    const ppf = i > 1 ? out[i - 2] : null

    out.push({
      index: i,
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      range,
      body,
      bodyRatio,
      closePos,
      upperTail,
      lowerTail,
      barDir,
      isTrendBar: range > 0 && bodyRatio >= TREND_BAR_RATIO,
      isDoji: range <= 0 || bodyRatio <= DOJI_RATIO,
      isInside,
      isOutside,
      shavedBottom: lowerTail <= range * 0.02,
      shavedTop: upperTail <= range * 0.02,
      isII: isInside && pf !== null && pf.isInside,
      isIII: isInside && pf !== null && pf.isII && ppf !== null && ppf.isInside,
      isOO: isOutside && pf !== null && pf.isOutside,
      isIOI:
        isInside && pf !== null && pf.isOutside && ppf !== null && ppf.isInside,
    })
  }
  return out
}

/** 指数移动平均（首值用首个收盘价播种，前 period-1 根结果仅作参考） */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length)
  const k = 2 / (period + 1)
  let prev = values.length > 0 ? values[0] : 0
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** ATR（Wilder RMA 平滑的真实波幅） */
export function atr(bars: KlineBar[], period = 14): number[] {
  const out = new Array<number>(bars.length).fill(0)
  let prevAtr = 0
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    const pc = i > 0 ? bars[i - 1].close : b.open
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc))
    prevAtr = i === 0 ? tr : (prevAtr * (period - 1) + tr) / period
    out[i] = prevAtr
  }
  return out
}
