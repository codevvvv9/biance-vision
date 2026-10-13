/**
 * 事件合约评估计算（纯函数，LLM 不参与任何数值）。
 * 对应 docs/specs/event-contracts.md：
 * - stake（投入）与 totalPayout（含本金总返还）分列；
 * - 期望净收益 EV = pWin×(totalPayout−stake) − pLose×stake；
 * - 无平价退款时盈亏平衡胜率 = stake / totalPayout；
 * - 平价（tie）退款单独分支，不并入胜负；
 * - 预测目标 = 到期时刻标的价格相对已有执行价的高/低；
 * - 剩余期限必须落入已验证期限桶（容差默认 20%），否则概率/EV 不可用。
 */

export interface EventQuoteNums {
  stake: number
  totalPayout: number
  direction: 'above' | 'below'
  /** 是否存在平价退款分支（到期价恰好等于执行价时退本金） */
  tieRefund?: boolean
}

export interface EventEvalNums {
  breakevenWinRate: number
  winAmount: number
  loseAmount: number
  hasTieRefund: boolean
  expectedNet: number | null
  /** EV/概率不可用原因 */
  unavailableReason: string | null
}

/**
 * 评估报价的 EV。probabilityUp 是「到期标的价格高于执行价」的概率，唯一来自统计模块；
 * direction=below 时调用方传入的应为 P(below)。概率为 null（模型未就绪/期限不匹配/数据过期）时
 * EV 为 null 并给出原因，其余可算字段照常返回。
 */
export function evaluateEvent(q: EventQuoteNums, pWin: number | null, pTie = 0): EventEvalNums {
  const winAmount = q.totalPayout - q.stake
  const loseAmount = q.stake
  const hasTieRefund = q.tieRefund === true
  const breakevenWinRate = q.totalPayout > 0 ? q.stake / q.totalPayout : NaN

  if (pWin === null) {
    return {
      breakevenWinRate,
      winAmount,
      loseAmount,
      hasTieRefund,
      expectedNet: null,
      unavailableReason: '概率不可用（模型未就绪、期限未验证或数据过期）',
    }
  }
  if (!(pWin >= 0 && pWin <= 1)) {
    return {
      breakevenWinRate,
      winAmount,
      loseAmount,
      hasTieRefund,
      expectedNet: null,
      unavailableReason: '概率输入非法（超出 [0,1]）',
    }
  }
  const tie = hasTieRefund ? Math.min(Math.max(pTie, 0), 1 - pWin) : 0
  const pLose = 1 - pWin - tie
  // 平价退款分支净收益为 0（退回本金），只从输家概率中扣除
  const expectedNet = pWin * winAmount - pLose * loseAmount
  return { breakevenWinRate, winAmount, loseAmount, hasTieRefund, expectedNet, unavailableReason: null }
}

export interface HorizonBucket {
  name: string
  ms: number
  /** 已验证期限之外的桶只能以研究模式展示 */
  researchOnly?: boolean
}

export type HorizonMatch =
  | { matched: true; horizon: string; researchOnly: boolean; deviationRatio: number }
  | { matched: false; reason: string }

/**
 * 剩余期限匹配：|剩余 − 桶| / 桶 <= 容差 才匹配。
 * 完整 10 分钟预测不得复用给只剩 3 分钟的订单（偏差 70% > 容差）。
 */
export function matchHorizon(remainingMs: number, buckets: HorizonBucket[], toleranceRatio = 0.2): HorizonMatch {
  if (!(remainingMs > 0)) return { matched: false, reason: '报价已到期或剩余期限非法' }
  let best: { b: HorizonBucket; dev: number } | null = null
  for (const b of buckets) {
    const dev = Math.abs(remainingMs - b.ms) / b.ms
    if (best === null || dev < best.dev) best = { b, dev }
  }
  if (best === null) return { matched: false, reason: '无可用期限桶' }
  if (best.dev > toleranceRatio) {
    return {
      matched: false,
      reason: `剩余期限与已验证期限桶偏差 ${(best.dev * 100).toFixed(0)}% 超出容差 ${(toleranceRatio * 100).toFixed(0)}%（不得把完整期限的预测复用到剩余更短的订单）`,
    }
  }
  return { matched: true, horizon: best.b.name, researchOnly: best.b.researchOnly === true, deviationRatio: best.dev }
}

/** 支持的研究期限桶（1w 为研究模式，非币安已有事件合约产品） */
export const EVENT_HORIZON_BUCKETS: HorizonBucket[] = [
  { name: '10m', ms: 10 * 60_000 },
  { name: '30m', ms: 30 * 60_000 },
  { name: '1h', ms: 60 * 60_000 },
  { name: '1d', ms: 24 * 60 * 60_000 },
  { name: '1w', ms: 7 * 24 * 60 * 60_000, researchOnly: true },
]

/**
 * 到期结算价选取（纯函数）：返回覆盖到期时刻的 K 线收盘价。
 * 覆盖条件：最后一根已收盘 K 线的 closeTime 落在到期前 intervalMs 之内；
 * 到期分钟行情有缺口时返回 null——不得用相邻时刻价格冒充（spec: event-contracts 边界）。
 */
export function pickExpiryClose(candles: { closeTime: number; close: string | number }[], expiryAt: number, intervalMs: number): number | null {
  if (candles.length === 0) return null
  const last = candles[candles.length - 1]
  if (expiryAt - last.closeTime >= intervalMs) return null
  return Number(last.close)
}
