/**
 * 信号规则层：把 Brooks 三部曲的结构规则翻译成确定性代码。
 * 每条信号 = 结构规则触发 + 量化 reason + 概念 concept（出处）+ 概率先验 prior。
 * 全部信号只做「结构标注 / 研究提示」，不含行情预测。
 *
 * 规则出处速查：
 * - H1/H2/H3、L1~L4：《价格行为交易》回调计数，H2/L2 为 Brooks 体系中胜率最高的二次进场（≈60%）
 * - Wedge 三推反转：《高级反转技术分析》，任意三推形态都当楔形交易
 * - Double top/bottom：两摆动高点近似等高 + 明显回落（容差 0.3×ATR，间隔 ≥3 根）
 * - ii/外包线：突破模式（ii 为日内最可靠突破形态之一，外包线后常跟 H2/L2）
 * - TLB/MTR：趋势线突破 → 测试 → 反转信号（《高级反转技术分析》主要趋势反转序列）
 * - 区间突破：80% 的交易区间突破尝试失败，首次突破仅约 50% 存活 → 只作研究关注
 */

import type { BarFeature, BrooksSignal, Direction, Leg, RegimeType, SwingPoint, BrooksCandle } from './types.js'
import { maxHighBetween, minLowBetween } from './swings.js'

