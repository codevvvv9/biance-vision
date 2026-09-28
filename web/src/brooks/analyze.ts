/**
 * 分析流水线：OHLC → 特征 → 结构 → 状态 → 信号 → 摘要。
 * 纯函数、零依赖、O(n·k)，千根K线毫秒级完成；只在收盘K线上运行。
 */

import type { KlineBar } from '../types.js'
import { atr, computeBarFeatures, ema } from './bars.js'
import { computeAlwaysIn, computeRegime, REGIME_TEXT } from './regime.js'
import { buildLegs, buildZigzag, findSwings, swingSequenceText, trendStructureText } from './swings.js'
import { detectSignals } from './signals.js'
import type { BrooksAnalysis, BrooksOptions } from './types.js'

export const DEFAULT_OPTIONS: BrooksOptions = { swingK: 3 }

export function analyzeBrooks(bars: KlineBar[], options: BrooksOptions = DEFAULT_OPTIONS): BrooksAnalysis | null {
  const k = Math.max(1, Math.min(5, Math.round(options.swingK)))
  if (bars.length < Math.max(30, k * 6)) return null

  const features = computeBarFeatures(bars)
  const ema20 = ema(
    bars.map((b) => b.close),
    20,
  )
  const atr14 = atr(bars, 14)

  const swings = findSwings(bars, k)
  const zigzag = buildZigzag(swings)
  const legs = buildLegs(bars, features, zigzag)

  const { perBar, segments } = computeRegime(features, ema20, atr14)
  const alwaysIn = computeAlwaysIn(perBar, features)

  const signals = detectSignals(
    { bars, features, ema20, atr14, swings, legs, regime: perBar },
    segments,
  )

  const lastIndex = bars.length - 1
  const summary = {
    barCount: bars.length,
    regime: perBar[lastIndex],
    regimeText: REGIME_TEXT[perBar[lastIndex]],
    alwaysIn: alwaysIn.direction,
    alwaysInReason: alwaysIn.reason,
    alwaysInSince: alwaysIn.sinceIndex,
    swingSequence: swingSequenceText(zigzag),
    trendStructure: trendStructureText(zigzag),
    lastLeg: legs.length > 0 ? legs[legs.length - 1] : null,
  }

  return {
    bars,
    features,
    ema20,
    atr14,
    swings,
    legs,
    regimeAt: perBar,
    regimes: segments,
    alwaysIn,
    signals,
    summary,
    options: { swingK: k },
  }
}
