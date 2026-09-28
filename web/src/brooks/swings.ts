/**
 * 摆动点与腿（结构层）。
 *
 * Brooks 官方词汇表：「摆动高点是一根棒的高点，其左侧一或多棒、右侧一或多棒有更低的高点。
 * 市场是分形的，需要多少根取决于上下文（微型摆动 1~2 根，主要摆动可达 10 根以上）。」
 * 实现采用分形枢轴：左侧 k 根严格更低/更高，右侧 k 根不高于/不低于（相等时先出现者胜，
 * 这样相邻等高双顶的两个高点都能被检出）。摆动点天然滞后 k 根（confirmIndex），
 * 所有基于摆动点的信号都在 confirmIndex 收盘后触发，杜绝重绘。
 */

import type { KlineBar } from '../types.js'
import type { BarFeature, Leg, SwingLabel, SwingPoint } from './types.js'

export function findSwings(bars: KlineBar[], k: number): SwingPoint[] {
  const raw: SwingPoint[] = []
  const n = bars.length
  for (let i = k; i < n - k; i++) {
    let isHigh = true
    let isLow = true
    for (let j = 1; j <= k; j++) {
      if (!(bars[i].high > bars[i - j].high && bars[i].high >= bars[i + j].high)) isHigh = false
      if (!(bars[i].low < bars[i - j].low && bars[i].low <= bars[i + j].low)) isLow = false
      if (!isHigh && !isLow) break
    }
    const confirmIndex = Math.min(i + k, n - 1)
    if (isHigh) {
      raw.push({ index: i, time: bars[i].time, price: bars[i].high, kind: 'high', label: '', confirmIndex })
    }
    if (isLow) {
      raw.push({ index: i, time: bars[i].time, price: bars[i].low, kind: 'low', label: '', confirmIndex })
    }
  }
  raw.sort((a, b) => a.index - b.index)

  // 标注 HH/LH/HL/LL：与上一个同向摆动点比较（严格比较，等高记为 LH/LL，配合双顶容差另行处理）
  let lastHigh = NaN
  let lastLow = NaN
  for (const s of raw) {
    if (s.kind === 'high') {
      if (!Number.isNaN(lastHigh)) s.label = s.price > lastHigh ? 'HH' : 'LH'
      lastHigh = s.price
    } else {
      if (!Number.isNaN(lastLow)) s.label = s.price > lastLow ? 'HL' : 'LL'
      lastLow = s.price
    }
  }
  return raw
}

/**
 * 由摆动点构建 zigzag 腿：保证高低点交替。
 * 同向相邻摆动点取更极端者（更高的高点/更低的低点），弱者并入腿内。
 */
export function buildZigzag(swings: SwingPoint[]): SwingPoint[] {
  const nodes: SwingPoint[] = []
  for (const s of swings) {
    const last = nodes[nodes.length - 1]
    if (!last || last.kind !== s.kind) {
      nodes.push(s)
    } else if (
      (s.kind === 'high' && s.price >= last.price) ||
      (s.kind === 'low' && s.price <= last.price)
    ) {
      nodes[nodes.length - 1] = s
    }
  }
  return nodes
}

/** 腿特征：幅度、根数、同向趋势棒数、相对前腿的回调深度 */
export function buildLegs(bars: KlineBar[], features: BarFeature[], zigzag: SwingPoint[]): Leg[] {
  const legs: Leg[] = []
  for (let i = 1; i < zigzag.length; i++) {
    const a = zigzag[i - 1]
    const b = zigzag[i]
    const direction: 'up' | 'down' = b.kind === 'high' ? 'up' : 'down'
    let trendBarCount = 0
    for (let j = a.index + 1; j <= b.index; j++) {
      const f = features[j]
      if (!f) break
      const sameDir = direction === 'up' ? f.barDir === 'up' : f.barDir === 'down'
      if (sameDir && f.isTrendBar) trendBarCount++
    }
    const range = Math.abs(b.price - a.price)
    const prev = legs[legs.length - 1]
    legs.push({
      fromIndex: a.index,
      toIndex: b.index,
      fromPrice: a.price,
      toPrice: b.price,
      direction,
      barCount: b.index - a.index,
      range,
      trendBarCount,
      retracementOfPrev: prev && prev.range > 0 ? range / prev.range : undefined,
    })
  }
  void bars
  return legs
}

/** [a,b] 区间内最低价 */
export function minLowBetween(bars: KlineBar[], a: number, b: number): number {
  let v = Infinity
  for (let i = Math.max(0, a); i <= Math.min(bars.length - 1, b); i++) v = Math.min(v, bars[i].low)
  return v
}

/** [a,b] 区间内最高价 */
export function maxHighBetween(bars: KlineBar[], a: number, b: number): number {
  let v = -Infinity
  for (let i = Math.max(0, a); i <= Math.min(bars.length - 1, b); i++) v = Math.max(v, bars[i].high)
  return v
}

/** 摆动序列文本，如 HH→HL→HH（用于结构摘要） */
export function swingSequenceText(zigzag: SwingPoint[], take = 6): string {
  const tail = zigzag.slice(-take)
  const parts: string[] = []
  for (const s of tail) parts.push(s.label !== '' ? s.label : s.kind === 'high' ? '高' : '低')
  return parts.join('→')
}

/** 结构判定：最近的高点标签与低点标签组合 */
export function trendStructureText(zigzag: SwingPoint[]): string {
  const lastHigh = [...zigzag].reverse().find((s) => s.kind === 'high')
  const lastLow = [...zigzag].reverse().find((s) => s.kind === 'low')
  if (!lastHigh || !lastLow || lastHigh.label === '' || lastLow.label === '') return '结构未定型（摆动点不足）'
  if (lastHigh.label === 'HH' && lastLow.label === 'HL') return '多头结构（HH + HL 交替抬升）'
  if (lastHigh.label === 'LH' && lastLow.label === 'LL') return '空头结构（LH + LL 交替下移）'
  return '多空拉锯（高低点方向不一致，按震荡处理）'
}
