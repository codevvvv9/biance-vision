/**
 * PerpetualAnalyzer（P1，improvement-plan §2.2 计算层）：
 * - 十进制核心量（BigInt 分单位）计算盈亏/费用/减仓/增量风险，展示时才舍入；
 * - 费率与仓位上限的单一来源是 research/perp/calc.ts：FeeConfig（taker/maker/slippage）
 *   与 resolveFeeLegs/maxPositionByRisk 在此复用，本文件不另立费率定义；
 * - 杠杆只用于保证金需求，不重复放大价格盈亏；
 * - 仓位上限计入费用与滑点假设，多约束取最小并输出 bindingConstraint，按数量步进向下取整；
 * - 资金费率情景读实际数据（最近 N 期均值/极值），未来费用标注为情景估算；
 *   数据缺失或过期（funding_stale）时不提供情景（不以默认费率/旧数据伪装实际统计）；
 * - 同时输出「整笔交易净盈亏」（入场价基准，含已发生入场费用）与
 *   「从现在继续持有的增量风险」（当前价基准，只含未来平仓费用）——
 *   减仓判断与到止损风险均按增量基准（已发生的浮盈/浮亏不重复计入未来风险）；
 * - 减仓数量：从当前价持有到止损的增量损失 ≤ 风险预算 的最大保留数量；
 * - 强平价仅展示用户从 App 确认的数据。
 */
import {
  DEFAULT_FEES,
  maxPositionByRisk,
  resolveFeeLegs,
} from '../research/perp/calc.js'
import type { FeeConfig, FeeLegs, OrderStyle, RiskCapConstraint } from '../research/perp/calc.js'

/** 分单位十进制（1e8）核心运算：金额/数量/价格精确到分 */
const SCALE = 10n ** 8n

export function toDec(x: number | string): bigint {
  const s = typeof x === 'number' ? x.toFixed(8) : x
  const [int, frac = ''] = s.split('.')
  const neg = int.startsWith('-')
  const cleanInt = neg ? int.slice(1) : int
  const fracPadded = (frac + '00000000').slice(0, 8)
  const v = BigInt(cleanInt || '0') * SCALE + BigInt(fracPadded || '0')
  return neg ? -v : v
}

export function fromDec(x: bigint): number {
  return Number(x) / 1e8
}

export interface PerpPositionInput {
  side: 'long' | 'short'
  qty: number
  entryPrice: number
  leverage: number
  marginMode: 'cross' | 'isolated'
  stopPrice: number | null
  riskBudget: number
  liquidationPrice: number | null
}

/** 费率假设 = calc.ts 的 FeeConfig（单一来源；taker/maker 两档 + 单边滑点） */
export type PerpFeeAssumption = FeeConfig

/** 默认值直接引用 calc.ts 的 DEFAULT_FEES（运行时应使用随 run 冻结的 frozenConfig.fees） */
export const DEFAULT_PERP_FEES: PerpFeeAssumption = DEFAULT_FEES

export interface PnlPoint {
  price: number
  /** 整笔交易净盈亏（入场价基准，含已发生入场费用与该价平仓费用） */
  tradeNetPnl: number
  /** 从现在继续持有的增量盈亏（当前价基准：价格差 × 数量 − 该价平仓费用；不含已发生入场费用） */
  incrementalPnl: number
  /** 整笔净盈亏相对保证金的 ROE */
  roe: number
}

export interface FundingScenario {
  label: string
  /** 每期费率（来自实际数据统计：均值/高/低） */
  ratePer8h: number
  /** 未来 24h 情景费用（标注估算） */
  cost24h: number
  source: 'recent_mean' | 'recent_max' | 'recent_min'
}

export interface RiskCapResult {
  ok: boolean
  maxQty: number | null
  reason?: string
  /** 实际触发的约束（risk_budget/portfolio_exposure/step_rounding/min_notional） */
  bindingConstraint?: RiskCapConstraint | null
}

export interface ReducePlan {
  needed: boolean
  /** 风险预算内可保留的最大数量（向下取整到 stepSize） */
  keepQty: number | null
  reduceQty: number | null
  reason: string
}

export interface PerpAnalysisOptions {
  /** 入场腿下单方式：market=市价（taker）；limit=限价/回踩入场（maker） */
  entryStyle?: OrderStyle
  /** 平仓腿下单方式（默认 market：taker+滑点） */
  exitStyle?: OrderStyle
  /** 最小名义金额约束（交易所规则；随冻结配置传入） */
  minNotional?: number
  /** 组合剩余风险敞口（可选约束） */
  portfolioExposure?: number
  /** 资金费率数据过期（funding_stale）：情景输出不可用，不静默用旧数据 */
  fundingStale?: boolean
  fundingStaleNote?: string
}

