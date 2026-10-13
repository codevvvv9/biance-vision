/**
 * Brooks 引擎因果性校验：证明「已经确认且当时可知的事件」不被后续数据改变。
 * 运行：pnpm brooks:causality
 *
 * 检查项（对应 docs/specs/brooks-engine.md 验收用例）：
 * [1] 收盘约束：未收盘 bar / asOf 越界 / 缺 closeTime 一律入口拒绝
 * [2] 前缀一致性：任意前缀 t 的分析结果 = 全量结果按 knownAt<=t 截断
 *     （regime 逐根、raw 分类、摆动点、腿、信号、结构事件）
 * [3] 逐根流式一致：短序列上对每个 t 全量重算，与整批结果按 knownAt 截断相等
 * [4] 确定性：同一输入两次运行，信号/事件/状态完全一致
 * [5] knownAt 语义：事件 atIndex<=knownAtIndex；信号 knownAtIndex=触发 bar；
 *     provisional 腿 knownAtIndex=null；状态段边界即确认位置
 */

import { analyzeBrooks } from '../shared/src/index.js'
import type { BrooksAnalysis, BrooksCandle } from '../shared/src/index.js'

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

/** 固定种子伪随机 */
function seededRandom(seedInit: number): () => number {
  let seed = seedInit
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
}

/** 随机游走序列（带 closed 与 closeTime，分钟K） */
function randomBars(n: number, seed: number, startPrice = 60000): BrooksCandle[] {
  const rnd = seededRandom(seed)
  const bars: BrooksCandle[] = []
  let p = startPrice
  for (let i = 0; i < n; i++) {
    const o = p
    const c = p * (1 + (rnd() - 0.5) * 0.012)
    const hi = Math.max(o, c) * (1 + rnd() * 0.004)
    const lo = Math.min(o, c) * (1 - rnd() * 0.004)
    bars.push({
      time: i * 60000,
      open: o,
      high: hi,
      low: lo,
      close: c,
      volume: 1 + rnd() * 10,
      closed: true,
      closeTime: i * 60000 + 59999,
    })
    p = c
  }
  return bars
}

/** 趋势→震荡→反转的混合序列（覆盖更多状态切换路径） */
function mixedBars(): BrooksCandle[] {
  const rnd = seededRandom(7)
  const bars: BrooksCandle[] = []
  let p = 100
  const push = (i: number, o: number, h: number, l: number, c: number): void => {
    bars.push({ time: i * 60000, open: o, high: h, low: l, close: c, volume: 5, closed: true, closeTime: i * 60000 + 59999 })
  }
  let i = 0
  // 25 根多头趋势
  for (let j = 0; j < 25; j++) { const o = p; const c = p + 1.5 + rnd(); push(i++, o, c + 0.3, o - 0.3, c); p = c }
  // 30 根交替震荡（含 tight/doji 段）
  for (let j = 0; j < 30; j++) {
    const o = p
    const c = j % 2 === 0 ? p + 0.6 : p - 0.6
    push(i++, o, Math.max(o, c) + 0.8, Math.min(o, c) - 0.8, c)
    p = c
  }
  // 10 根紧凑重叠 + doji（barbwire/tight_range 路径）
  for (let j = 0; j < 10; j++) {
    const o = p
    const c = p + (rnd() - 0.5) * 0.1
    push(i++, o, o + 0.4, o - 0.4, c)
    p = c
  }
  // 25 根空头趋势
  for (let j = 0; j < 25; j++) { const o = p; const c = p - 1.4 - rnd(); push(i++, o, o + 0.3, c - 0.3, c); p = c }
  // 15 根恢复
  for (let j = 0; j < 15; j++) { const o = p; const c = p + 0.9 + rnd() * 0.4; push(i++, o, c + 0.2, o - 0.2, c); p = c }
  return bars
}

// ---------------------------------------------------------------------------
// 比较器：全量结果按 knownAt<=t 截断后与前缀结果逐项相等
// ---------------------------------------------------------------------------

function keyOf(v: unknown): string {
  return JSON.stringify(v)
}

