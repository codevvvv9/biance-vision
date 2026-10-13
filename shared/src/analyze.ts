/**
 * 分析流水线：OHLC → 特征 → 结构 → 状态 → 信号 → 摘要 + 结构事件流。
 * 纯函数、零依赖、O(n·k)，千根K线毫秒级完成。
 *
 * 收盘约束（入口强制）：
 * - 任何 closed === false 的 K 线直接抛错（引擎只接受已收盘数据）；
 * - 传入 options.asOf 时，每根 K 线必须携带 closeTime 且 closeTime <= asOf，
 *   否则抛错——回放/研究不得混入截止后才收盘的数据。
 * 调用方负责在入口前剔除未收盘的尾根（REST/WS 归一化层的职责）。
 */

import { atr, computeBarFeatures, ema } from './bars.js'
import { computeAlwaysIn, computeRegime, regimeChangeEvents, REGIME_TEXT } from './regime.js'
import { buildLegs, buildZigzag, findSwings, swingSequenceText, trendStructureText } from './swings.js'
import { detectSignals } from './signals.js'
import { ENGINE_VERSION } from './version.js'
import type { BrooksAnalysis, BrooksCandle, BrooksOptions, StructureEvent } from './types.js'

export const DEFAULT_OPTIONS: BrooksOptions = { swingK: 3 }

function assertClosedBars(bars: BrooksCandle[], asOf?: number): void {
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]
    if (b.closed === false) {
      throw new Error(`analyzeBrooks: 第 ${i} 根K线未收盘（closed=false），引擎只接受已收盘数据`)
    }
    if (asOf !== undefined) {
      if (b.closeTime === undefined) {
        throw new Error(`analyzeBrooks: 使用 asOf 时每根K线必须携带 closeTime（第 ${i} 根缺失）`)
      }
      if (b.closeTime > asOf) {
        throw new Error(`analyzeBrooks: 第 ${i} 根K线 closeTime(${b.closeTime}) 晚于 asOf(${asOf})，违反统一截止时间`)
      }
    }
  }
}

export function analyzeBrooks(bars: BrooksCandle[], options: BrooksOptions = DEFAULT_OPTIONS): BrooksAnalysis | null {
  const k = Math.max(1, Math.min(5, Math.round(options.swingK)))
  if (bars.length < Math.max(30, k * 6)) return null
  assertClosedBars(bars, options.asOf)

  const features = computeBarFeatures(bars)
  const ema20 = ema(
    bars.map((b) => b.close),
    20,
  )
  const atr14 = atr(bars, 14)

  const swings = findSwings(bars, k)
  const zigzag = buildZigzag(swings)
  const legs = buildLegs(bars, features, zigzag, swings)

  const regime = computeRegime(features, ema20, atr14)
  const perBar = regime.perBar
  const alwaysIn = computeAlwaysIn(perBar, features)

  const { signals, events: signalEvents } = detectSignals(
    { bars, features, ema20, atr14, swings, legs, regime: perBar },
    regime.segments,
  )

  // 统一结构事件流：摆动/腿/状态切换 + 信号层的 setup/失效/过期
  const events: StructureEvent[] = [
    ...swings.map((s) => ({
      kind: 'swing' as const,
      ruleId: 'swing.fractal',
      ruleVersion: ENGINE_VERSION,
      atIndex: s.index,
      atTime: s.time,
      knownAtIndex: s.confirmIndex,
      knownAtTime: bars[s.confirmIndex]?.time ?? null,
      barIndices: [s.index],
      note: `摆动${s.kind === 'high' ? '高' : '低'}点 ${s.label || ''}（第 ${s.index + 1} 根，第 ${s.confirmIndex + 1} 根收盘确认）`,
    })),
    ...legs.map((l) => ({
      kind: 'leg' as const,
      ruleId: 'leg.zigzag',
      ruleVersion: ENGINE_VERSION,
      direction: (l.direction === 'up' ? 'bull' : 'bear') as 'bull' | 'bear',
      atIndex: l.fromIndex,
      atTime: bars[l.fromIndex]?.time ?? 0,
      knownAtIndex: l.knownAtIndex,
      knownAtTime: l.knownAtIndex !== null ? bars[l.knownAtIndex]?.time ?? null : null,
      barIndices: [l.fromIndex, l.toIndex],
      provisional: l.provisional,
      note: l.provisional ? '未完成腿（进行中，可延伸，不可作为回放依据）' : undefined,
    })),
    ...regimeChangeEvents(regime.changes, bars, ENGINE_VERSION),
    ...signalEvents,
    ...signals.map((s) => ({
      kind: 'trigger' as const,
      ruleId: s.kind,
      ruleVersion: ENGINE_VERSION,
      direction: s.direction,
      atIndex: s.index,
      atTime: s.time,
      knownAtIndex: s.knownAtIndex,
      knownAtTime: bars[s.knownAtIndex]?.time ?? null,
      barIndices: [s.index],
      note: s.label,
    })),
  ]
  // 回放消费顺序：先按可知时间（provisional 排最后），再按发生位置
  events.sort((a, b) => (a.knownAtIndex ?? Number.MAX_SAFE_INTEGER) - (b.knownAtIndex ?? Number.MAX_SAFE_INTEGER) || a.atIndex - b.atIndex)

  const lastIndex = bars.length - 1
  const summary = {
    barCount: bars.length,
    regime: perBar[lastIndex],
    regimeText: REGIME_TEXT[perBar[lastIndex]],
    pendingRegime: regime.pendingAt[lastIndex] ?? null,
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
    rawRegimeAt: regime.raw,
    regimePendingAt: regime.pendingAt,
    regimes: regime.segments,
    alwaysIn,
    signals,
    events,
    engineVersion: ENGINE_VERSION,
    summary,
    options: { swingK: k, asOf: options.asOf },
  }
}
