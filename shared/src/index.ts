/**
 * biance-vision-brooks —— Al Brooks 价格行为结构引擎（共享包）
 *
 * 纯 TypeScript、零依赖、只在收盘K线上计算：
 * web 前端（/brooks 复盘页标注）与服务端（AI 工具 brooks_structure、/brooks 命令）共用。
 * 改动引擎后需 `pnpm --filter biance-vision-brooks run build`（根目录 pnpm dev/build 已自动带上）。
 */

export type {
  BarFeature,
  BrooksAnalysis,
  BrooksCandle,
  BrooksDisplay,
  BrooksOptions,
  BrooksSignal,
  BrooksSummary,
  Direction,
  Leg,
  RegimeType,
  RegimeSegment,
  SignalKind,
  SwingKind,
  SwingLabel,
  SwingPoint,
  AlwaysIn,
} from './types.js'
export { computeBarFeatures, ema, atr, TREND_BAR_RATIO, DOJI_RATIO } from './bars.js'
export {
  findSwings,
  buildZigzag,
  buildLegs,
  minLowBetween,
  maxHighBetween,
  swingSequenceText,
  trendStructureText,
} from './swings.js'
export { computeRegime, computeAlwaysIn, REGIME_TEXT } from './regime.js'
export { detectSignals } from './signals.js'
export { analyzeBrooks, DEFAULT_OPTIONS } from './analyze.js'
