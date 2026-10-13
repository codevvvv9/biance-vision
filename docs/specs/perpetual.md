# Spec：永续合约研究（perpetual）

> 状态：partial

> 评审修复（2026-10-13，F1）：无止损持仓风险约束不可用——`decisionPolicy` 已有持仓路径新增门控：`position.stopPrice === null` → `wait` 并要求补全止损（修复前：假设止损（入场±2×ATR）算出的 `riskCap.ok` 被当作已有持仓已通过风险约束，可输出 `hold`）；`perpetualAnalyzer` 的假设止损上限在 `riskCap.reason` 显式标注为演示值、无止损时 `reducePlan.reason` 不再谎称「增量损失在预算内」；stages 输出「未设置止损」事实声明。回归锚点：`scripts/p1-regression-check.ts` [评审 F1]（无止损 → wait；有止损+结构支持 → hold 不误伤）。

> 修复验收（2026-10-09 九轮，P1）：保护止损校验区分新仓/已有持仓——`validator.ts positionLogic` 增加 `isExistingPosition` 与 `lastPrice`：已有持仓浮盈后上移的止损（多头 stop>入场、空头 stop<入场）是合法保护止损，有效性结合当前价判断（多头 stop<last、空头 stop>last；越过市价=已触发或无效 → direction_logic 拒绝）；新仓计划止损仍必须在入场亏损侧（不放松）。stages 传入快照末根成交价（checkpoint 持久化）。评审复现锚点：多头入场 60000/止损 65000/当前 66000 —— 修复前被「止损未低于入场」误拒，修复后通过；止损 67000>当前价 66000 仍拒。回归锚点见 `scripts/p1-regression-check.ts` [九轮-1]。

> 修复验收（2026-10-09 八轮）：(A1) 费率两档单一来源——`research/perp/calc.ts` 的 `FeeConfig{takerRate,makerRate,slippageRate}`/`resolveFeeLegs` 为唯一定义（限价/回踩入场用 maker 0.0002、市价 taker 0.0005，滑点 0.0002 只计市价平仓腿），`perpetualAnalyzer` 不再平行定义费率；结果输出 `feeLegs` 注明各腿费率档。费率/stepSize/minNotional/funding 窗口由 `freezeRunConfig()` 从 Agent 配置 `ruleParams.perp` 冻结进 `frozenConfig`（纳入 configHash）。(A2) 资金费率过期检测——`fundingFreshness`：最新一条距 asOf 超过「结算间隔 8h+宽限 1h」（可配置）→ 情景不可用并注明 `funding_stale`，不静默沿用旧数据。(A3) 仓位上限多约束取最小——`maxPositionByRisk` 计入 minNotional/组合敞口/步进取整，输出 `bindingConstraint`（risk_budget/portfolio_exposure/step_rounding/min_notional）。(A4) stale 持仓降级——过期持仓只输出一般结构研究：marginUsed/pnlPoints/fundingScenarios/riskCap/reducePlan/incremental 全部为空或带降级原因，missingInputs 注明，decision 保持 `request_reconfirm`。(A5) exit 动作带两条条件——触发条件（持仓依据的结构失效已确认，条件研究非即时指令）与解除条件（失效被收回/同方向新 setup 确认后作废）。回归锚点见 `scripts/p1-regression-check.ts`、`scripts/perp-event-calc-check.ts`。

> 修复验收（2026-10-09 七轮）：neutral setup 守卫——已确认 setup 无方向（neutral）时输出 `wait` 且不带 side，不再被 `direction==='bear'?'short':'long'` 误映射为开多（`decisionPolicy.ts`；回归锚点 `scripts/p1-regression-check.ts` [P1-6]）。

> 修复验收（2026-10-08 六轮，P1）：ROE 单位修复——分子（整笔净盈亏）与分母（保证金）都必须经 fromDec 还原为 USDT 后再相除；锚点：1 BTC @60000、10x、66000 平仓 → 净 5923.8 / 6000 = 0.9873（修复前分母仍是 1e8 刻度 BigInt → ROE 舍入成 0）。见 research:p1-check。

> 修复验收（2026-10-08 三轮，P1）：(1) 退出方向语义——引擎 `invalidation.direction` 是**失效的原信号方向**，持仓退出条件=新近失效事件方向与持仓方向**一致**（多头持仓遇多头结构失效 → exit）；修复前读反（同向失效 hold、反向失效误 exit），回归锚点见 `scripts/p1-regression-check.ts`。(2) 双视角数值——「整笔交易净盈亏」保持入场价基准（含已发生入场费），「从现在继续持有的增量风险」（到止损盈亏、矩阵增量列、减仓判断）全部改为**当前价基准**且扣未来平仓费：入场 60000/当前 66000/止损 65000/数量 1 → 增量到止损 ≈ −1000−费（不再输出 +5000）；止损在盈利侧时不触发减仓。(3) 资金费率缺失——funding 序列为空时情景列表为空并标注「数据缺失」，不再以 0.0001 默认费率伪装「最近均值」。

