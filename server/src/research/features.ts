/**
 * 预测特征构建（docs/specs/prediction.md）：
 * - 基础周期随期限伸缩：10m/30m/1h 用 1m K 线；1d/1w 用 1h K 线
 *   （1m 在长期限下前瞻窗口超出单页契约且样本趋零，1h 提供可比窗口）；
 * - featureVersion 编码「目标类型 + 基础周期」（fv-evt-r-1m / fv-dir-x-1h 等）：
 *   训练与推理都从 featureVersionFor 生成，注册表门控必须匹配
 *   「期限 ↔ 基础周期 ↔ 特征版本」三元组；
 * - 特征在时间点 i 只用 <=i 的收盘（因果）；entryPrice 供执行价相对阈值计算。
 */
import { readCandles } from '../market/read.js'

export type ResearchHorizonName = '10m' | '30m' | '1h' | '1d' | '1w'

export const HORIZON_BASE_INTERVAL: Record<ResearchHorizonName, '1m' | '1h'> = {
  '10m': '1m',
  '30m': '1m',
  '1h': '1m',
  '1d': '1h',
  '1w': '1h',
}

/** 期限 → 前瞻窗口根数（基础周期上） */
export const HORIZON_FORWARD_BARS: Record<ResearchHorizonName, number> = {
  '10m': 10,
  '30m': 30,
  '1h': 60,
  '1d': 24,
  '1w': 168,
}

/**
 * 特征版本（训练与推理同源生成，唯一入口）：
 * 编码「目标类型 + 基础周期」——周期进版本门控，禁止 1h 训练的模型吃 1m 特征
 * （同名 ret_60 在两种周期上分别是 60 小时与 60 分钟）。
 */
export function featureVersionFor(horizon: string, targetType?: 'strike_relative' | 'return_positive'): string {
  const base = HORIZON_BASE_INTERVAL[horizon as ResearchHorizonName] ?? '1m'
  const prefix = targetType === 'return_positive' ? 'fv-dir-x' : 'fv-evt-r'
  return `${prefix}-${base}`
}

export function baseIntervalFor(horizon: string): '1m' | '1h' {
  return HORIZON_BASE_INTERVAL[horizon as ResearchHorizonName] ?? '1m'
}

/** 与特征窗口定义一致的最小收盘根数（最长回看 ret_240 需要 closes[i-240]，即至少 241 根） */
export const MIN_BARS = 241

/** 在 closes[i] 处计算特征（只用 <=i 的数据；i 从 0 计） */
export function featuresAt(closes: number[], i: number): Record<string, number> | null {
  if (i < MIN_BARS - 1) return null
  const last = closes[i]
  // 对数收益（与训练标签同源；预测阈值也在对数空间）
  const ret = (n: number): number => {
    const prev = closes[i - n]
    return prev !== undefined && prev > 0 && last > 0 ? Math.log(last / prev) : 0
  }
  const window = closes.slice(i - 29, i + 1)
  const mean = window.reduce((a, b) => a + b, 0) / window.length
  const vol = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length) / mean
  const emaWindow = closes.slice(i - 59, i + 1)
  const ema = emaWindow.reduce((acc, c, j) => (j === 0 ? c : acc + (2 / 61) * (c - acc)), emaWindow[0] ?? last)
  return {
    ret_1: ret(1),
    ret_5: ret(5),
    ret_15: ret(15),
    ret_30: ret(30),
    ret_60: ret(60),
    ret_120: ret(120),
    ret_240: ret(240),
    vol_30: vol,
    dist_ema20_1: mean !== 0 ? (last - ema) / mean : 0,
  }
}

export interface BuiltFeatures {
  features: Record<string, number>
  /** 决策时刻的收盘价（执行价相对阈值的基准） */
  entryPrice: number
  baseInterval: '1m' | '1h'
  featureVersion: string
  unavailableReason: string | null
}

/** 按 asOf（已收盘约束）构建指定期限的推理特征 */
export async function buildFeaturesForHorizon(input: {
  symbol: string
  marketType: 'spot' | 'usdm_perp'
  horizon: string
  asOf: number
}): Promise<BuiltFeatures> {
  const baseInterval = baseIntervalFor(input.horizon)
  const candles = await readCandles({
    marketType: input.marketType,
    priceType: 'trade',
    symbol: input.symbol,
    interval: baseInterval,
    to: input.asOf,
    asOf: input.asOf,
    limit: MIN_BARS + 60,
  })
  if (candles.length < MIN_BARS) {
    return {
      features: {},
      entryPrice: NaN,
      baseInterval,
      featureVersion: featureVersionFor(input.horizon),
      unavailableReason: `${baseInterval} 已收盘 K 线不足（${candles.length} < ${MIN_BARS}）`,
    }
  }
  const closes = candles.map((c) => Number(c.close))
  const i = closes.length - 1
  const features = featuresAt(closes, i)
  if (features === null) {
    return {
      features: {},
      entryPrice: NaN,
      baseInterval,
      featureVersion: featureVersionFor(input.horizon),
      unavailableReason: '特征窗口数据不足',
    }
  }
  return {
    features,
    entryPrice: closes[i],
    baseInterval,
    featureVersion: featureVersionFor(input.horizon),
    unavailableReason: null,
  }
}
