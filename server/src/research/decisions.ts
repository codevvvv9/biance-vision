/**
 * 研究决策纯函数（docs/specs/perpetual.md、event-contracts.md）：
 * - perp：持仓方向（long/short）与多数 always-in 方向（bull/bear/neutral）经
 *   方向映射后比较——多头×多头趋势=hold，逆势=reduce，中性=hold（不可比字符串）；
 * - event：conditional_entry 必须同时满足 期限匹配 + 概率可用 + 期望净收益 EV>0，
 *   任一不满足 → wait（把「EV>0 才参与」落实为代码规则，而非文案）。
 */
export type PerpSide = 'long' | 'short'
export type MarketDirection = 'bull' | 'bear' | 'neutral'

/** bull/bear 计数 → 严格多数方向（平票=neutral，不偏向多头） */
export function majorityDirection(dirs: string[]): MarketDirection {
  const bull = dirs.filter((d) => d === 'bull').length
  const bear = dirs.filter((d) => d === 'bear').length
  if (dirs.length === 0) return 'neutral'
  if (bull > dirs.length / 2) return 'bull'
  if (bear > dirs.length / 2) return 'bear'
  return 'neutral'
}

export type PerpDecision = 'hold' | 'reduce' | 'exit'

/** 有持仓时的动作：顺势持有；逆势减仓；中性持有（等待确认）。 */
export function decidePerpWithPosition(side: PerpSide, market: MarketDirection): PerpDecision {
  const positionDir: MarketDirection = side === 'long' ? 'bull' : 'bear'
  if (market === 'neutral') return 'hold'
  return market === positionDir ? 'hold' : 'reduce'
}

export interface EventDecisionInput {
  horizonMatched: boolean
  /** P(到期结算价高于执行价)，来自统计模块；不可用为 null */
  probabilityUp: number | null
  /** 期望净收益（与 probability 同源计算）；不可用为 null */
  expectedNet: number | null
}

export type EventDecision = 'conditional_entry' | 'wait'

/** 条件参与门槛：期限匹配 ∧ 概率可用 ∧ EV>0；否则 wait。 */
export function decideEvent(input: EventDecisionInput): EventDecision {
  if (!input.horizonMatched) return 'wait'
  if (input.probabilityUp === null || input.expectedNet === null) return 'wait'
  return input.expectedNet > 0 ? 'conditional_entry' : 'wait'
}

/**
 * 从分位数曲线计算 P(收益 > 阈值)：分位点（升序）→ 预测收益，
 * 线性插值出 F(threshold)，P = 1 − F；曲线未覆盖时按边界截断。
 * 事件合约预测目标是「到期结算价是否高于执行价」：threshold = strike/entry − 1，
 * 不是「从现在起涨跌」（threshold=0 仅在无执行价场景使用）。
 */
export function probAboveFromQuantiles(
  quantiles: Record<string, number>,
  threshold: number,
): number {
  const pts = Object.entries(quantiles)
    .map(([k, v]) => ({ q: Number(k), v }))
    .filter((p) => Number.isFinite(p.q) && Number.isFinite(p.v))
    .sort((a, b) => a.q - b.q)
  if (pts.length === 0) return 0.5
  if (pts.length === 1) return pts[0].v > threshold ? 1 - pts[0].q : pts[0].q
  if (threshold <= pts[0].v) return Math.max(0, 1 - pts[0].q)
  if (threshold >= pts[pts.length - 1].v) return Math.max(0, 1 - pts[pts.length - 1].q)
  for (let i = 1; i < pts.length; i++) {
    if (threshold <= pts[i].v) {
      const span = pts[i].v - pts[i - 1].v
      const frac = span > 0 ? (threshold - pts[i - 1].v) / span : 0
      const f = pts[i - 1].q + frac * (pts[i].q - pts[i - 1].q)
      return Math.min(1, Math.max(0, 1 - f))
    }
  }
  return 0.5
}
