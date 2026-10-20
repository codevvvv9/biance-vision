/**
 * biance-vision-brooks —— Al Brooks 价格行为结构引擎（共享包）
 *
 * 纯 TypeScript、零依赖、只在收盘K线上计算：
 * web 前端（/brooks 复盘页标注）与服务端（AI 工具 brooks_structure、/brooks 命令）共用。
 * 改动引擎后需 `pnpm --filter biance-vision-brooks run build`（根目录 pnpm dev/build 已自动带上）。
 */

export type {
  AlwaysIn,
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
  StructureEvent,
  StructureEventKind,
  SwingKind,
  SwingLabel,
  SwingPoint,
} from './types.js'
export { ENGINE_VERSION } from './version.js'
export type { SharedLocale } from './i18n.js'
export { SIGNAL_MESSAGES, msg } from './i18n.js'
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
export { computeRegime, computeAlwaysIn, regimeChangeEvents, regimeText, REGIME_TEXT } from './regime.js'
export type { RegimeChange, RegimeResult } from './regime.js'
export { detectSignals } from './signals.js'
export type { SignalInput, SignalOutput } from './signals.js'
export { analyzeBrooks, DEFAULT_OPTIONS } from './analyze.js'

// ── 行情与 API 契约（zod；server 与 web 同源引用） ──
export * from './market.js'
export * from './contract/index.js'