export interface SignalInput {
  bars: BrooksCandle[]
  features: BarFeature[]
  ema20: number[]
  atr14: number[]
  swings: SwingPoint[]
  legs: Leg[]
  regime: RegimeType[]
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

const HL_TITLES: Record<number, { h: string; l: string; prior: string }> = {
  1: {
    h: 'H1 · 多头第一次进场尝试',
    l: 'L1 · 空头第一次进场尝试',
    prior: '首次尝试成功率较低（趋势惯性强，80% 的反转尝试只是回调）',
  },
  2: {
    h: 'H2 · 多头二次进场（高胜率结构）',
    l: 'L2 · 空头二次进场（高胜率结构）',
    prior: 'Brooks 体系中二次进场胜率先验 ≈60%（趋势中的顺势回调二买/二卖）',
  },
  3: {
    h: 'H3 · 多头第三次进场尝试',
    l: 'L3 · 空头第三次进场尝试',
    prior: '计数越高动能越弱；趋势惯性强时仍可顺势，但失败率上升',
  },
  4: {
    h: 'H4 · 多头第四次进场尝试（警惕趋势衰竭）',
    l: 'L4 · 空头第四次进场尝试（警惕趋势衰竭）',
    prior: 'H4/L4 常出现在趋势末期或震荡中，Brooks 建议降低预期',
  },
}

function detectHL(input: SignalInput, signals: BrooksSignal[]): void {
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
      const f = features[i]
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
        } else if (inPullback) {
          pullbackExtreme = Math.min(pullbackExtreme, b.low)
          if (b.high > bars[i - 1].high) {
            count++
            if (count <= 4) {
              const t = HL_TITLES[count]
              const entry = b.high
              const stop = pullbackExtreme
              const target = entry + (extreme - stop)
              signals.push({
                kind: `H${count}` as BrooksSignal['kind'],
                direction: 'bull',
                index: i,
                time: b.time,
                label: `H${count}`,
                title: t.h,
                reason: `第 ${i + 1} 根K线高点 ${fmt(b.high)} 上穿前一根高点，为本轮多头回调的第 ${count} 次进场尝试；回调低点 ${fmt(stop)}，趋势极值 ${fmt(extreme)}`,
                concept: '《价格行为交易》：多头腿中突破前一根K线高点 = H1；失败后的第二次尝试 = H2（二次进场）',
                prior: t.prior,
                strength: count === 2 ? 'high' : count <= 3 ? 'medium' : 'low',
                ref: { entry, stop, target },
              })
            }
            inPullback = false
          }
        }
      } else {
        if (!inPullback && b.low > bars[i - 1].low) {
          inPullback = true
          pullbackExtreme = b.high
        } else if (inPullback) {
          pullbackExtreme = Math.max(pullbackExtreme, b.high)
          if (b.low < bars[i - 1].low) {
            count++
            if (count <= 4) {
              const t = HL_TITLES[count]
              const entry = b.low
              const stop = pullbackExtreme
              const target = entry - (stop - extreme)
              signals.push({
                kind: `L${count}` as BrooksSignal['kind'],
                direction: 'bear',
                index: i,
                time: b.time,
                label: `L${count}`,
                title: t.l,
                reason: `第 ${i + 1} 根K线低点 ${fmt(b.low)} 跌破前一根低点，为本轮空头回调的第 ${count} 次进场尝试；回调高点 ${fmt(stop)}，趋势极值 ${fmt(extreme)}`,
                concept: '《价格行为交易》：空头腿中跌破前一根K线低点 = L1；失败后的第二次尝试 = L2（二次进场）',
                prior: t.prior,
                strength: count === 2 ? 'high' : count <= 3 ? 'medium' : 'low',
                ref: { entry, stop, target },
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

function detectSpikes(input: SignalInput, signals: BrooksSignal[]): void {
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
        label: bull ? '冲刺↑' : '冲刺↓',
        title: bull ? '多头冲刺启动（Spike）' : '空头冲刺启动（Spike）',
        reason: `连续 5 根同向趋势棒（实体占比 ≥55%），累计幅度 ${fmt(runHigh - runLow)} ≈ ${((runHigh - runLow) / a).toFixed(1)}×ATR`,
        concept: '《高级趋势技术分析》spike and channel：冲刺腿是趋势最强阶段，回调通常止于通道起点',
        prior: '冲刺后进入通道的概率高；首次逆冲刺交易 80% 会失败',
        strength: 'high',
        ref: { entry: bull ? bars[i].high : bars[i].low, stop: bull ? runLow : runHigh },
      })
    }
  }
}

// ---------------------------------------------------------------------------
// 楔形（Wedge）：三推反转，跨度 ≤40 根
// ---------------------------------------------------------------------------

function detectWedges(input: SignalInput, signals: BrooksSignal[]): void {
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
      label: '楔顶',
      title: `三推楔形顶（第3推 ${fmt(h3.price)}）${fading ? '· 动能衰减' : ''}`,
      reason: `三个摆动高点依次抬升 ${fmt(h1.price)} → ${fmt(h2.price)} → ${fmt(h3.price)}（跨度 ${span} 根）；第三推幅度 ${fmt(push2)}${fading ? ` 小于第一推 ${fmt(push1)}（动能递减）` : ''}`,
      concept: '《高级反转技术分析》：任意三推形态都当楔形交易；第三推常由微型趋势通道线延伸产生，反转目标为楔形起点',
      prior: '楔形反转后常见两腿回调；测量目标 = 楔形全幅回到起点',
      strength: fading ? 'high' : 'medium',
      ref: { entry: h3.price, stop: h3.price + 0.5 * atr, target: h3.price - (h3.price - h1.price) },
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
      label: '楔底',
      title: `三推楔形底（第3推 ${fmt(l3.price)}）${fading ? '· 动能衰减' : ''}`,
      reason: `三个摆动低点依次下移 ${fmt(l1.price)} → ${fmt(l2.price)} → ${fmt(l3.price)}（跨度 ${span} 根）；第三推幅度 ${fmt(push2)}${fading ? ` 小于第一推 ${fmt(push1)}（动能递减）` : ''}`,
      concept: '《高级反转技术分析》：下跌三推衰竭后的楔形底，是空头趋势转多的经典反转结构',
      prior: '楔形底反转后常见两腿上涨；测量目标 = 楔形全幅回到起点',
      strength: fading ? 'high' : 'medium',
      ref: { entry: l3.price, stop: l3.price - 0.5 * atr, target: l3.price + (l1.price - l3.price) },
    })
  }
}

// ---------------------------------------------------------------------------
// 双顶 / 双底：两摆动点近似等高 + 明显回落
// ---------------------------------------------------------------------------

