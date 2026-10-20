/**
 * 信号规则层：把 Brooks 三部曲的结构规则翻译成确定性代码。
 * 每条信号 = 结构规则触发 + 量化 reason + 概念 concept（出处）+ 经验统计备注 empiricalNote。
 * 全部信号只做「结构标注 / 研究提示」，不含行情预测。
 *
 * 口径纪律：
 * - empiricalNote 引用的是 Brooks 在其美股股指期货市场的经验统计，仅用于理解体系；
 *   它不是本工具对任何币种/周期的预测胜率，不参与判定逻辑（预测概率唯一来自统计模块）。
 * - strength 是规则匹配强度（结构证据完整度），不是置信度，更不是未来事件概率。
 *
 * 生命周期：setup（形态登记）与失效/过期通过 StructureEvent 表达；BrooksSignal 本身
 * 只在触发时产生（status: 'triggered'），knownAtIndex = 触发 bar（输入全部已确认）。
 *
 * 规则出处速查：
 * - H1/H2/H3、L1~L4：《价格行为交易》回调计数，H2/L2 为 Brooks 体系中最常用的二次进场
 * - Wedge 三推反转：《高级反转技术分析》，任意三推形态都当楔形交易
 * - Double top/bottom：两摆动高点近似等高 + 明显回落（容差 0.3×ATR，间隔 ≥3 根）
 * - ii/外包线：突破模式（ii 为日内最可靠突破形态之一，外包线后常跟 H2/L2）
 * - TLB/MTR：趋势线突破 → 测试 → 反转信号（《高级反转技术分析》主要趋势反转序列）
 * - 区间突破：Brooks 经验统计中区间突破尝试大多失败 → 只作研究关注
 */

import type {
  BarFeature,
  BrooksCandle,
  BrooksSignal,
  Direction,
  Leg,
  RegimeType,
  StructureEvent,
  SwingPoint,
} from './types.js'
import { msg } from './i18n.js'
import type { SharedLocale } from './i18n.js'
import { maxHighBetween, minLowBetween } from './swings.js'
import { ENGINE_VERSION } from './version.js'

export interface SignalInput {
  bars: BrooksCandle[]
  features: BarFeature[]
  ema20: number[]
  atr14: number[]
  swings: SwingPoint[]
  legs: Leg[]
  regime: RegimeType[]
}

export interface SignalOutput {
  signals: BrooksSignal[]
  events: StructureEvent[]
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—'
  if (v >= 1000) return v.toFixed(1)
  if (v >= 100) return v.toFixed(2)
  if (v >= 1) return v.toFixed(3)
  return v.toPrecision(4)
}

// ---------------------------------------------------------------------------
// H1~H4 / L1~L4 回调计数状态机（Brooks 核心信号）
// ---------------------------------------------------------------------------

function hlTitle(side: 'bull' | 'bear', count: number, locale: SharedLocale): string {
  return msg(`hl.title.${side === 'bull' ? 'h' : 'l'}${count}`, {}, locale)
}

