/**
 * Al Brooks 价格行为结构引擎 —— 类型定义
 *
 * 设计原则（对应 Brooks 体系）：
 * 1. 只在 K 线收盘后计算，杜绝重绘（repaint）；
 * 2. 结构识别（摆动点/腿/趋势震荡）与信号计数（H1~H4/L1~L4）是两套独立状态机；
 * 3. 每条信号都携带 reason（量化触发细节）与 concept（Brooks 概念出处），供复盘学习对照。
 */

import type { KlineBar } from '../types.js'

export type Direction = 'bull' | 'bear' | 'neutral'

/** 单根 K 线的量化特征（Brooks「逐根K线分析」的读法） */
export interface BarFeature {
  index: number
  time: number
  open: number
  high: number
  low: number
  close: number
  /** 全幅 high-low */
  range: number
  /** 实体 |close-open| */
  body: number
  /** 实体占全幅比（趋势棒 ≥0.55，doji ≤0.30） */
  bodyRatio: number
  /** 收盘位置 (close-low)/range，0=收在最低 1=收在最高 */
  closePos: number
  upperTail: number
  lowerTail: number
  barDir: 'up' | 'down' | 'flat'
  isTrendBar: boolean
  isDoji: boolean
  /** 内包线：高低点完全被前一根包含（Brooks：突破模式/观望） */
  isInside: boolean
  /** 外包线：高低点吞没前一根（Brooks：常引发二次突破 H2/L2） */
  isOutside: boolean
  shavedBottom: boolean
  shavedTop: boolean
  /** 连续两根内包（Brooks：日内最可靠突破形态之一） */
  isII: boolean
  isIII: boolean
  isOO: boolean
  /** 内包-外包-内包（ioi，突破模式） */
  isIOI: boolean
}

export type SwingKind = 'high' | 'low'
/** 与上一个同向摆动点比较：HH 更高高点 / LH 更低高点 / HL 更高低点 / LL 更低低点 */
export type SwingLabel = 'HH' | 'LH' | 'HL' | 'LL' | ''

export interface SwingPoint {
  index: number
  time: number
  price: number
  kind: SwingKind
  label: SwingLabel
  /** 右侧确认根数：confirmIndex 收盘后该摆动点才成立（信号的天然滞后） */
  confirmIndex: number
}

/** 腿：两个相邻摆动点之间的单向移动（zigzag 边） */
export interface Leg {
  fromIndex: number
  toIndex: number
  fromPrice: number
  toPrice: number
  direction: 'up' | 'down'
  barCount: number
  range: number
  /** 腿内同向趋势棒数量（动能） */
  trendBarCount: number
  /** 与上一腿幅度之比（回调深度），>1 意味着击穿前一腿（趋势减弱/反转线索） */
  retracementOfPrev?: number
}

/**
 * 市场状态（Brooks 市场循环：spike → channel → trading range → breakout）
 * spike_*：≥5 根连续同向趋势棒；channel_*：20 根收盘价 ≥70%/≤30% 位于 EMA20 一侧；
 * trading_range：介于两者之间（80% 突破尝试失败区）；tight_range：紧凑重叠；barbwire：含 doji 的铁丝网（不交易区）。
 */
export type RegimeType =
  | 'spike_bull'
  | 'channel_bull'
  | 'spike_bear'
  | 'channel_bear'
  | 'trading_range'
  | 'tight_range'
  | 'barbwire'

export interface RegimeSegment {
  from: number
  to: number
  type: RegimeType
}

export interface AlwaysInFlip {
  index: number
  time: number
  direction: Direction
  reason: string
}

/** Always In：若必须持仓非多即空，当前应持的方向（Brooks 词汇表） */
export interface AlwaysIn {
  direction: Direction
  sinceIndex: number
  reason: string
  history: AlwaysInFlip[]
}

export type SignalKind =
  | 'H1' | 'H2' | 'H3' | 'H4'
  | 'L1' | 'L2' | 'L3' | 'L4'
  | 'WEDGE_TOP' | 'WEDGE_BOTTOM'
  | 'DOUBLE_TOP' | 'DOUBLE_BOTTOM'
  | 'II_BREAKOUT_UP' | 'II_BREAKOUT_DOWN'
  | 'OB_REVERSAL_UP' | 'OB_REVERSAL_DOWN'
  | 'TLB_BULL' | 'TLB_BEAR'
  | 'MTR_BULL' | 'MTR_BEAR'
  | 'TR_BREAKOUT_UP' | 'TR_BREAKOUT_DOWN'
  | 'SPIKE_UP' | 'SPIKE_DOWN'

/** 多/空头研究信号：只做结构标注与教学，不含任何行情预测 */
export interface BrooksSignal {
  kind: SignalKind
  direction: Direction
  index: number
  time: number
  /** 图上短标签，如 H2、楔顶、MTR */
  label: string
  title: string
  /** 量化触发细节（为什么这根K线出了这个信号） */
  reason: string
  /** Brooks 概念出处（《价格行为交易》三部曲 / 官方词汇表） */
  concept: string
  /** Brooks 经验概率先验（如 H2 ≈60%、区间突破 80% 失败） */
  prior?: string
  strength: 'high' | 'medium' | 'low'
  /** 研究参考位：突破确认价 / 结构止损 / 测量移动目标（AB=CD） */
  ref?: { entry?: number; stop?: number; target?: number }
}

export interface BrooksOptions {
  /** 摆动点左右各确认根数（1=微观 / 2~3=标准 / 5=主要摆动） */
  swingK: number
}

export interface BrooksSummary {
  barCount: number
  regime: RegimeType
  regimeText: string
  alwaysIn: Direction
  alwaysInReason: string
  alwaysInSince: number
  /** 最近摆动序列，如 HH→HL→HH→LL */
  swingSequence: string
  /** 结构判定：多头结构(HH+HL) / 空头结构(LH+LL) / 震荡拉锯 */
  trendStructure: string
  lastLeg: Leg | null
}

export interface BrooksAnalysis {
  bars: KlineBar[]
  features: BarFeature[]
  ema20: number[]
  atr14: number[]
  swings: SwingPoint[]
  legs: Leg[]
  regimeAt: RegimeType[]
  regimes: RegimeSegment[]
  alwaysIn: AlwaysIn
  signals: BrooksSignal[]
  summary: BrooksSummary
  options: BrooksOptions
}

/** 图表绘制开关（传给自定义指标 extendData） */
export interface BrooksDisplay {
  swings: boolean
  legs: boolean
  io: boolean
  signals: boolean
  ema: boolean
  regime: boolean
}