> 实现状态（2026-10-01）：持仓存储 + /api/portfolio CRUD（confirmedAt/staleAfter 派生、强平价仅存用户录入值）与计划盈亏/费用/资金费率/风险上限的运行链路已落地（research:smoke 覆盖）；Admin 持仓管理页与 LLM 叙述增强待 Stage 5/6。

## 目标

定义 Binance USDT 永续场景的研究流程：用户确认的结构化持仓输入、多空动作域、计划盈亏矩阵、费用与资金费率情景、风险预算下的仓位上限、强平价展示纪律。本场景是**研究**工具：不连接交易账户、不自动下单、不做收益承诺；一切数值由代码计算，LLM 只负责解释。

## 已确定决策

- 持仓信息全部来自用户手动录入并显式确认，携带 `confirmedAt` 与 `staleAfter`；**持仓未知不等于空仓**，缺少必要信息时输出 `missingInputs`，不提供伪精确的个性化仓位比例。
- 动作域固定为六种，建议由情景与约束产生，不把结构信号直接映射成买卖：

| 动作 | 语义 | 典型前置条件 |
| --- | --- | --- |
| 做多 / 做空 | 条件式入场计划（conditional_entry，区分方向） | 已确认结构 + 入场/止损/失效条件 + 风险预算 |
| 等待 | 当前不行动（wait） | 证据不足、结构冲突或处于不交易区 |
| 持有 | 维持已有仓位（hold） | 已有确认持仓且失效条件未触发 |
| 减仓 | 部分退出已有仓位（reduce） | 已有确认持仓且出现反对证据 |
| 退出条件 | 给出退出的触发条件而非即时指令（exit 条件式） | 已有确认持仓 |

- 计划盈亏矩阵、费用、资金费率情景、仓位上限全部由代码计算（纯函数）；**预测概率唯一来自统计模块**（见 `docs/specs/prediction.md`），LLM 不生成或修改任何数值与概率。
- 盈亏双视角：整笔净盈亏=入场价基准（含已发生入场费与平仓费）；增量视角=当前价基准（只含未来平仓费）——到止损风险、减仓判断、矩阵增量列都用增量基准，已发生的浮盈/浮亏不重复计入未来风险。
- 退出方向语义：`invalidation.direction` 是失效的原信号方向；只有与持仓方向**一致**的结构失效才构成本仓退出条件，反方向结构的失效与本仓无关。
- 费用按 taker/maker 两档费率计算，费率参数可配置并随 `configVersion` 冻结。
- 资金费率情景用近期 funding 序列 × 持仓方向 × 预计持有时长给出多档估算（正费率多方付、空方收，负费率反之），明确标注为估算而非确定值。
- 强平价纪律：精确强平价只能展示用户从 App 录入的数据；缺少账户与保证金档位信息时，输出显著标注「简化估算，非真实强平价」的结果或不输出，**不得把简化估算称为真实强平价**。
- Brooks 经验统计（H2≈60%、80% 规则族等）不写入本场景的判定逻辑。
- 数据过期、快照缺失、模型未就绪时明确返回不可用或降级，不编造数值。

## 数据与接口

- 表 `portfolio_positions`（全部为用户录入并确认）：

| 字段 | 说明 |
| --- | --- |
| `symbol` | 交易对（usdm_perp 市场） |
| `side` | long / short |
| `qty` | 持仓数量（decimal） |
| `entryPrice` | 开仓均价（decimal） |
| `leverage` | 杠杆倍数 |
| `marginMode` | cross / isolated |
| `riskBudget` | 单笔可承受损失金额 |
| `confirmedAt` | 用户确认时间 |
| `staleAfter` | 确认失效时间，超过未再确认标记 stale |

- API `/api/portfolio` CRUD：请求/响应由 `shared/src/contract/` 的 zod schema 约束；写操作携带确认语义并记录 `confirmedAt`。
- 行情输入：`market_candles` / `market_snapshots`（`snapshotId`/`asOf`，只用已收盘数据，实时价格另标 `priceAsOf`）；资金费率与持仓量来自 `/api/market/funding`、`/api/market/open-interest`（marketType=`usdm_perp`）。
- 计算模块：`server/src/portfolio/`（仓位与风险纯函数）、`server/src/research/perp/`（`ProductAnalyzer` 接口的 perp 实现，注册进产品分析器注册表）。
- 结果契约：run 结果 `product: 'perp'`，携带 `snapshotId`、`ruleVersion`、`configVersion`；价格、关键位、仓位上限等数值挂 `evidenceId` 或由代码计算路径标注。

