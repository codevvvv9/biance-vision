/**
 * 永续合约研究计算（纯函数，LLM 不参与任何数值）。
 * 对应 docs/specs/perpetual.md：计划盈亏、费用（taker/maker 两腿，滑点只计市价腿）、
 * 资金费率情景与时效（fundingFreshness）、多约束仓位上限（maxPositionByRisk，含 bindingConstraint）。
 * 本文件是费率配置与风险上限的单一来源：services/perpetualAnalyzer 的 BigInt 引擎
 * 复用这里的 FeeConfig/DEFAULT_FEES/resolveFeeLegs/maxPositionByRisk，不另立费率定义。
 * 纪律：精确强平价只能展示用户从 App 录入的数据；缺少账户与保证金档位信息时，
 * 不得把简化估算称为真实强平价。
 */

export type PositionSide = 'long' | 'short'
export type MarginMode = 'cross' | 'isolated'

export interface PerpPosition {
  side: PositionSide
  qty: number
  entryPrice: number
  leverage: number
  marginMode: MarginMode
}

export interface FeeConfig {
  /** taker 费率（小数，如 0.0005；市价腿） */
  takerRate: number
  /** maker 费率（小数，如 0.0002；限价/回踩入场腿） */
  makerRate: number
  /** 滑点假设（单边，相对价格；只计入市价腿） */
  slippageRate: number
}

/** 默认费率档（币安 USDT 永续普通用户，可在 Agent 配置 ruleParams.perp 覆盖并随 run 冻结） */
export const DEFAULT_FEES: FeeConfig = { takerRate: 0.0005, makerRate: 0.0002, slippageRate: 0.0002 }

/** 下单方式：market=市价（taker+滑点）/ limit=限价或回踩确认入场（maker，无滑点） */
export type OrderStyle = 'market' | 'limit'

export interface FeeLegs {
  entryStyle: OrderStyle
  exitStyle: OrderStyle
  /** 入场腿实际费率（market=takerRate；limit=makerRate） */
  entryRate: number
  /** 平仓腿实际费率（market=takerRate+slippageRate；limit=makerRate） */
  exitRate: number
  /** 各腿费率档说明（结果中注明，消除「两档已实现」的假象） */
  note: string
}

/** 费率腿解析（纯函数）：限价/回踩入场用 maker，市价用 taker；滑点只计入市价平仓腿 */
export function resolveFeeLegs(fees: FeeConfig, entryStyle: OrderStyle = 'market', exitStyle: OrderStyle = 'market'): FeeLegs {
  const entryRate = entryStyle === 'limit' ? fees.makerRate : fees.takerRate
  const exitRate = exitStyle === 'limit' ? fees.makerRate : fees.takerRate + fees.slippageRate
  const leg = (style: OrderStyle, rate: number): string => (style === 'limit' ? `限价(maker ${rate})` : `市价(taker+滑点 ${rate})`)
  return {
    entryStyle,
    exitStyle,
    entryRate,
    exitRate,
    note: `入场腿=${leg(entryStyle, entryRate)}；平仓腿=${leg(exitStyle, exitRate)}`,
  }
}

/** 某价格下的未平仓盈亏（不含费用） */
export function pnlAt(pos: PerpPosition, price: number): number {
  return pos.side === 'long' ? (price - pos.entryPrice) * pos.qty : (pos.entryPrice - price) * pos.qty
}

/** 占用保证金（名义/杠杆） */
export function marginUsed(pos: PerpPosition): number {
  return (pos.entryPrice * pos.qty) / pos.leverage
}

export interface PnlScenario {
  price: number
  pnlGross: number
  fees: number
  pnlNet: number
  /** 相对占用保证金的收益率 */
  roe: number
}

/** 计划盈亏矩阵：给定价格列表逐点计算（费率两腿按 resolveFeeLegs；默认双边市价=taker 入场 + taker+滑点 平仓） */
export function pnlScenarios(
  pos: PerpPosition,
  prices: number[],
  fees: FeeConfig = DEFAULT_FEES,
  styles: { entryStyle?: OrderStyle; exitStyle?: OrderStyle } = {},
): PnlScenario[] {
  const margin = marginUsed(pos)
  const legs = resolveFeeLegs(fees, styles.entryStyle, styles.exitStyle)
  const entryFee = pos.entryPrice * pos.qty * legs.entryRate
  return prices.map((price) => {
    const exitFee = price * pos.qty * legs.exitRate
    const feeTotal = entryFee + exitFee
    const gross = pnlAt(pos, price)
    const net = gross - feeTotal
    return { price, pnlGross: gross, fees: feeTotal, pnlNet: net, roe: margin > 0 ? net / margin : NaN }
  })
}

