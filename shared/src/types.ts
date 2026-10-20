/**
 * Al Brooks 价格行为结构引擎 —— 类型定义
 *
 * 设计原则（对应 Brooks 体系）：
 * 1. 只在 K 线收盘后计算，杜绝重绘（repaint）；
 * 2. 结构识别（摆动点/腿/趋势震荡）与信号计数（H1~H4/L1~L4）是两套独立状态机；
 * 3. 每条信号都携带 reason（量化触发细节）与 concept（Brooks 概念出处），供复盘学习对照。
 */

import type { SharedLocale } from './i18n.js'



/** 引擎输入的最小K线结构（web 的 KlineBar 结构兼容，可直接传入） */
export interface BrooksCandle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
  /**
   * 收盘标记：false = 未收盘（引擎入口拒绝）；缺省视为历史已收盘数据。
   * 传入 options.asOf 时还必须携带 closeTime（毫秒），否则无法验证截止约束。
   */
  closed?: boolean
  /** 收盘时间（UTC 毫秒）；与 asOf 配合做统一截止时间校验 */
  closeTime?: number
}

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
  /**
   * 可知时间（bar 索引）：右侧第 k 根收盘后该摆动点才成立（信号的天然滞后）。
   * confirmIndex 即 knownAt 的 bar 索引形态：模型与回放只能在 confirmIndex 之后使用它，
   * 展示可以把 pivot 画回 index，但那不代表当时已知。
   */
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
  /** 可知时间（bar 索引）：终点摆动点的 confirmIndex；provisional 腿为 null */
  knownAtIndex: number | null
  /** 未完成腿：最后一个摆动点之后的进行中移动，可能继续延伸，不得覆盖已确认证据 */
  provisional?: boolean
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
  /**
   * 可知时间（bar 索引）：该段状态被因果确认的位置。
   * 因果状态机下段边界只出现在确认 bar 上，因此恒等于 from；
   * 状态实际开始的位置更早，记录在 regime_change 事件的 atIndex。
   */
  knownAtIndex: number
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
  /**
   * Brooks 在其美股股指期货市场的经验统计备注（带上下文的原文口径）。
   * 注意：这不是本工具对任何币种/周期的预测胜率，不参与判定逻辑；
   * 预测概率唯一来自统计模块（见 docs/specs/prediction.md）。
   */
  empiricalNote?: string
  /** 规则匹配强度（结构证据完整度），不是置信度、更不是未来事件概率 */
  strength: 'high' | 'medium' | 'low'
  /** 研究参考位：突破确认价 / 结构止损 / 测量移动目标（AB=CD） */
  ref?: { entry?: number; stop?: number; target?: number }
  /** 可知时间（bar 索引）：信号在该索引的收盘后可得（全部输入均已确认） */
  knownAtIndex: number
  /** 生命周期：triggered = 触发已确认；setup/失效/过期走 StructureEvent 表达 */
  status: 'triggered'
}

/** 结构事件种类：摆动/腿/状态切换/形态登记（setup）/触发/失效/过期 */
export type StructureEventKind =
  | 'swing'
  | 'leg'
  | 'regime_change'
  | 'setup'
  | 'trigger'
  | 'invalidation'
  | 'expiry'

/**
 * 结构事件：引擎对外的事实载体，全部携带 atIndex（结构发生位置）与
 * knownAtIndex（可知位置，provisional 为 null）。回放与模型只能使用
 * knownAtIndex <= t 的事件；已发布的事件记录不得被后续重算覆盖。
 */
export interface StructureEvent {
  kind: StructureEventKind
  /** 规则标识，如 swing.fractal / regime.confirm / hl_count / ii_breakout / H2 / WEDGE_TOP */
  ruleId: string
  /** 规则版本（引擎版本） */
  ruleVersion: string
  direction?: Direction
  /** 结构发生位置（摆动 pivot、raw 状态翻转点、setup 成立 bar） */
  atIndex: number
  atTime: number
  /** 可知位置（确认收盘 bar）；provisional 事件为 null */
  knownAtIndex: number | null
  knownAtTime: number | null
  /** 涉及的 bar 索引（如腿的两端、ii 形态区间） */
  barIndices: number[]
  /** 进行中/未确认标记（如未完成腿） */
  provisional?: boolean
  note?: string
}

export interface BrooksOptions {
  /** 摆动点左右各确认根数（1=微观 / 2~3=标准 / 5=主要摆动） */
  swingK: number
  /**
   * 统一截止时间（UTC 毫秒）。提供时每根 K 线必须携带 closeTime 且 closeTime <= asOf，
   * 否则引擎入口抛错——回放/研究不得混入截止后才收盘的数据。
   */
  asOf?: number
  /** 用户可见文案语言（label/title/reason/concept/事件备注/摘要文本），缺省中文 */
  locale?: SharedLocale
}

export interface BrooksSummary {
  barCount: number
  regime: RegimeType
  regimeText: string
  /** 末根正在观察中的候选状态（因果确认前），null = 无 */
  pendingRegime: RegimeType | null
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
  bars: BrooksCandle[]
  features: BarFeature[]
  ema20: number[]
  atr14: number[]
  swings: SwingPoint[]
  legs: Leg[]
  /** 因果确认后的逐根状态（只依赖当时及之前的收盘数据） */
  regimeAt: RegimeType[]
  /** 未经确认的原始逐根分类（因果，但未经两根确认平滑），供 UI 展示 pending 提示 */
  rawRegimeAt: RegimeType[]
  /** 每根正在观察中的候选状态（null = 无候选），与 rawRegimeAt 配合展示 provisional */
  regimePendingAt: (RegimeType | null)[]
  regimes: RegimeSegment[]
  alwaysIn: AlwaysIn
  signals: BrooksSignal[]
  /** 结构事件流：摆动/腿/状态切换/setup/触发/失效/过期，按 knownAtIndex 排序 */
  events: StructureEvent[]
  engineVersion: string
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