function detectHL(input: SignalInput, signals: BrooksSignal[], events: StructureEvent[], locale: SharedLocale): void {
  const { bars, features, ema20, regime } = input
  const n = bars.length

  // 多头与空头各跑一套独立状态机
  for (const side of ['bull', 'bear'] as const) {
    let gated = false
    let extreme = side === 'bull' ? -Infinity : Infinity // 本轮趋势极值（新高/新低重置计数）
    let count = 0
    let inPullback = false
    let pullbackExtreme = side === 'bull' ? Infinity : -Infinity // 回调期间最低点/最高点（止损参考）

    for (let i = 1; i < n; i++) {
      const b = bars[i]
      const gate = side === 'bull' ? b.close > ema20[i] : b.close < ema20[i]
      if (!gate) {
        gated = false
        count = 0
        inPullback = false
        continue
      }
      if (!gated) {
        gated = true
        extreme = side === 'bull' ? b.high : b.low
        count = 0
        inPullback = false
        pullbackExtreme = extreme
        continue
      }
      // 创趋势新高/新低：回调计数清零
      const madeNewExtreme = side === 'bull' ? b.high > extreme : b.low < extreme
      if (madeNewExtreme) {
        extreme = side === 'bull' ? b.high : b.low
        count = 0
        inPullback = false
        continue
      }
      if (side === 'bull') {
        if (!inPullback && b.high < bars[i - 1].high) {
          inPullback = true
          pullbackExtreme = b.low
          // setup：多头回调开始（H/L 计数上下文成立，等待上破触发）
          events.push({
            kind: 'setup',
            ruleId: 'hl_count',
            ruleVersion: ENGINE_VERSION,
            direction: 'bull',
            atIndex: i,
            atTime: b.time,
            knownAtIndex: i,
            knownAtTime: b.time,
            barIndices: [i],
            note: msg('hl.setup.bull', { bar: i + 1 }, locale),
          })
        } else if (inPullback) {
          pullbackExtreme = Math.min(pullbackExtreme, b.low)
          if (b.high > bars[i - 1].high) {
            count++
            if (count <= 4) {
              const entry = b.high
              const stop = pullbackExtreme
              const target = entry + (extreme - stop)
              signals.push({
                kind: `H${count}` as BrooksSignal['kind'],
                direction: 'bull',
                index: i,
                time: b.time,
                label: `H${count}`,
                title: hlTitle('bull', count, locale),
                reason: msg('hl.reason.bull', { bar: i + 1, price: fmt(b.high), count, stop: fmt(stop), extreme: fmt(extreme) }, locale),
                concept: msg('hl.concept.bull', {}, locale),
                empiricalNote: msg(`hl.note.${count}`, {}, locale),
                strength: count === 2 ? 'high' : count <= 3 ? 'medium' : 'low',
                ref: { entry, stop, target },
                knownAtIndex: i,
                status: 'triggered',
              })
            }
            inPullback = false
          }
        }
      } else {
        if (!inPullback && b.low > bars[i - 1].low) {
          inPullback = true
          pullbackExtreme = b.high
          events.push({
            kind: 'setup',
            ruleId: 'hl_count',
            ruleVersion: ENGINE_VERSION,
            direction: 'bear',
            atIndex: i,
            atTime: b.time,
            knownAtIndex: i,
            knownAtTime: b.time,
            barIndices: [i],
            note: msg('hl.setup.bear', { bar: i + 1 }, locale),
          })
        } else if (inPullback) {
          pullbackExtreme = Math.max(pullbackExtreme, b.high)
          if (b.low < bars[i - 1].low) {
            count++
            if (count <= 4) {
              const entry = b.low
              const stop = pullbackExtreme
              const target = entry - (stop - extreme)
              signals.push({
                kind: `L${count}` as BrooksSignal['kind'],
                direction: 'bear',
                index: i,
                time: b.time,
                label: `L${count}`,
                title: hlTitle('bear', count, locale),
                reason: msg('hl.reason.bear', { bar: i + 1, price: fmt(b.low), count, stop: fmt(stop), extreme: fmt(extreme) }, locale),
                concept: msg('hl.concept.bear', {}, locale),
                empiricalNote: msg(`hl.note.${count}`, {}, locale),
                strength: count === 2 ? 'high' : count <= 3 ? 'medium' : 'low',
                ref: { entry, stop, target },
                knownAtIndex: i,
                status: 'triggered',
              })
            }
            inPullback = false
          }
        }
      }
    }
    void regime
  }
}

// ---------------------------------------------------------------------------
// 冲刺（Spike）：≥5 根连续同向趋势棒
// ---------------------------------------------------------------------------

