/**
 * 市场状态层：趋势 / 震荡分类 + Always In 方向。
 *
 * 量化依据（调研共识）：
 * - 「过去 10~20 根收盘价大部分位于 EMA20 一侧 = 趋势」（Brooks《高级趋势技术分析》）
 *   AxisJu 用 15 根窗口 ≥11/19 之多头；此处用 20 根窗口，≥70% 多头、≤30% 空头、中间为震荡。
 * - Spike（冲刺）：≥5 根连续同向趋势棒且累计幅度 ≥1.5×ATR（spike and channel 的 spike 腿）。
 * - Tight trading range：最近 3 根的总覆盖幅度 ≤1.5×单根最大幅度（大部分重叠）；
 *   其中含 doji 即 barbwire（铁丝网，Brooks 明确建议不交易）。
 * - Always In：保守翻转——同向状态持续 ≥4 根才翻转方向（Brooks：always-in 交易者一天只翻 2~5 次）。
 *
 * 因果性（替代旧 despeckle 的未来读取）：
 * 原始逐根分类 raw 本身只依赖 ≤i 的数据；状态翻转采用「两根确认」因果状态机——
 * raw 连续两根同为新状态才确认翻转（确认 bar 即 knownAtIndex），孤立毛刺被自然丢弃，
 * 不需要读取 i+1。perBar[i] 只依赖 ≤i 的收盘数据，前缀输入的结果是全量结果的严格前缀。
 */

import type { AlwaysIn, BarFeature, Direction, RegimeSegment, RegimeType, StructureEvent } from './types.js'

const WINDOW = 20
const BULL_RATIO = 0.7
const BEAR_RATIO = 0.3
const SPIKE_BARS = 5
const SPIKE_RANGE_ATR = 1.5
const TIGHT_COVER = 1.5

export interface RegimeChange {
  type: RegimeType
  /** raw 分类首次翻转的位置（状态实际开始处） */
  atIndex: number
  /** 连续两根确认的位置（可知时间） */
  knownAtIndex: number
}

export interface RegimeResult {
  /** 原始逐根分类（因果，未平滑） */
  raw: RegimeType[]
  /** 因果确认后的逐根状态 */
  perBar: RegimeType[]
  /** 每根正在观察中的候选状态（null = 无） */
  pendingAt: (RegimeType | null)[]
  segments: RegimeSegment[]
  changes: RegimeChange[]
}

export function computeRegime(
  features: BarFeature[],
  ema20: number[],
  atr14: number[],
): RegimeResult {
  const n = features.length
  const raw: RegimeType[] = new Array(n).fill('trading_range')

  for (let i = 0; i < n; i++) {
    if (i < WINDOW) continue

    // 最近 3 根的紧凑重叠判定（TTR / barbwire）
    const f3 = [features[i], features[i - 1], features[i - 2]]
    const maxH = Math.max(...f3.map((f) => f.high))
    const minL = Math.min(...f3.map((f) => f.low))
    const maxBarRange = Math.max(...f3.map((f) => f.range))
    const tight = maxBarRange > 0 && maxH - minL <= TIGHT_COVER * maxBarRange
    const hasDoji = f3.some((f) => f.isDoji)
    if (tight) {
      raw[i] = hasDoji ? 'barbwire' : 'tight_range'
      continue
    }

    // 冲刺：从 i 往回数连续同向趋势棒
    let runDir: 'up' | 'down' | null = null
    let runLen = 0
    let runHigh = features[i].high
    let runLow = features[i].low
    for (let j = i; j >= 0; j--) {
      const f = features[j]
      const d = f.barDir
      if (!f.isTrendBar || d === 'flat') break
      if (runDir === null) runDir = d
      else if (d !== runDir) break
      runLen++
      runHigh = Math.max(runHigh, f.high)
      runLow = Math.min(runLow, f.low)
      if (runLen >= SPIKE_BARS) break
    }
    if (runLen >= SPIKE_BARS && runDir !== null) {
      const a = atr14[i] > 0 ? atr14[i] : 1e-9
      if (runHigh - runLow >= SPIKE_RANGE_ATR * a) {
        raw[i] = runDir === 'up' ? 'spike_bull' : 'spike_bear'
        continue
      }
    }

    // EMA20 一侧占比：趋势通道 / 震荡
    let above = 0
    for (let j = i - WINDOW + 1; j <= i; j++) {
      if (features[j].close > ema20[j]) above++
    }
    const ratio = above / WINDOW
    if (ratio >= BULL_RATIO) raw[i] = 'channel_bull'
    else if (ratio <= BEAR_RATIO) raw[i] = 'channel_bear'
    else raw[i] = 'trading_range'
  }

  const { perBar, pendingAt, changes } = confirmCausal(raw)
  const segments = toSegments(perBar)
  return { raw, perBar, pendingAt, segments, changes }
}

/**
 * 因果两根确认状态机：raw 连续两根同为新状态时确认翻转。
 * perBar[i] 只依赖 raw[0..i]；孤立单根毛刺（A A B A）不会翻转状态，
 * 等价于旧 despeckle 的平滑意图，但不读取任何未来数据。
 */