function detectDoubles(input: SignalInput, signals: BrooksSignal[]): void {
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
      label: '双顶',
      title: `双顶 ${fmt(h2.price)}`,
      reason: `两个摆动高点近似等高（${fmt(h1.price)} / ${fmt(h2.price)}，差 ${fmt(Math.abs(h1.price - h2.price))} ≤ 0.3×ATR），中间回落至 ${fmt(dip)}`,
      concept: '《高级反转技术分析》双顶：第二高点测试前高失败（1 tick 更高也算），跌破颈线（中间低点）确认',
      prior: '双顶跌破颈线后的测量目标 = 双顶高度自颈线下投',
      strength: 'medium',
      ref: { entry: h2.price, stop: h2.price + 0.5 * a, target: dip - (Math.max(h1.price, h2.price) - dip) },
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
      label: '双底',
      title: `双底 ${fmt(l2.price)}`,
      reason: `两个摆动低点近似等低（${fmt(l1.price)} / ${fmt(l2.price)}，差 ${fmt(Math.abs(l1.price - l2.price))} ≤ 0.3×ATR），中间反弹至 ${fmt(bump)}`,
      concept: '《高级反转技术分析》双底：第二低点测试前低失败，收破中间高点（颈线）确认反转',
      prior: '双底收破颈线后的测量目标 = 双底高度自颈线上投',
      strength: 'medium',
      ref: { entry: l2.price, stop: l2.price - 0.5 * a, target: bump + (bump - Math.min(l1.price, l2.price)) },
    })
  }
}

// ---------------------------------------------------------------------------
// ii 突破 + 外包线反转（突破模式）
// ---------------------------------------------------------------------------