function detectSpikes(input: SignalInput, signals: BrooksSignal[], locale: SharedLocale): void {
  const { bars, features, atr14 } = input
  for (let i = 0; i < bars.length; i++) {
    let runDir: 'up' | 'down' | null = null
    let runLen = 0
    let runHigh = bars[i].high
    let runLow = bars[i].low
    for (let j = i; j >= 0; j--) {
      const f = features[j]
      if (!f.isTrendBar || f.barDir === 'flat') break
      if (runDir === null) runDir = f.barDir
      else if (f.barDir !== runDir) break
      runLen++
      runHigh = Math.max(runHigh, bars[j].high)
      runLow = Math.min(runLow, bars[j].low)
      if (runLen > 5) break
    }
    // 恰好在第 5 根触发一次（之后不重复发）
    if (runLen === 5 && runDir !== null) {
      const a = atr14[i] > 0 ? atr14[i] : 1e-9
      if (runHigh - runLow < 1.5 * a) continue
      const bull = runDir === 'up'
      signals.push({
        kind: bull ? 'SPIKE_UP' : 'SPIKE_DOWN',
        direction: bull ? 'bull' : 'bear',
        index: i,
        time: bars[i].time,
        label: msg(bull ? 'spike.label.bull' : 'spike.label.bear', {}, locale),
        title: msg(bull ? 'spike.title.bull' : 'spike.title.bear', {}, locale),
        reason: msg('spike.reason', { range: fmt(runHigh - runLow), atrMult: ((runHigh - runLow) / a).toFixed(1) }, locale),
        concept: msg('spike.concept', {}, locale),
        empiricalNote: msg('spike.note', {}, locale),
        strength: 'high',
        ref: { entry: bull ? bars[i].high : bars[i].low, stop: bull ? runLow : runHigh },
        knownAtIndex: i,
        status: 'triggered',
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 楔形（Wedge）：三推反转，跨度 ≤40 根
// ---------------------------------------------------------------------------

function detectWedges(input: SignalInput, signals: BrooksSignal[], locale: SharedLocale): void {
  const { bars, swings, atr14 } = input
  const highs = swings.filter((s) => s.kind === 'high')
  const lows = swings.filter((s) => s.kind === 'low')
  const used = new Set<number>()

  for (let j = 2; j < highs.length; j++) {
    const h1 = highs[j - 2]
    const h2 = highs[j - 1]
    const h3 = highs[j]
    if (used.has(h2.index) || used.has(h3.index)) continue
    const span = h3.index - h1.index
    if (span < 6 || span > 40) continue
    if (!(h1.price < h2.price && h2.price < h3.price)) continue
    // 三推之间必须各有一个摆动低点（真实回调）
    const hasLow1 = lows.some((l) => l.index > h1.index && l.index < h2.index)
    const hasLow2 = lows.some((l) => l.index > h2.index && l.index < h3.index)
    if (!hasLow1 || !hasLow2) continue

    const atr = atr14[h3.index] > 0 ? atr14[h3.index] : 1e-9
    const push1 = h2.price - minLowBetween(bars, h1.index, h2.index)
    const push2 = h3.price - minLowBetween(bars, h2.index, h3.index)
    const fading = push2 < push1 * 0.9 // 第三推动能明显衰减
    used.add(h2.index)
    used.add(h3.index)
    signals.push({
      kind: 'WEDGE_TOP',
      direction: 'bear',
      index: h3.confirmIndex,
      time: bars[h3.confirmIndex]?.time ?? h3.time,
      label: msg('wedge.label.top', {}, locale),
      title: msg('wedge.title.top', { price: fmt(h3.price) }, locale) + (fading ? msg('wedge.fading', {}, locale) : ''),
      reason:
        msg('wedge.reason.top', { h1: fmt(h1.price), h2: fmt(h2.price), h3: fmt(h3.price), span, push2: fmt(push2) }, locale) +
        (fading ? msg('wedge.reasonFading', { push1: fmt(push1) }, locale) : ''),
      concept: msg('wedge.concept.top', {}, locale),
      empiricalNote: msg('wedge.note.top', {}, locale),
      strength: fading ? 'high' : 'medium',
      ref: { entry: h3.price, stop: h3.price + 0.5 * atr, target: h3.price - (h3.price - h1.price) },
      knownAtIndex: h3.confirmIndex,
      status: 'triggered',
    })
  }

  // 镜像：三推楔形底
  const usedLow = new Set<number>()
  for (let j = 2; j < lows.length; j++) {
    const l1 = lows[j - 2]
    const l2 = lows[j - 1]
    const l3 = lows[j]
    if (usedLow.has(l2.index) || usedLow.has(l3.index)) continue
    const span = l3.index - l1.index
    if (span < 6 || span > 40) continue
    if (!(l1.price > l2.price && l2.price > l3.price)) continue
    const hasHigh1 = highs.some((h) => h.index > l1.index && h.index < l2.index)
    const hasHigh2 = highs.some((h) => h.index > l2.index && h.index < l3.index)
    if (!hasHigh1 || !hasHigh2) continue

    const atr = atr14[l3.index] > 0 ? atr14[l3.index] : 1e-9
    const push1 = maxHighBetween(bars, l1.index, l2.index) - l1.price
    const push2 = maxHighBetween(bars, l2.index, l3.index) - l2.price
    const fading = push2 < push1 * 0.9
    usedLow.add(l2.index)
    usedLow.add(l3.index)
    signals.push({
      kind: 'WEDGE_BOTTOM',
      direction: 'bull',
      index: l3.confirmIndex,
      time: bars[l3.confirmIndex]?.time ?? l3.time,
      label: msg('wedge.label.bottom', {}, locale),
      title: msg('wedge.title.bottom', { price: fmt(l3.price) }, locale) + (fading ? msg('wedge.fading', {}, locale) : ''),
      reason:
        msg('wedge.reason.bottom', { l1: fmt(l1.price), l2: fmt(l2.price), l3: fmt(l3.price), span, push2: fmt(push2) }, locale) +
        (fading ? msg('wedge.reasonFading', { push1: fmt(push1) }, locale) : ''),
      concept: msg('wedge.concept.bottom', {}, locale),
      empiricalNote: msg('wedge.note.bottom', {}, locale),
      strength: fading ? 'high' : 'medium',
      ref: { entry: l3.price, stop: l3.price - 0.5 * atr, target: l3.price + (l1.price - l3.price) },
      knownAtIndex: l3.confirmIndex,
      status: 'triggered',
    })
  }
}

// ---------------------------------------------------------------------------
// 双顶 / 双底：两摆动点近似等高 + 明显回落
// ---------------------------------------------------------------------------

function detectDoubles(input: SignalInput, signals: BrooksSignal[], locale: SharedLocale): void {
  const { bars, swings, atr14 } = input
  const highs = swings.filter((s) => s.kind === 'high')
  const lows = swings.filter((s) => s.kind === 'low')

  for (let j = 1; j < highs.length; j++) {
    const h1 = highs[j - 1]
    const h2 = highs[j]
    const gap = h2.index - h1.index
    if (gap < 3 || gap > 60) continue
    const a = atr14[h2.index]
    if (a <= 0) continue
    if (Math.abs(h1.price - h2.price) > 0.3 * a) continue
    const dip = minLowBetween(bars, h1.index, h2.index)
    if (dip > Math.min(h1.price, h2.price) - 0.5 * a) continue
    signals.push({
      kind: 'DOUBLE_TOP',
      direction: 'bear',
      index: h2.confirmIndex,
      time: bars[h2.confirmIndex]?.time ?? h2.time,
      label: msg('double.label.top', {}, locale),
      title: msg('double.title.top', { price: fmt(h2.price) }, locale),
      reason: msg('double.reason.top', { p1: fmt(h1.price), p2: fmt(h2.price), diff: fmt(Math.abs(h1.price - h2.price)), dip: fmt(dip) }, locale),
      concept: msg('double.concept.top', {}, locale),
      empiricalNote: msg('double.note.top', {}, locale),
      strength: 'medium',
      ref: { entry: h2.price, stop: h2.price + 0.5 * a, target: dip - (Math.max(h1.price, h2.price) - dip) },
      knownAtIndex: h2.confirmIndex,
      status: 'triggered',
    })
  }

  for (let j = 1; j < lows.length; j++) {
    const l1 = lows[j - 1]
    const l2 = lows[j]
    const gap = l2.index - l1.index
    if (gap < 3 || gap > 60) continue
    const a = atr14[l2.index]
    if (a <= 0) continue
    if (Math.abs(l1.price - l2.price) > 0.3 * a) continue
    const bump = maxHighBetween(bars, l1.index, l2.index)
    if (bump < Math.max(l1.price, l2.price) + 0.5 * a) continue
    signals.push({
      kind: 'DOUBLE_BOTTOM',
      direction: 'bull',
      index: l2.confirmIndex,
      time: bars[l2.confirmIndex]?.time ?? l2.time,
      label: msg('double.label.bottom', {}, locale),
      title: msg('double.title.bottom', { price: fmt(l2.price) }, locale),
      reason: msg('double.reason.bottom', { p1: fmt(l1.price), p2: fmt(l2.price), diff: fmt(Math.abs(l1.price - l2.price)), bump: fmt(bump) }, locale),
      concept: msg('double.concept.bottom', {}, locale),
      empiricalNote: msg('double.note.bottom', {}, locale),
      strength: 'medium',
      ref: { entry: l2.price, stop: l2.price - 0.5 * a, target: bump + (bump - Math.min(l1.price, l2.price)) },
      knownAtIndex: l2.confirmIndex,
      status: 'triggered',
    })
  }
}

// ---------------------------------------------------------------------------
// ii 突破 + 外包线反转（突破模式）
// ---------------------------------------------------------------------------

function detectBreakoutPatterns(input: SignalInput, signals: BrooksSignal[], events: StructureEvent[], locale: SharedLocale): void {
  const { bars, features } = input
  interface Pending {
    high: number
    low: number
    bornIndex: number
    done: boolean
  }
  const pending: Pending[] = []

  for (let i = 0; i < bars.length; i++) {
    const f = features[i]
    const b = bars[i]

    // 先当触发器：检查挂起的 ii 形态是否被收盘突破（5 根内，先到先得）
    for (const p of pending) {
      if (p.done) continue
      if (i - p.bornIndex > 5) {
        // 失效事件：5 根内未突破，形态过期（setup 与失效分离）
        p.done = true
        events.push({
          kind: 'expiry',
          ruleId: 'ii_breakout',
          ruleVersion: ENGINE_VERSION,
          atIndex: i,
          atTime: b.time,
          knownAtIndex: i,
          knownAtTime: b.time,
          barIndices: [p.bornIndex - 1, p.bornIndex, i],
          note: msg('ii.expiry', { bornBar: p.bornIndex + 1 }, locale),
        })
        continue
      }
      if (b.close > p.high) {
        p.done = true
        signals.push({
          kind: 'II_BREAKOUT_UP',
          direction: 'bull',
          index: i,
          time: b.time,
          label: msg('ii.label.up', {}, locale),
          title: msg('ii.title.up', {}, locale),
          reason: msg('ii.reason.up', { bornBar: p.bornIndex + 1, bar: i + 1, close: fmt(b.close), high: fmt(p.high) }, locale),
          concept: msg('ii.concept.up', {}, locale),
          empiricalNote: msg('ii.note', {}, locale),
          strength: 'medium',
          ref: { entry: b.high, stop: p.low },
          knownAtIndex: i,
          status: 'triggered',
        })
      } else if (b.close < p.low) {
        p.done = true
        signals.push({
          kind: 'II_BREAKOUT_DOWN',
          direction: 'bear',
          index: i,
          time: b.time,
          label: msg('ii.label.down', {}, locale),
          title: msg('ii.title.down', {}, locale),
          reason: msg('ii.reason.down', { bornBar: p.bornIndex + 1, bar: i + 1, close: fmt(b.close), low: fmt(p.low) }, locale),
          concept: msg('ii.concept.down', {}, locale),
          empiricalNote: msg('ii.note', {}, locale),
          strength: 'medium',
          ref: { entry: b.low, stop: p.high },
          knownAtIndex: i,
          status: 'triggered',
        })
      }
    }

    // 再注册新的 ii 形态（一段内包序列只在第一次满足 isII 时注册一次）
    if (f.isII && !f.isIII && !(i > 0 && features[i - 1].isII)) {
      pending.push({
        high: Math.max(b.high, bars[i - 1].high),
        low: Math.min(b.low, bars[i - 1].low),
        bornIndex: i,
        done: false,
      })
      // setup：ii 形态登记（已知，等待触发或过期）
      events.push({
        kind: 'setup',
        ruleId: 'ii_breakout',
        ruleVersion: ENGINE_VERSION,
        atIndex: i,
        atTime: b.time,
        knownAtIndex: i,
        knownAtTime: b.time,
        barIndices: [i - 1, i],
        note: msg('ii.setup', { barA: i, barB: i + 1, high: fmt(Math.max(b.high, bars[i - 1].high)), low: fmt(Math.min(b.low, bars[i - 1].low)) }, locale),
      })
    }

    // 外包线反转：吞没棒之后一根收盘创其新高/新低
    if (f.isOutside && !f.isOO && i + 1 < bars.length) {
      const nx = bars[i + 1]
      if (nx.close > b.high) {
        signals.push({
          kind: 'OB_REVERSAL_UP',
          direction: 'bull',
          index: i + 1,
          time: nx.time,
          label: msg('ob.label.up', {}, locale),
          title: msg('ob.title.up', {}, locale),
          reason: msg('ob.reason.up', { bar: i + 1, close: fmt(nx.close), high: fmt(b.high) }, locale),
          concept: msg('ob.concept.up', {}, locale),
          empiricalNote: msg('ob.note', {}, locale),
          strength: 'low',
          ref: { entry: nx.high, stop: b.low },
          knownAtIndex: i + 1,
          status: 'triggered',
        })
      } else if (nx.close < b.low) {
        signals.push({
          kind: 'OB_REVERSAL_DOWN',
          direction: 'bear',
          index: i + 1,
          time: nx.time,
          label: msg('ob.label.down', {}, locale),
          title: msg('ob.title.down', {}, locale),
          reason: msg('ob.reason.down', { bar: i + 1, close: fmt(nx.close), low: fmt(b.low) }, locale),
          concept: msg('ob.concept.down', {}, locale),
          empiricalNote: msg('ob.note', {}, locale),
          strength: 'low',
          ref: { entry: nx.low, stop: b.high },
          knownAtIndex: i + 1,
          status: 'triggered',
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 趋势线突破（TLB）→ 测试 → 主要趋势反转（MTR）
// ---------------------------------------------------------------------------

function detectTrendLineBreaks(input: SignalInput, signals: BrooksSignal[], locale: SharedLocale): void {
  const { bars, swings, features, ema20, atr14, regime } = input
  const n = bars.length
  // 各方向的前缀 bull/bear 状态计数，用于「此前确实是趋势」的上下文过滤
  const bullPrefix = new Array<number>(n + 1).fill(0)
  const bearPrefix = new Array<number>(n + 1).fill(0)
  for (let i = 0; i < n; i++) {
    bullPrefix[i + 1] = bullPrefix[i] + (regime[i] === 'channel_bull' || regime[i] === 'spike_bull' ? 1 : 0)
    bearPrefix[i + 1] = bearPrefix[i] + (regime[i] === 'channel_bear' || regime[i] === 'spike_bear' ? 1 : 0)
  }
  const hadTrend = (from: number, to: number, side: Direction): boolean => {
    if (side === 'bull') return bullPrefix[Math.min(to + 1, n)] - bullPrefix[Math.max(from, 0)] > 0
    return bearPrefix[Math.min(to + 1, n)] - bearPrefix[Math.max(from, 0)] > 0
  }

  for (const side of ['bull', 'bear'] as const) {
    const kind = side === 'bull' ? 'low' : 'high'
    const pts = swings.filter((s) => s.kind === kind)
    let cursor = 0 // 已消费的摆动点数（confirmIndex <= i 的都算已确认）
    let p1: SwingPoint | null = null
    let p2: SwingPoint | null = null
    let broken = false
    let brokenIndex = -1
    let testSeen = false
    let mtrDone = false

    const lineValue = (i: number): number => {
      if (!p1 || !p2) return NaN
      return p1.price + ((p2.price - p1.price) * (i - p1.index)) / (p2.index - p1.index)
    }

    for (let i = 0; i < n; i++) {
      // 收录新确认的摆动点，构建/更新趋势线；趋势线处于「已破位待反转」窗口时冻结（防止
      // 反向摆动点抢先替换趋势线、吞掉即将完成的 MTR 序列）；只有斜率方向合法的摆动对才采纳
      while (cursor < pts.length && pts[cursor].confirmIndex <= i) {
        const cand = pts[cursor]
        if (p2 === null) {
          p2 = cand
        } else {
          const frozen = broken && !mtrDone && i - brokenIndex <= 20
          const slopeValid = side === 'bull' ? cand.price > p2.price : cand.price < p2.price
          if (!frozen && slopeValid) {
            p1 = p2
            p2 = cand
            broken = false
            brokenIndex = -1
            testSeen = false
            mtrDone = false
          }
        }
        cursor++
      }
      if (!p1 || !p2 || p2.index === p1.index) continue
      // 多头趋势线要求低点抬升（正斜率）；空头趋势线要求高点下移（负斜率）
      const slopeOk = side === 'bull' ? p2.price > p1.price : p2.price < p1.price
      if (!slopeOk) continue
      if (i - p2.index > 80) continue // 趋势线过期

      const lv = lineValue(i)
      if (!Number.isFinite(lv)) continue
      const a = atr14[i] > 0 ? atr14[i] : 1e-9

      if (!broken) {
        const cross = side === 'bull' ? bars[i].close < lv : bars[i].close > lv
        if (cross && hadTrend(Math.max(0, i - 40), i, side === 'bull' ? 'bull' : 'bear')) {
          broken = true
          brokenIndex = i
          testSeen = false
          signals.push({
            kind: side === 'bull' ? 'TLB_BEAR' : 'TLB_BULL',
            direction: side === 'bull' ? 'bear' : 'bull',
            index: i,
            time: bars[i].time,
            label: msg(side === 'bull' ? 'tlb.label.down' : 'tlb.label.up', {}, locale),
            title: msg(side === 'bull' ? 'tlb.title.bull' : 'tlb.title.bear', {}, locale),
            reason: msg(
              'tlb.reason',
              { pivot: msg(kind === 'low' ? 'tlb.pivot.low' : 'tlb.pivot.high', {}, locale), p1: fmt(p1.price), b1: p1.index + 1, p2: fmt(p2.price), b2: p2.index + 1, bar: i + 1, line: fmt(lv), close: fmt(bars[i].close) },
              locale,
            ),
            concept: msg('tlb.concept', {}, locale),
            empiricalNote: msg('tlb.note', {}, locale),
            strength: 'low',
            knownAtIndex: i,
            status: 'triggered',
          })
        }
      } else if (!mtrDone && i - brokenIndex <= 20 && i >= 1) {
        // 测试：价格回到趋势线附近（±0.25 ATR）但未远离
        if (!testSeen) {
          const near = side === 'bull' ? bars[i].high >= lv - 0.25 * a : bars[i].low <= lv + 0.25 * a
          if (near) testSeen = true
        }
        const f = features[i]
        const originBreak =
          side === 'bull'
            ? bars[i].close < Math.min(p1.price, p2.price)
            : bars[i].close > Math.max(p1.price, p2.price)
        const strongReversal =
          side === 'bull'
            ? bars[i].close < bars[i - 1].low && f.closePos <= 0.35 && f.bodyRatio >= 0.55 && bars[i].close < ema20[i]
            : bars[i].close > bars[i - 1].high && f.closePos >= 0.65 && f.bodyRatio >= 0.55 && bars[i].close > ema20[i]
        if (originBreak || (strongReversal && testSeen)) {
          mtrDone = true
          const dir: Direction = side === 'bull' ? 'bear' : 'bull'
          signals.push({
            kind: side === 'bull' ? 'MTR_BEAR' : 'MTR_BULL',
            direction: dir,
            index: i,
            time: bars[i].time,
            label: 'MTR',
            title: msg(side === 'bull' ? 'mtr.title.bull' : 'mtr.title.bear', {}, locale),
            reason: msg(
              'mtr.reason',
              {
                breakBar: brokenIndex + 1,
                tested: testSeen ? msg('mtr.tested', {}, locale) : '',
                bar: i + 1,
                confirm: originBreak
                  ? msg(kind === 'low' ? 'mtr.confirm.origin.low' : 'mtr.confirm.origin.high', { close: fmt(bars[i].close) }, locale)
                  : msg('mtr.confirm.strong', {}, locale),
              },
              locale,
            ),
            concept: msg('mtr.concept', {}, locale),
            empiricalNote: msg('mtr.note', {}, locale),
            strength: 'high',
            knownAtIndex: i,
            status: 'triggered',
          })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 交易区间突破（研究关注；Brooks 经验统计中大多失败）
// ---------------------------------------------------------------------------

function detectTRBreakouts(input: SignalInput, signals: BrooksSignal[], segments: { from: number; to: number; type: RegimeType }[], locale: SharedLocale): void {
  const { bars, features } = input
  for (const seg of segments) {
    if (seg.type !== 'trading_range') continue
    const len = seg.to - seg.from + 1
    if (len < 10 || seg.to < 30) continue
    let hi = -Infinity
    let lo = Infinity
    for (let i = seg.from; i <= seg.to; i++) {
      hi = Math.max(hi, bars[i].high)
      lo = Math.min(lo, bars[i].low)
    }
    let fired = false
    for (let j = seg.to + 1; j <= Math.min(seg.to + 40, bars.length - 1) && !fired; j++) {
      if (bars[j].close > hi && features[j].isTrendBar) {
        fired = true
        signals.push({
          kind: 'TR_BREAKOUT_UP',
          direction: 'bull',
          index: j,
          time: bars[j].time,
          label: msg('tr.label.up', {}, locale),
          title: msg('tr.title.up', {}, locale),
          reason: msg('tr.reason.up', { from: seg.from + 1, to: seg.to + 1, len, lo: fmt(lo), hi: fmt(hi), bar: j + 1, close: fmt(bars[j].close) }, locale),
          concept: msg('tr.concept.up', {}, locale),
          empiricalNote: msg('tr.note', {}, locale),
          strength: 'medium',
          ref: { entry: bars[j].high, stop: hi, target: hi + (hi - lo) },
          knownAtIndex: j,
          status: 'triggered',
        })
      } else if (bars[j].close < lo && features[j].isTrendBar) {
        fired = true
        signals.push({
          kind: 'TR_BREAKOUT_DOWN',
          direction: 'bear',
          index: j,
          time: bars[j].time,
          label: msg('tr.label.down', {}, locale),
          title: msg('tr.title.down', {}, locale),
          reason: msg('tr.reason.down', { from: seg.from + 1, to: seg.to + 1, len, lo: fmt(lo), hi: fmt(hi), bar: j + 1, close: fmt(bars[j].close) }, locale),
          concept: msg('tr.concept.down', {}, locale),
          empiricalNote: msg('tr.note', {}, locale),
          strength: 'medium',
          ref: { entry: bars[j].low, stop: lo, target: lo - (hi - lo) },
          knownAtIndex: j,
          status: 'triggered',
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------

/** 失效扫描：触发后收盘击穿结构止损 → invalidation 事件（因果：扫描窗右端即已知） */
function scanInvalidations(bars: BrooksCandle[], signals: BrooksSignal[], events: StructureEvent[], locale: SharedLocale): void {
  const MAX_SCAN = 100
  for (const s of signals) {
    const stop = s.ref?.stop
    if (stop === undefined || s.direction === 'neutral') continue
    const end = Math.min(bars.length - 1, s.index + MAX_SCAN)
    for (let i = s.index + 1; i <= end; i++) {
      const adverse = s.direction === 'bull' ? bars[i].close < stop : bars[i].close > stop
      if (!adverse) continue
      events.push({
        kind: 'invalidation',
        ruleId: s.kind,
        ruleVersion: ENGINE_VERSION,
        direction: s.direction,
        atIndex: i,
        atTime: bars[i].time,
        knownAtIndex: i,
        knownAtTime: bars[i].time,
        barIndices: [s.index, i],
        note: msg('invalidation.note', { label: s.label, triggerBar: s.index + 1, bar: i + 1, close: fmt(bars[i].close), stop: fmt(stop) }, locale),
      })
      break
    }
  }
}

export function detectSignals(input: SignalInput, segments: { from: number; to: number; type: RegimeType }[], locale: SharedLocale = 'zh-CN'): SignalOutput {
  const signals: BrooksSignal[] = []
  const events: StructureEvent[] = []
  detectHL(input, signals, events, locale)
  detectSpikes(input, signals, locale)
  detectWedges(input, signals, locale)
  detectDoubles(input, signals, locale)
  detectBreakoutPatterns(input, signals, events, locale)
  detectTrendLineBreaks(input, signals, locale)
  detectTRBreakouts(input, signals, segments, locale)
  scanInvalidations(input.bars, signals, events, locale)

  signals.sort((a, b) => a.index - b.index)
  // 去重：同一根K线上同一种信号只保留一条
  const seen = new Set<string>()
  const out: BrooksSignal[] = []
  for (const s of signals) {
    const key = `${s.kind}@${s.index}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return { signals: out, events }
}