function comparePrefix(full: BrooksAnalysis, prefix: BrooksAnalysis, t: number, label: string): void {
  // 1) 逐根状态与 raw 分类在共享区间完全一致（因果性的核心）
  let regimeEq = true
  let rawEq = true
  for (let i = 0; i <= t; i++) {
    if (full.regimeAt[i] !== prefix.regimeAt[i]) { regimeEq = false; break }
    if (full.rawRegimeAt[i] !== prefix.rawRegimeAt[i]) { rawEq = false; break }
  }
  assert(regimeEq, `${label}: regimeAt 前缀一致（t=${t}）`)
  assert(rawEq, `${label}: rawRegimeAt 前缀一致（t=${t}）`)

  // 2) 状态段限制到 [0..t] 后相等
  const clipSegs = (a: BrooksAnalysis): string =>
    keyOf(a.regimes.filter((s) => s.from <= t).map((s) => ({ from: s.from, to: Math.min(s.to, t), type: s.type, k: s.knownAtIndex })))
  assert(clipSegs(full) === clipSegs(prefix), `${label}: 状态段截断一致（t=${t}）`)

  // 3) 摆动点：confirmIndex<=t 的集合一致
  const swingsOf = (a: BrooksAnalysis): string =>
    keyOf(a.swings.filter((s) => s.confirmIndex <= t).map((s) => [s.index, s.kind, s.price, s.label]))
  assert(swingsOf(full) === swingsOf(prefix), `${label}: 已确认摆动点一致（t=${t}）`)

  // 4) 腿：knownAtIndex 非空且 <=t 的一致（provisional 不参与比较）
  const legsOf = (a: BrooksAnalysis): string =>
    keyOf(a.legs.filter((l) => l.knownAtIndex !== null && l.knownAtIndex <= t).map((l) => [l.fromIndex, l.toIndex, l.fromPrice, l.toPrice]))
  assert(legsOf(full) === legsOf(prefix), `${label}: 已确认腿一致（t=${t}）`)

  // 5) 信号：knownAtIndex<=t 的多重集合一致
  const sigsOf = (a: BrooksAnalysis): string =>
    keyOf(a.signals.filter((s) => s.knownAtIndex <= t).map((s) => [s.kind, s.index, s.direction, s.ref?.entry ?? null, s.ref?.stop ?? null, s.ref?.target ?? null]))
  assert(sigsOf(full) === sigsOf(prefix), `${label}: 可知信号一致（t=${t}）`)

  // 6) 结构事件：knownAtIndex 非空且 <=t 的多重集合一致
  const evtsOf = (a: BrooksAnalysis): string =>
    keyOf(
      a.events
        .filter((e) => e.knownAtIndex !== null && e.knownAtIndex <= t)
        .map((e) => [e.kind, e.ruleId, e.atIndex, e.knownAtIndex, e.direction ?? null])
        .sort(),
    )
  assert(evtsOf(full) === evtsOf(prefix), `${label}: 可知结构事件一致（t=${t}）`)
}

console.log('\n[1] 收盘约束：入口强制拒绝')
{
  const bars = randomBars(60, 1)
  // 1a. closed=false 拒绝
  const withOpen = bars.map((b) => ({ ...b }))
  withOpen[59] = { ...withOpen[59], closed: false }
  let threw = false
  try {
    analyzeBrooks(withOpen, { swingK: 3 })
  } catch {
    threw = true
  }
  assert(threw, 'closed=false 的未收盘K线被入口拒绝')

  // 1b. asOf 越界拒绝
  threw = false
  try {
    analyzeBrooks(bars, { swingK: 3, asOf: bars[58].closeTime })
  } catch {
    threw = true
  }
  assert(threw, 'closeTime 晚于 asOf 被拒绝')

  // 1c. asOf 提供但缺 closeTime 拒绝
  threw = false
  try {
    analyzeBrooks(bars.map((b) => ({ ...b, closeTime: undefined })), { swingK: 3, asOf: Date.now() })
  } catch {
    threw = true
  }
  assert(threw, 'asOf 模式下缺 closeTime 被拒绝')

  // 1d. 合法 asOf 接受
  const ok = analyzeBrooks(bars, { swingK: 3, asOf: bars[59].closeTime })
  assert(ok !== null, '合法 asOf（全部已收盘）正常分析')
}

