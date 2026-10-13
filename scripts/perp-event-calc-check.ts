/**
 * 永续/事件合约计算的锚定校验：每个用例都是手算过的数值锚点。
 * 运行：pnpm research:calc-check
 */

import {
  DEFAULT_FEES,
  fundingFreshness,
  fundingScenarios,
  liquidationInfo,
  marginUsed,
  maxPositionByRisk,
  pnlAt,
  pnlScenarios,
  resolveFeeLegs,
  FUNDING_GRACE_MS,
  FUNDING_INTERVAL_MS,
} from '../server/src/research/perp/calc.js'
import { EVENT_HORIZON_BUCKETS, evaluateEvent, matchHorizon, pickExpiryClose } from '../server/src/research/event/calc.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✅ PASS  ${msg}`)
  } else {
    failed++
    console.error(`  ❌ FAIL  ${msg}`)
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

console.log('\n[永续] 计划盈亏矩阵')
{
  const long = { side: 'long' as const, qty: 1, entryPrice: 60000, leverage: 10, marginMode: 'cross' as const }
  assert(near(pnlAt(long, 66000), 6000), '多头 1 BTC 60000→66000 毛利 6000')
  assert(near(marginUsed(long), 6000), '占用保证金 = 名义/杠杆 = 6000')
  const s = pnlScenarios(long, [66000])
  // 默认双边市价：入场腿 taker 0.0005，平仓腿 taker+滑点 0.0007
  // 费用 = 60000×1×0.0005 + 66000×1×0.0007 = 30 + 46.2 = 76.2；净 = 5923.8；ROE = 5923.8/6000
  assert(near(s[0].fees, 76.2), '默认市价两腿费用 76.2（taker 入场 + taker+滑点 平仓）')
  assert(near(s[0].pnlNet, 5923.8), '净盈亏 5923.8')
  assert(near(s[0].roe, 0.9873), 'ROE 0.9873')

  const short = { side: 'short' as const, qty: 0.5, entryPrice: 60000, leverage: 5, marginMode: 'isolated' as const }
  const ss = pnlScenarios(short, [57000])
  // 毛利 = 3000×0.5 = 1500；费用 = 0.5×60000×0.0005 + 0.5×57000×0.0007 = 15 + 19.95 = 34.95；净 = 1465.05
  assert(near(ss[0].pnlGross, 1500), '空头 0.5 BTC 60000→57000 毛利 1500')
  assert(near(ss[0].fees, 34.95), '空头费用 34.95')
  assert(near(ss[0].pnlNet, 1465.05), '空头净盈亏 1465.05')
}

console.log('\n[永续] 费率两腿（限价/回踩用 maker 档）')
{
  const legs = resolveFeeLegs(DEFAULT_FEES, 'limit', 'limit')
  assert(near(legs.entryRate, 0.0002) && near(legs.exitRate, 0.0002) && legs.note.includes('maker'), 'limit/limit → 两腿 maker 0.0002 且注明档位')
  const mkt = resolveFeeLegs(DEFAULT_FEES)
  assert(near(mkt.entryRate, 0.0005) && near(mkt.exitRate, 0.0007), '默认 market/market → 0.0005 / 0.0007（滑点只计市价平仓腿）')
  const long = { side: 'long' as const, qty: 1, entryPrice: 60000, leverage: 10, marginMode: 'cross' as const }
  const lim = pnlScenarios(long, [66000], DEFAULT_FEES, { entryStyle: 'limit' })
  // 限价入场腿：60000×0.0002 = 12；平仓仍市价 66000×0.0007 = 46.2；合计 58.2；净 = 5941.8
  assert(near(lim[0].fees, 58.2) && near(lim[0].pnlNet, 5941.8), '限价入场 + 市价平仓：费用 58.2 / 净 5941.8')
}

console.log('\n[永续] 资金费率情景')
{
  const long = { side: 'long' as const, qty: 0.5, entryPrice: 60000, leverage: 10, marginMode: 'cross' as const }
  const f = fundingScenarios(long, 60000, [0.0001, -0.0002])
  // 多头：0.5×60000×0.0001 = 3（付）；0.5×60000×(-0.0002) = -6（收）→ 累计 -3
  assert(near(f.perInterval[0], 3) && near(f.perInterval[1], -6) && near(f.cumulative, -3), '多头资金费 [3,-6] 累计 -3')
  const fs = fundingScenarios({ ...long, side: 'short' as const }, 60000, [0.0001, -0.0002])
  assert(near(fs.cumulative, 3), '空头方向相反累计 3')
}

console.log('\n[永续] 风险预算仓位上限（多约束取最小 + bindingConstraint）')
{
  const r = maxPositionByRisk({ riskBudget: 100, entryPrice: 60000, stopPrice: 59000, leverage: 10, stepSize: 0.001 })
  // 单位损失 = 1000 + 60000×0.0005 + 59000×0.0007 = 1000 + 30 + 41.3 = 1071.3；qty = 100/1071.3 = 0.09334… → 步进 0.093
  assert(r.ok && near(r.perUnitLoss, 1071.3), '单位损失含两腿费用 1071.3')
  assert(r.ok && near(r.maxQty, 0.093), '步进取整后 maxQty 0.093')
  assert(r.ok && near(r.notional, 5580) && near(r.margin, 558), '名义 5580 / 保证金 558')
  assert(r.ok && r.bindingConstraint === 'risk_budget', 'bindingConstraint=risk_budget')

  const same = maxPositionByRisk({ riskBudget: 100, entryPrice: 60000, stopPrice: 60000, leverage: 10 })
  assert(!same.ok && same.bindingConstraint === null, '入场=止损 → 拒绝（无约束名）')
  const tiny = maxPositionByRisk({ riskBudget: 1, entryPrice: 60000, stopPrice: 59000, leverage: 10, stepSize: 0.001 })
  assert(!tiny.ok && tiny.bindingConstraint === 'step_rounding', '预算不足步进取整为零 → 拒绝（step_rounding）')
  const minN = maxPositionByRisk({ riskBudget: 100, entryPrice: 60000, stopPrice: 59000, leverage: 10, minNotional: 10000 })
  assert(!minN.ok && minN.bindingConstraint === 'min_notional', '低于最小名义 → 拒绝（min_notional）')
  const expo = maxPositionByRisk({ riskBudget: 100, entryPrice: 60000, stopPrice: 59000, leverage: 10, portfolioExposure: 50 })
  assert(expo.ok && expo.bindingConstraint === 'portfolio_exposure' && near(expo.maxQty, 50 / 1071.3), '组合敞口更紧 → bindingConstraint=portfolio_exposure')
}

console.log('\n[永续] 资金费率时效（fundingFreshness）')
{
  const asOf = 1_700_000_000_000
  const stale = fundingFreshness(asOf - (FUNDING_INTERVAL_MS + FUNDING_GRACE_MS + 1), asOf)
  assert(stale.stale && stale.reason !== null && stale.reason.includes('funding_stale'), '超过 8h+1h → stale 且注明 funding_stale')
  const fresh = fundingFreshness(asOf - FUNDING_INTERVAL_MS, asOf)
  assert(!fresh.stale, '恰好一个结算间隔（8h ≤ 8h+1h）→ 新鲜')
  const missing = fundingFreshness(null, asOf)
  assert(!missing.stale && missing.latestFundingTime === null, '无数据走缺失分支，不是过期分支')
  const custom = fundingFreshness(asOf - 2 * 3600_000, asOf, 3600_000, 1800_000)
  assert(custom.stale, '可配置间隔/宽限（1h+0.5h）同样生效')
}

console.log('\n[永续] 强平价纪律')
{
  assert(liquidationInfo(null).price === null, '未提供 → 不输出估算')
  const u = liquidationInfo(55000)
  assert(u.price === 55000 && u.source === 'user_app', '用户录入值原样展示并标来源')
}

console.log('\n[事件] EV 与盈亏平衡')
{
  // stake 100 / payout 180：win 80 / lose 100；平衡胜率 = 100/180 ≈ 0.5556
  const ev = evaluateEvent({ stake: 100, totalPayout: 180, direction: 'above' }, 0.6)
  // EV = 0.6×80 − 0.4×100 = 48 − 40 = 8
  assert(near(ev.breakevenWinRate, 100 / 180), '盈亏平衡胜率 = stake/totalPayout')
  assert(near(ev.winAmount, 80) && near(ev.loseAmount, 100), 'win/lose 金额分列')
  assert(ev.expectedNet !== null && near(ev.expectedNet, 8), 'EV = 8')

  const tie = evaluateEvent({ stake: 100, totalPayout: 180, direction: 'above', tieRefund: true }, 0.6, 0.05)
  // 平价退款 5%：pLose = 0.35；EV = 48 − 35 = 13
  assert(tie.hasTieRefund && tie.expectedNet !== null && near(tie.expectedNet, 13), '平价退款分支 EV = 13')

  const noProb = evaluateEvent({ stake: 100, totalPayout: 180, direction: 'above' }, null)
  assert(noProb.expectedNet === null && noProb.unavailableReason !== null, '概率不可用 → EV null + 原因')

  const badProb = evaluateEvent({ stake: 100, totalPayout: 180, direction: 'above' }, 1.2)
  assert(badProb.expectedNet === null, '非法概率（>1）拒绝计算')

  // below 方向由调用方传入 P(below)，公式不变
  const below = evaluateEvent({ stake: 50, totalPayout: 90, direction: 'below' }, 0.4)
  assert(below.expectedNet !== null && near(below.expectedNet, 0.4 * 40 - 0.6 * 50), 'below 方向 EV = -14')
}

console.log('\n[事件] 期限桶匹配')
{
  const m1 = matchHorizon(10 * 60_000, EVENT_HORIZON_BUCKETS)
  assert(m1.matched && m1.horizon === '10m' && !m1.researchOnly, '10 分钟 → 10m 桶')
  const m2 = matchHorizon(9 * 60_000, EVENT_HORIZON_BUCKETS)
  assert(m2.matched && m2.horizon === '10m', '9 分钟（偏差 10%）仍匹配 10m')
  const m3 = matchHorizon(3 * 60_000, EVENT_HORIZON_BUCKETS)
  assert(!m3.matched, '3 分钟剩余不得复用 10m 预测（偏差 70%）')
  const m4 = matchHorizon(6.5 * 24 * 60 * 60_000, EVENT_HORIZON_BUCKETS)
  assert(m4.matched && m4.horizon === '1w' && m4.researchOnly, '6.5 天 → 1w 研究模式桶')
  const m5 = matchHorizon(-1000, EVENT_HORIZON_BUCKETS)
  assert(!m5.matched, '已到期 → 不匹配')
}

console.log('\n[事件] 到期结算价：行情缺口不得用相邻价格冒充')
{
  const expiry = 1_700_000_000_000
  const covering = pickExpiryClose([{ closeTime: expiry - 5_000, close: '60123.4' }], expiry, 60_000)
  assert(covering !== null && near(covering, 60123.4), '覆盖到期分钟的 K 线 → 用其收盘价')
  const gap = pickExpiryClose([{ closeTime: expiry - 61_000, close: '60000' }], expiry, 60_000)
  assert(gap === null, '到期分钟缺口（最近收盘早于到期 61s）→ null，留待补洞（修复前会用相邻价格冒充）')
  const empty = pickExpiryClose([], expiry, 60_000)
  assert(empty === null, '完全无数据 → null')
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