## 流程

1. 用户录入或确认持仓，系统写入 `confirmedAt`/`staleAfter`。
2. 研究流水线 `product_analysis` 阶段调用 perp 分析器：读取冻结快照与结构事件，代码完成全部计算，LLM 仅组织解释。
3. 计划盈亏矩阵：对给定入场价、止损、目标与数量，输出各情景盈亏（含开仓/平仓两端的 taker 或 maker 费用）；矩阵覆盖各候选动作（多/空/等待/持有/减仓），校验器检查 entry/stop/target 方向逻辑。
4. 资金费率情景：取近期 funding 序列（窗口长度可配）× 方向 × 预计持有时长，给出多档累计资金费估算并标注假设；funding 数据缺失时情景列表为空并标注「数据缺失」，不以默认费率伪装实际统计。
5. 仓位上限：`riskBudget / 每单位止损距离（含费用）`，再依次受可用资金、tickSize/stepSize、最小名义金额、组合暴露约束取最小者；输出时说明实际起作用的约束，并注明这是计划约束、不保证跳空或滑点下实际损失不超预算。
6. 保证金与强平：区分 cross/isolated 标注；展示用户录入的 App 强平价；缺账户与档位信息时给显著标注的简化估算或不输出。
7. 结果经校验器（市场类型、数据时效、数值可溯源、方向逻辑、持仓必要信息）通过后发布；失败在预算内修复一次，再失败返回 `insufficient_evidence`。

## 边界与失败处理

- 持仓不完整（缺 qty/entryPrice/leverage 等必要字段）→ 输出 `missingInputs`，个性化建议降级为一般市场研究。
- 持仓超过 `staleAfter` → 标记 stale，要求用户重新确认后才给个性化计划。
- 保证金档位/账户信息未知 → 不输出真实强平价。
- funding/OI 数据缺失或过期 → 资金费率情景返回不可用及原因，其余模块不受影响。
- 组合暴露超限 → 仓位上限按约束收紧并说明；不得为提高仓位而放松已确认的风险预算。
- 费率等参数变更只在新配置版本发布后生效；已有 run 继续使用启动时 `configVersion`。
- 数据库不可用 → 停止新增研究与发布，界面显示实际可用状态（见 `docs/specs/api-storage.md`）。

## 验收用例

- [ ] 多空两方向完整持仓：计划盈亏矩阵、taker/maker 两档费用、资金费率多档情景的数值与代码单测锚定一致。
- [ ] 仓位上限同时受 riskBudget、资金、tick/step、最小名义、组合暴露约束，输出取最小值并说明触发约束。
- [ ] 录入 App 强平价时原样展示并标注来源为用户录入；未录入且缺保证金档位时输出「简化估算，非真实强平价」或不输出，全文不出现把估算称为真实强平价的表述。
- [ ] 持仓缺 `entryPrice` → 返回 `missingInputs` 且不给个性化仓位比例。
- [ ] 持仓 stale → 界面提示重新确认，run 降级为一般研究并可见降级原因。
- [ ] funding 数据过期 → 资金费率情景明确不可用并给出原因，其余结果正常发布。
- [ ] funding 数据为空 → 情景列表为空且 note 标注缺失（不出现 0.0001 类默认值冒充均值）。
- [ ] 增量风险按当前价：入场 60000/当前 66000/止损 65000/数量 1 → 到止损增量 ≈ −1000−平仓费；止损在盈利侧时不触发减仓（`research:p1-check` 锚定）。
- [ ] 多头持仓遇多头结构失效 → exit；遇空头结构失效不因此退出（`research:p1-check` 锚定）。
- [ ] 六种动作域均能按前置条件产出，且允许 `wait` / `insufficient_evidence` 作为合法结论。
- [ ] 输出中的每个价格、关键位、仓位上限数值可追溯到代码计算或 `evidenceId`；LLM 文本中出现的概率数值被校验器拒绝。
- [ ] 全程不出现收益承诺与固定胜率表述。

## 参考来源

- `docs/specs/market-data.md`（行情快照、收盘约束、资金费率与 OI 数据）
- `docs/specs/brooks-engine.md`（结构事件与关键位来源）
- `docs/specs/prediction.md`（概率唯一来源纪律）
- `docs/specs/api-storage.md`（`portfolio_positions` 实体与 `/api/portfolio` 契约）
- `docs/specs/admin-security.md`（费率与能力配置、版本冻结）
- `docs/references/binance-products-and-apis.md`（fundingRate / openInterestHist 端点契约）