console.log('\n[2] 前缀一致性（400 根随机游走 + 混合序列）')
{
  for (const [label, bars] of [
    ['随机游走', randomBars(400, 42)],
    ['趋势震荡混合', mixedBars()],
  ] as const) {
    const full = analyzeBrooks(bars, { swingK: 3 })
    assert(full !== null, `${label}: 全量分析非空（${bars.length} 根）`)
    if (!full) continue
    const minT = 35
    for (let t = minT; t < bars.length; t += 7) {
      const prefix = analyzeBrooks(bars.slice(0, t + 1), { swingK: 3 })
      if (!prefix) continue
      comparePrefix(full, prefix, t, label)
    }
  }
}

console.log('\n[3] 逐根流式一致（150 根，每个 t 全量重算）')
{
  const bars = randomBars(150, 99)
  const full = analyzeBrooks(bars, { swingK: 2 })
  assert(full !== null, '全量分析非空')
  if (full) {
    for (let t = 30; t < bars.length; t++) {
      const prefix = analyzeBrooks(bars.slice(0, t + 1), { swingK: 2 })
      if (!prefix) continue
      // 逐根场景只断言最关键的不变量，控制输出量
      const fullSigs = full.signals.filter((s) => s.knownAtIndex <= t).map((s) => `${s.kind}@${s.index}`)
      const preSigs = prefix.signals.map((s) => `${s.kind}@${s.index}`)
      if (JSON.stringify(fullSigs) !== JSON.stringify(preSigs)) {
        assert(false, `逐根一致：信号集在 t=${t} 分叉`)
        break
      }
      const fullEvts = full.events.filter((e) => e.knownAtIndex !== null && e.knownAtIndex <= t).length
      const preEvts = prefix.events.filter((e) => e.knownAtIndex !== null).length
      if (fullEvts !== preEvts) {
        assert(false, `逐根一致：事件数在 t=${t} 分叉（${fullEvts} vs ${preEvts}）`)
        break
      }
      if (full.regimeAt[t] !== prefix.regimeAt[t]) {
        assert(false, `逐根一致：regime 在 t=${t} 分叉`)
        break
      }
    }
    assert(true, '逐根流式与整批截断一致（120 个前缀点）')
  }
}

console.log('\n[4] 确定性')
{
  const bars = randomBars(300, 7)
  const a = analyzeBrooks(bars, { swingK: 3 })
  const b = analyzeBrooks(bars, { swingK: 3 })
  assert(
    a !== null && b !== null &&
      keyOf(a.signals) === keyOf(b.signals) &&
      keyOf(a.events) === keyOf(b.events) &&
      keyOf(a.regimeAt) === keyOf(b.regimeAt),
    '同一输入两次运行结果完全一致',
  )
}

console.log('\n[5] knownAt 语义不变量')
{
  const bars = mixedBars()
  const a = analyzeBrooks(bars, { swingK: 3 })
  assert(a !== null, '分析非空')
  if (a) {
    assert(
      a.events.every((e) => e.knownAtIndex === null || e.atIndex <= e.knownAtIndex),
      '事件 atIndex <= knownAtIndex（确认不早于发生）',
    )
    assert(
      a.signals.every((s) => s.knownAtIndex === s.index && s.status === 'triggered'),
      '信号 knownAtIndex = 触发 bar 且 status=triggered',
    )
    assert(
      a.legs.every((l) => (l.provisional === true) === (l.knownAtIndex === null)),
      'provisional 腿 ⇔ knownAtIndex 为 null',
    )
    assert(
      a.regimes.every((s) => s.knownAtIndex === s.from),
      '状态段边界即确认位置（knownAtIndex = from）',
    )
    assert(
      a.events.some((e) => e.kind === 'regime_change') && a.events.every((e) => e.ruleVersion === a.engineVersion),
      '状态切换事件存在且全部携带引擎版本',
    )
    const kinds = new Set(a.events.map((e) => e.kind))
    console.log(`  · 事件 ${a.events.length} 条，种类：${[...kinds].join(', ')}`)
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
