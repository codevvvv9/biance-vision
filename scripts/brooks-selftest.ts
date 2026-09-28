/**
 * Brooks 价格行为引擎自测：用手工构造的合成K线验证各规则触发是否正确。
 * 运行：pnpm brooks:selftest
 */

import { analyzeBrooks, computeBarFeatures } from '../shared/src/index.js'
import type { BrooksCandle } from '../shared/src/index.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✅ PASS  ${msg}`)
  } else {
    failed++
    console.error(`  ❌ FAIL  ${msg}`)
  }
}

/** 构造单根K线（时间 = index × 60000ms） */
function mk(i: number, open: number, high: number, low: number, close: number): BrooksCandle {
  return { time: i * 60000, open, high, low, close, volume: 100, closed: true }
}

/** 生成一段单向趋势腿：每根实体占比 ~75% 的趋势棒 */
function leg(fromIdx: number, count: number, start: number, end: number): BrooksCandle[] {
  const out: BrooksCandle[] = []
  const step = (end - start) / count
  for (let j = 0; j < count; j++) {
    const o = start + step * j
    const c = start + step * (j + 1)
    const up = c > o
    const hi = up ? c + Math.abs(step) * 0.1 : o + Math.abs(step) * 0.1
    const lo = up ? o - Math.abs(step) * 0.1 : c - Math.abs(step) * 0.1
    out.push(mk(fromIdx + j, o, hi, lo, c))
  }
  return out
}

console.log('\n[1] 内包/外包/ii/序列形态')
{
  const bars = [
    mk(0, 10, 12, 8, 11),
    mk(1, 10.5, 11.5, 8.5, 11), // inside(0)
    mk(2, 10.8, 11.2, 8.8, 11), // inside(1) → ii
    mk(3, 11, 12.4, 8.2, 12.1), // outside(2)
  ]
  const f = computeBarFeatures(bars)
  assert(f[1].isInside, '第2根为内包线')
  assert(f[2].isInside && f[2].isII, '第3根内包且构成 ii')
  assert(f[3].isOutside, '第4根为外包线')
}

console.log('\n[2] 摆动点检测 + HH/HL 标注（k=3）')
{
  const bars = [
    ...leg(0, 10, 50, 100),
    ...leg(10, 5, 100, 80),
    ...leg(15, 6, 80, 105),
    ...leg(21, 5, 105, 82),
    ...leg(26, 4, 82, 106),
    ...leg(30, 5, 106, 95),
  ]
  const a = analyzeBrooks(bars, { swingK: 3 })
  assert(a !== null, '分析结果非空')
  if (a) {
    const highs = a.swings.filter((s) => s.kind === 'high')
    const lows = a.swings.filter((s) => s.kind === 'low')
    assert(highs.length >= 2, `检出 ≥2 个摆动高点（实际 ${highs.length}）`)
    assert(lows.length >= 2, `检出 ≥2 个摆动低点（实际 ${lows.length}）`)
    assert(highs.some((s) => s.label === 'HH'), '第二高点标注 HH')
    assert(lows.some((s) => s.label === 'HL'), '第二低点标注 HL')
    assert(a.legs.length >= 4, `zigzag 腿 ≥4 条（实际 ${a.legs.length}）`)
    // 每条腿首尾方向一致
    const okLegs = a.legs.every((l) =>
      l.direction === 'up' ? l.toPrice > l.fromPrice : l.toPrice < l.fromPrice,
    )
    assert(okLegs, '所有腿方向与价格一致（高低点交替）')
  }
}

console.log('\n[3] 趋势 vs 震荡状态')
{
  const trend = leg(0, 40, 50, 130) // 40 根强多头
  const at = analyzeBrooks(trend, { swingK: 3 })
  assert(at !== null, '趋势数据分析非空')
  if (at) {
    const last = at.regimeAt[at.regimeAt.length - 1]
    assert(last === 'channel_bull' || last === 'spike_bull', `40根强多头末端状态为多头（实际 ${last}）`)
    assert(at.alwaysIn.direction === 'bull', 'Always In = 多头')
  }

  // 震荡：高低交替、大幅重叠
  const chop: BrooksCandle[] = []
  let p = 100
  for (let i = 0; i < 60; i++) {
    const up = i % 2 === 0
    const o = p
    const c = up ? p + 1 : p - 1
    const hi = Math.max(o, c) + 1.2
    const lo = Math.min(o, c) - 1.2
    chop.push(mk(i, o, hi, lo, c))
    p = c
  }
  const ac = analyzeBrooks(chop, { swingK: 3 })
  assert(ac !== null, '震荡数据分析非空')
  if (ac) {
    const last = ac.regimeAt[ac.regimeAt.length - 1]
    assert(last === 'trading_range' || last === 'tight_range' || last === 'barbwire', `交替重叠K线末端为震荡类（实际 ${last}）`)
  }
}