function detectBreakoutPatterns(input: SignalInput, signals: BrooksSignal[]): void {
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
      if (p.done || i - p.bornIndex > 5) continue
      if (b.close > p.high) {
        p.done = true
        signals.push({
          kind: 'II_BREAKOUT_UP',
          direction: 'bull',
          index: i,
          time: b.time,
          label: 'ii↑',
          title: 'ii 形态向上突破',
          reason: `第 ${p.bornIndex + 1} 根出现连续内包（ii）后，第 ${i + 1} 根收盘 ${fmt(b.close)} 上破形态高点 ${fmt(p.high)}`,
          concept: '《价格行为交易》：ii = 连续两根内包线，突破模式；ii 突破属日内最可靠的突破形态之一',
          prior: 'ii 突破沿突破方向延续的概率显著高于单根内包线',
          strength: 'medium',
          ref: { entry: b.high, stop: p.low },
        })
      } else if (b.close < p.low) {
        p.done = true
        signals.push({
          kind: 'II_BREAKOUT_DOWN',
          direction: 'bear',
          index: i,
          time: b.time,
          label: 'ii↓',
          title: 'ii 形态向下突破',
          reason: `第 ${p.bornIndex + 1} 根出现连续内包（ii）后，第 ${i + 1} 根收盘 ${fmt(b.close)} 跌破形态低点 ${fmt(p.low)}`,
          concept: '《价格行为交易》：ii = 连续两根内包线，突破模式；向下突破常引发空头趋势腿',
          prior: 'ii 突破沿突破方向延续的概率显著高于单根内包线',
          strength: 'medium',
          ref: { entry: b.low, stop: p.high },
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
          label: '外包↑',
          title: '外包线多头反转跟随',
          reason: `第 ${i + 1} 根外包线吞没前一根后，下一根收盘 ${fmt(nx.close)} 站上外包线高点 ${fmt(b.high)}`,
          concept: '《价格行为交易》：外包线（outside bar）之后常出现二次突破（H2/L2），多头跟随确认',
          prior: '外包线后的反向突破可靠性中等，常演变为两段式行情',
          strength: 'low',
          ref: { entry: nx.high, stop: b.low },
        })
      } else if (nx.close < b.low) {
        signals.push({
          kind: 'OB_REVERSAL_DOWN',
          direction: 'bear',
          index: i + 1,
          time: nx.time,
          label: '外包↓',
          title: '外包线空头反转跟随',
          reason: `第 ${i + 1} 根外包线吞没前一根后，下一根收盘 ${fmt(nx.close)} 跌破外包线低点 ${fmt(b.low)}`,
          concept: '《价格行为交易》：外包线（outside bar）之后常出现二次突破（H2/L2），空头跟随确认',
          prior: '外包线后的反向突破可靠性中等，常演变为两段式行情',
          strength: 'low',
          ref: { entry: nx.low, stop: b.high },
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 趋势线突破（TLB）→ 测试 → 主要趋势反转（MTR）
// ---------------------------------------------------------------------------

function detectTrendLineBreaks(input: SignalInput, signals: BrooksSignal[]): void {
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
            label: side === 'bull' ? '破线↓' : '破线↑',
            title: side === 'bull' ? '多头趋势线被收盘跌穿（警戒）' : '空头趋势线被收盘上穿（警戒）',
            reason: `连接摆动${kind === 'low' ? '低点' : '高点'} ${fmt(p1.price)}(第${p1.index + 1}根) 与 ${fmt(p2.price)}(第${p2.index+1}根) 的趋势线，在第 ${i + 1} 根被收盘穿越（线值 ${fmt(lv)}，收盘 ${fmt(bars[i].close)}）`,
            concept: '《高级反转技术分析》：趋势线突破是趋势减弱的第一个信号，但 50% 情况趋势会恢复——需要「测试 + 反转信号」确认',
            prior: '趋势线被突破后：约 50% 最终反转、50% 恢复原趋势',
            strength: 'low',
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
            title: side === 'bull' ? '主要趋势反转（多头 → 空头）' : '主要趋势反转（空头 → 多头）',
            reason: `第 ${brokenIndex + 1} 根趋势线破位${testSeen ? '、出现回测' : ''}后，第 ${i + 1} 根${originBreak ? `收盘 ${fmt(bars[i].close)} 击穿趋势线起点摆动${kind === 'low' ? '低' : '高'}点` : '以强反转趋势棒收盘确认'}，MTR 序列完成`,
            concept: '《高级反转技术分析》MTR：趋势线突破 → 测试 → 反转信号（HL/LH），三者齐备才是主要趋势反转',
            prior: 'MTR 成立后市场约 80% 至少演变为区间，反向两腿是最低预期',
            strength: 'high',
          })
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 交易区间突破（研究关注，80% 失败先验）
// ---------------------------------------------------------------------------

function detectTRBreakouts(input: SignalInput, signals: BrooksSignal[], segments: { from: number; to: number; type: RegimeType }[]): void {
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
          label: '区间破↑',
          title: '交易区间向上突破',
          reason: `第 ${seg.from + 1}~${seg.to + 1} 根构成 ${len} 根交易区间（${fmt(lo)}~${fmt(hi)}），第 ${j + 1} 根以趋势棒收盘 ${fmt(bars[j].close)} 上破区间高点`,
          concept: '《高级区间技术分析》：区间突破需强趋势棒确认；突破后回测区间顶（突破测试）是低风险二次进场',
          prior: '80% 的区间突破尝试失败；首次突破仅约 50% 存活——本信号仅作结构研究',
          strength: 'medium',
          ref: { entry: bars[j].high, stop: hi, target: hi + (hi - lo) },
        })
      } else if (bars[j].close < lo && features[j].isTrendBar) {
        fired = true
        signals.push({
          kind: 'TR_BREAKOUT_DOWN',
          direction: 'bear',
          index: j,
          time: bars[j].time,
          label: '区间破↓',
          title: '交易区间向下突破',
          reason: `第 ${seg.from + 1}~${seg.to + 1} 根构成 ${len} 根交易区间（${fmt(lo)}~${fmt(hi)}），第 ${j + 1} 根以趋势棒收盘 ${fmt(bars[j].close)} 跌破区间低点`,
          concept: '《高级区间技术分析》：区间突破需强趋势棒确认；突破后回测区间底（突破测试）是低风险二次进场',
          prior: '80% 的区间突破尝试失败；首次突破仅约 50% 存活——本信号仅作结构研究',
          strength: 'medium',
          ref: { entry: bars[j].low, stop: lo, target: lo - (hi - lo) },
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------

export function detectSignals(input: SignalInput, segments: { from: number; to: number; type: RegimeType }[]): BrooksSignal[] {
  const signals: BrooksSignal[] = []
  detectHL(input, signals)
  detectSpikes(input, signals)
  detectWedges(input, signals)
  detectDoubles(input, signals)
  detectBreakoutPatterns(input, signals)
  detectTrendLineBreaks(input, signals)
  detectTRBreakouts(input, signals, segments)

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
  return out
}