export interface PerpAnalysis {
  position: PerpPositionInput
  marginUsed: number
  pnlPoints: PnlPoint[]
  fundingScenarios: FundingScenario[]
  fundingNote: string
  /** 资金费率是否因过期被停用（funding_stale） */
  fundingStale: boolean
  riskCap: RiskCapResult
  reducePlan: ReducePlan
  liquidation: { price: number | null; note: string }
  /** 各腿费率档（入场/平仓各自注明 maker/taker 与滑点） */
  feeLegs: { entryStyle: OrderStyle; exitStyle: OrderStyle; entryRate: number; exitRate: number; note: string }
  /** 增量风险摘要 */
  incremental: { toStopPnl: number; toStopPct: number } | null
}

/** 计划盈亏矩阵（价格扫描：入场价 ± n×ATR）；currentPrice 是增量风险的基准（从现在继续持有） */
export function analyzePerp(
  position: PerpPositionInput,
  prices: number[],
  currentPrice: number,
  atr: number,
  recentFundingRates: number[],
  fees: PerpFeeAssumption = DEFAULT_PERP_FEES,
  stepSize = 0.001,
  opts: PerpAnalysisOptions = {},
): PerpAnalysis {
  const legs: FeeLegs = resolveFeeLegs(fees, opts.entryStyle ?? 'market', opts.exitStyle ?? 'market')
  const qty = toDec(position.qty)
  const entry = toDec(position.entryPrice)
  const cur = toDec(currentPrice)
  const notional = qty * entry / SCALE
  const margin = notional / BigInt(Math.max(1, position.leverage))
  const entryFee = (notional * toDec(legs.entryRate)) / SCALE
  /** 在给定价格平仓的未来费用（按平仓腿费率档；增量视角只含此项，不含已发生入场费） */
  const exitFeeAt = (price: bigint): bigint => (qty * price * toDec(legs.exitRate)) / (SCALE * SCALE)

  const pnlPoints: PnlPoint[] = prices.map((p) => {
    const price = toDec(p)
    // qty×price 带两重 1e8 刻度，费率再乘入第三重 → 需除 SCALE 两次才回到 USDT 刻度
    const exitFee = (qty * price * toDec(legs.exitRate)) / (SCALE * SCALE)
    const gross = position.side === 'long' ? ((price - entry) * qty) / SCALE : ((entry - price) * qty) / SCALE
    const tradeNet = gross - entryFee - exitFee
    const incrementalGross = position.side === 'long' ? ((price - cur) * qty) / SCALE : ((cur - price) * qty) / SCALE
    const incremental = incrementalGross - exitFee
    // ROE = 整笔净盈亏（USDT） / 保证金（USDT）：分子分母都必须经 fromDec 还原，
    // 只还原分子会除以 1e8 倍的保证金 → ROE 缩成 1e-8 量级被舍入成 0
    const roe = Number(fromDec(tradeNet)) / Number(fromDec(margin))
    return {
      price: p,
      tradeNetPnl: Number(fromDec(tradeNet).toFixed(4)),
      incrementalPnl: Number(fromDec(incremental).toFixed(4)),
      roe: Number(roe.toFixed(6)),
    }
  })

  // 资金费率情景：实际数据（均值/高/低，符号按持仓方向）；缺失/过期都不以默认费率或旧数据伪装统计
  const sign = position.side === 'long' ? 1 : -1
  const mk = (label: string, ratePer8h: number, source: FundingScenario['source']): FundingScenario => ({
    label,
    ratePer8h,
    cost24h: Number((sign * fromDec(notional) * ratePer8h * 3).toFixed(4)),
    source,
  })
  const fundingStale = opts.fundingStale === true
  const fundingScenarios =
    !fundingStale && recentFundingRates.length > 0
      ? [
          mk('最近资金费率均值', recentFundingRates.reduce((a, b) => a + b, 0) / recentFundingRates.length, 'recent_mean'),
          mk('最近费率高位', Math.max(...recentFundingRates), 'recent_max'),
          mk('最近费率低位', Math.min(...recentFundingRates), 'recent_min'),
        ]
      : []
  const fundingNote = fundingStale
    ? `资金费率数据过期，情景输出不可用（funding_stale）：${opts.fundingStaleNote ?? '最新费率超出结算间隔+宽限'}（不静默沿用旧数据）`
    : recentFundingRates.length > 0
      ? '未来资金费用为情景估算（读最近实际费率；结算次数按 3 次/24h 估算，非固定假设的真实结算）'
      : '资金费率数据缺失：不提供未来费用情景（不以默认费率假设实际结算）'

  // 仓位上限（多约束取最小，见 calc.maxPositionByRisk；费用两腿计入单位损失，步进取整）
  const stopForCap = position.stopPrice ?? (position.side === 'long' ? position.entryPrice - atr * 2 : position.entryPrice + atr * 2)
  const cap = maxPositionByRisk({
    riskBudget: position.riskBudget,
    entryPrice: position.entryPrice,
    stopPrice: stopForCap,
    leverage: Math.max(1, position.leverage),
    fees,
    stepSize,
    minNotional: opts.minNotional,
    portfolioExposure: opts.portfolioExposure,
    entryStyle: opts.entryStyle,
    exitStyle: opts.exitStyle,
  })
  const riskCap: RiskCapResult = cap.ok
    ? {
        ok: true,
        maxQty: Number(cap.maxQty.toFixed(6)),
        bindingConstraint: cap.bindingConstraint,
        ...(position.stopPrice === null
          ? { reason: '止损未设置：上限按假设止损（入场价±2×ATR）演示，不作为已有持仓已通过风险约束的依据' }
          : {}),
      }
    : { ok: false, maxQty: null, reason: cap.reason, bindingConstraint: cap.bindingConstraint }

  // 减仓计划（增量基准）：从当前价格持有到止损的增量损失（只含未来平仓费；
  // 止损在盈利侧时为负=锁定盈利，不触发减仓）超过风险预算 → 减到预算内
  let reducePlan: ReducePlan = {
    needed: false,
    keepQty: null,
    reduceQty: null,
    reason:
      position.stopPrice === null
        ? '未设置止损：无法计算持有到止损的增量损失，减仓评估不可用（请先补全止损价）'
        : '从当前价到止损的增量损失在风险预算内',
  }
  if (position.stopPrice !== null) {
    const stop = toDec(position.stopPrice)
    const perUnitMove = position.side === 'long' ? cur - stop : stop - cur
    const exitFeeAtStop = exitFeeAt(stop)
    const incrementalLossToStop = (perUnitMove * qty) / SCALE + exitFeeAtStop
    if (incrementalLossToStop > toDec(position.riskBudget)) {
      // 预算内可保留数量：riskBudget / (单位损失 + 单位平仓费)
      // unitLoss（1e8 价格刻度）：单位数量止损时的增量损失（价格差 + 平仓费/数量）
      const unitLoss = perUnitMove + (exitFeeAtStop * SCALE) / qty
      // keepQty（1e8 数量刻度）= 预算（1e8 USDT 刻度）× 1e8 / unitLoss
      const keepQtyDec = (toDec(position.riskBudget) * SCALE) / unitLoss
      const keep = Math.floor(fromDec(keepQtyDec) / stepSize) * stepSize
      reducePlan = {
        needed: true,
        keepQty: Number(keep.toFixed(6)),
        reduceQty: Number(Math.max(0, position.qty - keep).toFixed(6)),
        reason: `从当前价 ${currentPrice} 持有到止损的增量损失 ${fromDec(incrementalLossToStop).toFixed(2)} 超过风险预算 ${position.riskBudget}`,
      }
    }
  }

  // 增量风险（从当前价格继续持有到止损；扣未来平仓费，不含已发生入场费用）
  const incremental =
    position.stopPrice !== null && currentPrice > 0
      ? {
          toStopPnl: Number(
            fromDec(
              (position.side === 'long' ? (toDec(position.stopPrice) - cur) * qty : (cur - toDec(position.stopPrice)) * qty) / SCALE -
                exitFeeAt(toDec(position.stopPrice)),
            ).toFixed(4),
          ),
          toStopPct: Number((((position.stopPrice - currentPrice) / currentPrice) * 100).toFixed(3)),
        }
      : null

  return {
    position,
    marginUsed: Number(fromDec(margin).toFixed(4)),
    pnlPoints,
    fundingScenarios,
    fundingNote,
    fundingStale,
    riskCap,
    reducePlan,
    liquidation:
      position.liquidationPrice !== null && position.liquidationPrice > 0
        ? { price: position.liquidationPrice, note: '用户从 App 录入的强平价' }
        : { price: null, note: '缺少账户与保证金档位信息，不提供强平价估算（简化估算不等于真实强平价）' },
    feeLegs: { entryStyle: legs.entryStyle, exitStyle: legs.exitStyle, entryRate: legs.entryRate, exitRate: legs.exitRate, note: legs.note },
    incremental,
  }
}

/** 缩放自检（验收锚点）：1 BTC @60000、10x → 保证金 6000；涨 1000 → 整笔净盈亏≈1000−费 */
export function scalingSelfCheck(): { margin: number; pnlAt61000: number } {
  const a = analyzePerp(
    { side: 'long', qty: 1, entryPrice: 60000, leverage: 10, marginMode: 'isolated', stopPrice: 58000, riskBudget: 500, liquidationPrice: null },
    [61000], 60000, 100, [], DEFAULT_PERP_FEES, 0.001,
  )
  return { margin: a.marginUsed, pnlAt61000: a.pnlPoints[0]?.tradeNetPnl ?? NaN }
}
