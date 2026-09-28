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
 */

import type { BarFeature, AlwaysIn, Direction, RegimeType, RegimeSegment } from './types.js'

const WINDOW = 20
const BULL_RATIO = 0.7
const BEAR_RATIO = 0.3
const SPIKE_BARS = 5
const SPIKE_RANGE_ATR = 1.5
const TIGHT_COVER = 1.5

export function computeRegime(
  features: BarFeature[],
  ema20: number[],
  atr14: number[],
): { perBar: RegimeType[]; segments: RegimeSegment[] } {
  const n = features.length
  const perBar: RegimeType[] = new Array(n).fill('trading_range')

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
      perBar[i] = hasDoji ? 'barbwire' : 'tight_range'
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
        perBar[i] = runDir === 'up' ? 'spike_bull' : 'spike_bear'
        continue
      }
    }

    // EMA20 一侧占比：趋势通道 / 震荡
    let above = 0
    for (let j = i - WINDOW + 1; j <= i; j++) {
      if (features[j].close > ema20[j]) above++
    }
    const ratio = above / WINDOW
    if (ratio >= BULL_RATIO) perBar[i] = 'channel_bull'
    else if (ratio <= BEAR_RATIO) perBar[i] = 'channel_bear'
    else perBar[i] = 'trading_range'
  }

  despeckle(perBar)
  const segments = toSegments(perBar)
  return { perBar, segments }
}

/** 单根毛刺平滑：与前后都不同的孤立状态并入前一段 */
function despeckle(types: RegimeType[]): void {
  for (let i = 1; i < types.length - 1; i++) {
    if (types[i] !== types[i - 1] && types[i] !== types[i + 1]) types[i] = types[i - 1]
  }
}

function toSegments(perBar: RegimeType[]): RegimeSegment[] {
  const segments: RegimeSegment[] = []
  for (let i = 0; i < perBar.length; i++) {
    const last = segments[segments.length - 1]
    if (last && last.type === perBar[i]) last.to = i
    else segments.push({ from: i, to: i, type: perBar[i] })
  }
  return segments
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