/**
 * 资金费率情景：逐期费用 = qty × markPrice × rate；
 * 多头在 rate>0 时支付（成本为正），空头相反（负值=收入）。
 */
export function fundingScenarios(
  pos: PerpPosition,
  markPrice: number,
  rates: number[],
): { perInterval: number[]; cumulative: number; intervalsPerDay: number } {
  const sign = pos.side === 'long' ? 1 : -1
  const perInterval = rates.map((r) => sign * pos.qty * markPrice * r)
  const cumulative = perInterval.reduce((a, b) => a + b, 0)
  return { perInterval, cumulative, intervalsPerDay: 3 }
}

export interface RiskCapInput {
  riskBudget: number
  entryPrice: number
  stopPrice: number
  leverage: number
  fees?: FeeConfig
  /** 数量步进（stepSize），不提供则不向下取整 */
  stepSize?: number
  /** 最小名义金额（交易所规则），不提供则不检查 */
  minNotional?: number
  /** 组合剩余风险敞口（可选）：提供后 maxQty 同时受其约束 */
  portfolioExposure?: number
  /** 入场/平仓腿下单方式（默认市价；限价/回踩入场用 maker 档） */
  entryStyle?: OrderStyle
  exitStyle?: OrderStyle
}

/** 仓位上限约束名（bindingConstraint：实际起作用的约束取最小者） */
export type RiskCapConstraint = 'risk_budget' | 'portfolio_exposure' | 'step_rounding' | 'min_notional'

export type RiskCapResult =
  | {
      ok: true
      maxQty: number
      notional: number
      margin: number
      perUnitLoss: number
      /** 实际触发（取到最小值）的约束 */
      bindingConstraint: RiskCapConstraint
      /** 各约束给出的数量上限（null=不适用）与是否触发 */
      constraints: { name: RiskCapConstraint; limitQty: number | null; binding: boolean }[]
    }
  | { ok: false; reason: string; bindingConstraint: RiskCapConstraint | null }

/**
 * 风险预算下的仓位上限：多约束取最小——
 *   riskBudget / 每单位到止损的损失（含双边费用腿与滑点）为基准约束；
 *   组合剩余敞口（如提供）与数量步进取整继续收紧；minNotional 是名义下限，
 *   取整后的上限若低于最小名义则不可开仓（bindingConstraint=min_notional）。
 * 这是计划约束——跳空或滑点时实际损失可能超预算，界面必须保留该提示。
 */