function confirmCausal(raw: RegimeType[]): {
  perBar: RegimeType[]
  pendingAt: (RegimeType | null)[]
  changes: RegimeChange[]
} {
  const n = raw.length
  const perBar = new Array<RegimeType>(n)
  const pendingAt = new Array<RegimeType | null>(n).fill(null)
  const changes: RegimeChange[] = []
  if (n === 0) return { perBar, pendingAt, changes }

  let current = raw[0]
  let pending: RegimeType | null = null
  let pendingSince = -1
  perBar[0] = current

  for (let i = 1; i < n; i++) {
    const r = raw[i]
    if (r === current) {
      pending = null
      pendingSince = -1
      perBar[i] = current
      continue
    }
    if (pending === r) {
      changes.push({ type: r, atIndex: pendingSince, knownAtIndex: i })
      current = r
      pending = null
      pendingSince = -1
      perBar[i] = r
      continue
    }
    pending = r
    pendingSince = i
    perBar[i] = current
    pendingAt[i] = r
  }
  return { perBar, pendingAt, changes }
}

function toSegments(perBar: RegimeType[]): RegimeSegment[] {
  const segments: RegimeSegment[] = []
  for (let i = 0; i < perBar.length; i++) {
    const last = segments[segments.length - 1]
    if (last && last.type === perBar[i]) last.to = i
    // 因果状态机下段边界只出现在确认 bar 上：knownAtIndex 恒等于 from
    else segments.push({ from: i, to: i, type: perBar[i], knownAtIndex: i })
  }
  return segments
}

/** 把状态确认记录转成统一结构事件（在 analyze 层合并进事件流） */
export function regimeChangeEvents(
  changes: RegimeChange[],
  bars: { time: number }[],
  ruleVersion: string,
): StructureEvent[] {
  return changes.map((c) => ({
    kind: 'regime_change' as const,
    ruleId: 'regime.confirm',
    ruleVersion,
    atIndex: c.atIndex,
    atTime: bars[c.atIndex]?.time ?? 0,
    knownAtIndex: c.knownAtIndex,
    knownAtTime: bars[c.knownAtIndex]?.time ?? null,
    barIndices: [c.atIndex, c.knownAtIndex],
    note: `市场状态确认为 ${c.type}（raw 自第 ${c.atIndex + 1} 根翻转，第 ${c.knownAtIndex + 1} 根收盘确认）`,
  }))
}

const REGIME_DIR: Partial<Record<RegimeType, Direction>> = {
  spike_bull: 'bull',
  channel_bull: 'bull',
  spike_bear: 'bear',
  channel_bear: 'bear',
}

/** Always In：同向状态连续 ≥4 根才翻转；翻转时记录原因 */
export function computeAlwaysIn(perBar: RegimeType[], features: BarFeature[]): AlwaysIn {
  let direction: Direction = 'neutral'
  let sinceIndex = 0
  let reason = '初始状态未定（数据不足或处于震荡）'
  const history: AlwaysIn['history'] = []

  let consecDir: Direction = 'neutral'
  let consecCount = 0
  for (let i = 0; i < perBar.length; i++) {
    const d = REGIME_DIR[perBar[i]] ?? null
    if (d === null) {
      consecDir = 'neutral'
      consecCount = 0
      continue
    }
    if (d === consecDir) consecCount++
    else {
      consecDir = d
      consecCount = 1
    }
    // 冲刺状态说服力更强：连续 2 根 spike 即可翻转
    const spike = perBar[i] === 'spike_bull' || perBar[i] === 'spike_bear'
    const need = spike ? 2 : 4
    if (consecCount >= need && d !== direction) {
      direction = d
      sinceIndex = i
      const isSpike = perBar[i].startsWith('spike')
      reason = isSpike
        ? `${d === 'bull' ? '多头' : '空头'}冲刺（连续同向强趋势棒）确立新方向`
        : `${d === 'bull' ? '多头' : '空头'}趋势环境持续 ≥${consecCount} 根（收盘价持续位于 EMA20 ${d === 'bull' ? '上方' : '下方'}）`
      history.push({ index: i, time: features[i]?.time ?? 0, direction: d, reason })
      // 翻转后重新计数，避免抖动
      consecCount = 0
      consecDir = 'neutral'
    }
  }
  return { direction, sinceIndex, reason, history }
}

export const REGIME_TEXT: Record<RegimeType, string> = {
  spike_bull: '多头冲刺（Spike）：连续强趋势棒上攻',
  channel_bull: '多头通道：收盘价大部分位于 EMA20 上方',
  spike_bear: '空头冲刺（Spike）：连续强趋势棒下杀',
  channel_bear: '空头通道：收盘价大部分位于 EMA20 下方',
  trading_range: '交易区间（震荡）：多空拉锯，80% 突破尝试失败',
  tight_range: '紧凑交易区间：K线大幅重叠，突破质量差',
  barbwire: '铁丝网（Barbwire）：重叠+doji，Brooks 建议不交易',
}