console.log('\n[4] H1/H2 回调计数状态机')
{
  // 先造 26 根多头趋势（价格 50→100），再手动造一次两段式回调
  const bars = leg(0, 26, 50, 100)
  // 回调：三根更低高点的阴线（低点抬高），再一根上破前高 → H1
  bars.push(mk(26, 100, 99.4, 97.5, 98.0))
  bars.push(mk(27, 98.0, 98.9, 97.2, 97.6))
  bars.push(mk(28, 97.6, 99.6, 97.4, 99.3)) // 上破 98.9 → H1
  // H1 失败：继续回调，再上破 → H2
  bars.push(mk(29, 99.3, 99.2, 97.8, 98.2)) // 更低高点 → 回调
  bars.push(mk(30, 98.2, 98.8, 97.9, 98.4))
  bars.push(mk(31, 98.4, 99.3, 98.0, 99.1)) // 上破 98.8 → H2
  const a = analyzeBrooks(bars, { swingK: 3 })
  assert(a !== null, '分析非空')
  if (a) {
    const h = a.signals.filter((s) => s.kind.startsWith('H'))
    assert(h.some((s) => s.kind === 'H1'), `检出 H1（实际信号 ${h.map((s) => s.kind).join(',') || '无'}）`)
    assert(h.some((s) => s.kind === 'H2'), '检出 H2')
    const h2 = h.find((s) => s.kind === 'H2')
    assert(h2 !== undefined && h2.index === 31, `H2 落在第32根（实际 ${h2 ? h2.index + 1 : '无'}）`)
    // 止损参考 = 本段回调（第30~32根）的最低点 97.8
    assert(
      h2 !== undefined && h2.ref !== undefined && h2.ref.stop !== undefined && h2.ref.stop > 97.5 && h2.ref.stop <= 97.8,
      'H2 止损参考 = 本段回调低点',
    )
  }
}

console.log('\n[5] 楔形顶（三推）')
{
  const bars = [
    ...leg(0, 10, 50, 100),
    ...leg(10, 4, 100, 88),
    ...leg(14, 10, 88, 102),
    ...leg(24, 4, 102, 94), // 第二段回调只回到 94（高于前低 88）
    ...leg(28, 8, 94, 103), // 第三推 94→103，幅度 9 < 第一推 14（衰竭）
    ...leg(36, 5, 103, 95),
  ]
  const a = analyzeBrooks(bars, { swingK: 3 })
  assert(a !== null, '分析非空')
  if (a) {
    const w = a.signals.find((s) => s.kind === 'WEDGE_TOP')
    assert(w !== undefined, '检出楔形顶信号')
    if (w) {
      assert(w.direction === 'bear', '楔形顶为空头反转信号')
      assert(w.strength === 'high', '第三推动能衰减 → high 强度')
    }
  }
}

console.log('\n[6] 双底')
{
  const bars = [
    ...leg(0, 10, 100, 80), // 下跌到 80
    ...leg(10, 10, 80, 92), // 反弹
    ...leg(20, 10, 92, 80.3), // 第二次下探 80.3（等低）
    ...leg(30, 8, 80.3, 88),
  ]
  const a = analyzeBrooks(bars, { swingK: 3 })
  assert(a !== null, '分析非空')
  if (a) {
    const d = a.signals.find((s) => s.kind === 'DOUBLE_BOTTOM')
    assert(d !== undefined, '检出双底信号（容差 0.3×ATR）')
    if (d) assert(d.direction === 'bull', '双底为多头信号')
  }
}

console.log('\n[7] ii 向上突破')
{
  const bars = [
    ...leg(0, 30, 50, 90), // 多头环境
    mk(30, 90, 91, 89, 90.5),
    mk(31, 90.4, 91, 89.5, 90.6), // inside
    mk(32, 90.5, 90.8, 89.8, 90.7), // inside → ii
    mk(33, 90.7, 91.8, 90.4, 91.6), // 收盘 91.6 > 91 上破
  ]
  const a = analyzeBrooks(bars, { swingK: 3 })
  assert(a !== null, '分析非空')
  if (a) {
    const s = a.signals.find((x) => x.kind === 'II_BREAKOUT_UP')
    assert(s !== undefined, '检出 ii 向上突破')
    if (s) assert(s.index === 33, `突破信号落在第34根（实际 ${s.index + 1}）`)
  }
}

console.log('\n[8] 趋势线突破（TLB）')
{
  // 阶梯上涨（摆动低点 55→60→65 依次抬升），随后急跌破线
  const bars = [
    ...leg(0, 6, 50, 58),
    ...leg(6, 3, 58, 55),
    ...leg(9, 6, 55, 63),
    ...leg(15, 3, 63, 60),
    ...leg(18, 6, 60, 68),
    ...leg(24, 3, 68, 65),
    ...leg(27, 6, 65, 73),
    ...leg(33, 6, 73, 58), // 崩落跌穿趋势线
  ]
  const a = analyzeBrooks(bars, { swingK: 3 })
  assert(a !== null, '分析非空')
  if (a) {
    const tlb = a.signals.find((x) => x.kind === 'TLB_BEAR')
    assert(tlb !== undefined, '检出多头趋势线破位（TLB）')
  }
}

console.log('\n[9] 全流程冒烟：真实尺寸随机数据不崩溃')
{
  const bars: BrooksCandle[] = []
  let p = 60000
  let seed = 42
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (let i = 0; i < 1000; i++) {
    const o = p
    const c = p * (1 + (rnd() - 0.5) * 0.01)
    const hi = Math.max(o, c) * (1 + rnd() * 0.004)
    const lo = Math.min(o, c) * (1 - rnd() * 0.004)
    bars.push({ time: i * 60000, open: o, high: hi, low: lo, close: c, volume: 1, closed: true })
    p = c
  }
  const a = analyzeBrooks(bars, { swingK: 3 })
  assert(a !== null, '1000 根随机数据完成分析')
  if (a) {
    assert(a.swings.length > 20 && a.swings.length < 500, `摆动点数量合理（实际 ${a.swings.length}）`)
    assert(a.signals.length > 0 && a.signals.length < 400, `信号数量合理（实际 ${a.signals.length}）`)
    assert(a.legs.every((l) => l.barCount >= 1), '腿根数 ≥1')
    console.log(`  · 摆动 ${a.swings.length} · 腿 ${a.legs.length} · 信号 ${a.signals.length} · 状态 ${a.summary.regime} · AI ${a.summary.alwaysIn}`)
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