export function maxPositionByRisk(input: RiskCapInput): RiskCapResult {
  const { riskBudget, entryPrice, stopPrice, leverage } = input
  const fees = input.fees ?? DEFAULT_FEES
  if (!(riskBudget > 0)) return { ok: false, reason: '风险预算必须为正数', bindingConstraint: null }
  if (!(entryPrice > 0) || !(stopPrice > 0)) return { ok: false, reason: '入场价与止损价必须为正数', bindingConstraint: null }
  if (entryPrice === stopPrice) return { ok: false, reason: '入场价与止损价相同，无法定义单位损失', bindingConstraint: null }

  const legs = resolveFeeLegs(fees, input.entryStyle, input.exitStyle)
  // 单位损失 = 价格差 + 入场腿（按入场价）+ 平仓腿（按止损价），两腿费率档可不同
  const perUnitLoss = Math.abs(entryPrice - stopPrice) + entryPrice * legs.entryRate + stopPrice * legs.exitRate
  if (!(perUnitLoss > 0)) return { ok: false, reason: '单位损失不可计算', bindingConstraint: null }

  const qtyByRisk = riskBudget / perUnitLoss
  const qtyByExposure = input.portfolioExposure !== undefined && input.portfolioExposure > 0 ? input.portfolioExposure / perUnitLoss : null
  let maxQty = qtyByExposure !== null ? Math.min(qtyByRisk, qtyByExposure) : qtyByRisk
  if (input.stepSize && input.stepSize > 0) {
    maxQty = Math.floor(maxQty / input.stepSize) * input.stepSize
  }
  if (!(maxQty > 0)) {
    return { ok: false, reason: '按步进取整后数量为零：风险预算不足以覆盖单位损失', bindingConstraint: 'step_rounding' }
  }
  const notional = maxQty * entryPrice
  if (input.minNotional && notional < input.minNotional) {
    return {
      ok: false,
      reason: `名义金额 ${notional.toFixed(2)} 低于最小名义 ${input.minNotional}：风险预算内的上限不满足交易所名义下限`,
      bindingConstraint: 'min_notional',
    }
  }
  const bindingConstraint: RiskCapConstraint = qtyByExposure !== null && qtyByExposure < qtyByRisk ? 'portfolio_exposure' : 'risk_budget'
  const roundedFrom = qtyByExposure !== null ? Math.min(qtyByRisk, qtyByExposure) : qtyByRisk
  return {
    ok: true,
    maxQty,
    notional,
    margin: notional / leverage,
    perUnitLoss,
    bindingConstraint,
    constraints: [
      { name: 'risk_budget', limitQty: qtyByRisk, binding: bindingConstraint === 'risk_budget' },
      { name: 'portfolio_exposure', limitQty: qtyByExposure, binding: bindingConstraint === 'portfolio_exposure' },
      // 步进取整是落地动作（向下取整到 stepSize），不是收紧来源；min_notional 未触发时仅备案
      { name: 'step_rounding', limitQty: maxQty < roundedFrom ? maxQty : null, binding: false },
      { name: 'min_notional', limitQty: input.minNotional !== undefined ? input.minNotional / entryPrice : null, binding: false },
    ],
  }
}

/**
 * 强平价信息纪律：只展示用户从 App 录入的精确值；未提供时明确为未知，
 * 不用简化公式冒充真实强平价。
 */
export function liquidationInfo(userProvided: number | null | undefined): {
  price: number | null
  source: 'user_app' | null
  note: string
} {
  if (userProvided !== null && userProvided !== undefined && userProvided > 0) {
    return { price: userProvided, source: 'user_app', note: '用户从 App 录入的强平价' }
  }
  return {
    price: null,
    source: null,
    note: '缺少账户与保证金档位信息，不提供强平价估算（简化估算不等于真实强平价）',
  }
}

/** 支持的动作域（研究输出，不含下单） */
export const PERP_ACTIONS = ['long', 'short', 'wait', 'hold', 'reduce', 'exit'] as const
export type PerpAction = (typeof PERP_ACTIONS)[number]

/** 资金费率结算间隔默认 8h（币安 USDT 永续），宽限 1h；均可随冻结配置覆盖 */
export const FUNDING_INTERVAL_MS = 8 * 3600_000
export const FUNDING_GRACE_MS = 3600_000

export interface FundingFreshness {
  /** true=最新一条费率距决策时刻超过「结算间隔+宽限」，情景输出必须不可用（funding_stale） */
  stale: boolean
  /** 最新一条费率时间（无数据为 null——走「数据缺失」分支，不是过期分支） */
  latestFundingTime: number | null
  intervalMs: number
  graceMs: number
  reason: string | null
}

/**
 * 资金费率时效检查（纯函数）：最新一条距 asOf 超过 intervalMs+graceMs → stale，
 * 调用方不得静默用旧费率出情景。无数据返回 stale=false（由「缺失」分支单独标注）。
 */
export function fundingFreshness(
  latestFundingTime: number | null,
  asOf: number,
  intervalMs: number = FUNDING_INTERVAL_MS,
  graceMs: number = FUNDING_GRACE_MS,
): FundingFreshness {
  if (latestFundingTime === null) return { stale: false, latestFundingTime, intervalMs, graceMs, reason: null }
  const ageMs = asOf - latestFundingTime
  if (ageMs > intervalMs + graceMs) {
    return {
      stale: true,
      latestFundingTime,
      intervalMs,
      graceMs,
      reason: `最新资金费率距决策时刻 ${(ageMs / 3600_000).toFixed(1)}h，超过结算间隔 ${intervalMs / 3600_000}h + 宽限 ${graceMs / 3600_000}h（funding_stale）`,
    }
  }
  return { stale: false, latestFundingTime, intervalMs, graceMs, reason: null }
}
