# 产品规格：Brooks 加密市场研究 Agent

> 状态：planned

## 目标

定义产品的定位、用户角色、三类核心流程（永续研究、事件合约研究、教学）、支持与不支持的边界，以及全局术语表。本 spec 是其余各 spec 的产品语义依据：任何技术行为与本文冲突时，以本文为准并回写修订。

## 已确定决策

- 产品是**研究**工具，不是交易工具：基于 Brooks 价格行为方法，对加密市场输出可审计、可追溯的研究结论。
- 支持两类标的：
  1. **Binance USDT 永续**（公开合约数据：交易/标记/指数价格、资金费率、持仓量 OI）。
  2. **Binance Event Contracts**（官方无 API、仅 App 提供）。报价由用户手动录入：执行价 `strikePrice`、到期时间 `expiryAt`、投入金额 `stake`、**含本金的总返还** `totalPayout`、执行参考价。
- 支持期限 10m / 30m / 1h / 1d / 1w。**1w 属于研究预测**：界面与输出必须显著标注「研究模式」，不得显示为币安已有事件合约产品（官方仅 10m/30m/1h/1d）。
- 执行边界：不连接交易账户、不自动下单、不做收益承诺。
- 强平价纪律：精确强平价只能展示用户从 App 录入的数据；缺少账户与保证金档位信息时，不得把简化估算称为真实强平价（输出「简化估算，非真实强平价」或不输出）。
- 数值纪律：计划盈亏、费用、资金费率情景、仓位上限、EV、盈亏平衡胜率全部由代码计算；**预测概率唯一来自统计模块（scikit-learn 分位数梯度提升），LLM 不生成或修改概率**；模型未就绪、期限未验证、数据过期时明确返回不可用。
- Brooks 的 H2≈60%、80% 规则族等是其**在美股股指期货**的经验统计，仅作体系背景展示；不得写成本工具对任何币种/周期的预测胜率，引擎不将其写入判定逻辑。
- 预测目标语义：事件合约预测「**到期时刻**标的价格相对**已有执行价**的高/低」，与「从现在起涨跌」严格区分；不得把完整 10 分钟预测复用给只剩 3 分钟的订单（期限桶容差默认 20%，不匹配即不可用）。
- 数据权威：新业务数据以 PostgreSQL 为唯一权威；数据库不可用时停止新增研究与发布，界面显示实际可用状态。

### 用户角色

| 角色 | 能力 |
| --- | --- |
| 普通用户（user） | 发起研究、录入并确认持仓与事件报价、查看证据与结论、确认到期结算 |
| 超级管理员（superadmin） | 上述全部 + 能力配置（chat/embedding/rerank/vision/search）、知识导入与发布、Agent 版本发布/回滚、评测管理 |

## 数据与接口

产品层依赖以下契约与端点族（细节见对应 spec）：

- 行情快照：`snapshotId` / `asOf`（docs/specs/market-data.md）；实时价格另标 `priceAsOf`。
- 研究运行：`POST /api/research/runs`、`GET /api/research/runs/:id/events`（SSE）、`GET /api/research/runs/:id/result`、`POST /api/research/runs/:id/cancel`（docs/specs/api-storage.md）。
- 持仓：`/api/portfolio`（字段含 symbol/side/qty/entryPrice/leverage/marginMode/riskBudget/confirmedAt/staleAfter，见 docs/specs/perpetual.md）。
- 事件报价：`/api/event-quotes`（strikePrice/expiryAt/stake/totalPayout 分列，见 docs/specs/event-contracts.md）。
- 预测：`/api/predictions/*`（概率唯一来自统计模块，见 docs/specs/prediction.md）。

## 流程

### 永续研究流程

1. 用户选择交易对与期限，（可选）录入或确认结构化持仓；持仓带 `confirmedAt`，超过 `staleAfter` 标为过期，过期不当作当前事实。
2. 系统创建 research run：意图规划 → 冻结行情快照 → 结构计算 → 知识与反证检索 → 产品分析（计划盈亏矩阵、费用、资金费率情景、仓位上限）→ 风险/证据校验 → 发布。
3. 用户收到条件式结论：动作域为做多/做空/等待/持有/减仓/退出条件，附支持/反对证据与失效条件；所有关键数值可点击溯源。

### 事件合约研究流程

1. 用户按 App 实际报价手动录入 strikePrice / expiryAt / stake / totalPayout / 执行参考价；创建时冻结 `asOf` 与剩余期限。
2. 系统做期限桶匹配（10m/30m/1h/1d/1w，容差默认 20%）；匹配且模型就绪时给出预测概率，代码计算 EV 与盈亏平衡胜率；不匹配或模型未就绪返回不可用及原因。
3. 到期后：worker 用分钟级已收盘 K 线给出「研究估算」结果；用户在 UI 确认真实订单结算；两者分别统计。

### 教学流程

1. 概念问答（如「H2 是什么」）走知识检索：返回定义、成立条件、上下文、失效条件、易混淆概念与反例，引用可定位到原文页码/图号。
2. 历史复盘：指定历史 `asOf`，仅用当时已收盘数据与当时可知的证据重建结构；不允许用今天的信息解释过去的决策。

## 边界与失败处理

- 不支持：连接交易账户、自动下单、收益承诺、把 Brooks 经验统计当作本品种胜率、把简化估算称为真实强平价、事件合约自动报价抓取（官方无 API）。
- 数据过期、模型训练中、报价缺失、引用不足、期限未验证：均返回明确的不可用状态与原因，不静默降级为猜测。
- 数据库不可用：停止新增研究与发布，界面显示实际可用状态；已有结果只读。
- 持仓信息不完整或过期：按「持仓未知」处理，不假设空仓；个性化仓位建议要求用户确认风险预算。

## 验收用例

- [ ] 永续研究全链路：创建 run → SSE 进度 → 校验后结果，关键数值均由代码计算且可溯源。
- [ ] 事件合约：录入报价 → 期限匹配 → EV/盈亏平衡由代码计算；剩余期限与模型期限偏差超 20% 时返回不可用。
- [ ] 1w 期限输出带显著「研究模式」标识，且不出现在「币安已有产品」的表述中。
- [ ] 缺少保证金档位时，强平价不输出或标注「简化估算，非真实强平价」。
- [ ] 概率字段在模型未就绪/数据过期时为空并附原因；任何输出不含 H2≈60%/80% 作为本品种胜率的表述。
- [ ] 数据库不可用时创建 run 返回 503 + `storage: unavailable`，界面显示实际可用状态。
- [ ] 概念问答引用可定位到页码/图号；历史复盘严格使用 `asOf` 当时可知数据。

## 术语表

| 术语 | 含义 |
| --- | --- |
| Always In | Brooks 概念：若必须持仓则非多即空的方向判断；本工具仅作结构上下文展示 |
| H1–H4 / L1–L4 | 回调中的顺趋势入场计数（H2 = 二次进场）；仅为结构事件，不附带预测胜率 |
| strike / strikePrice | 事件合约执行价 |
| stake | 事件合约投入金额（本金） |
| totalPayout | 事件合约**含本金**的总返还 |
| EV | 期望净收益：`pWin×(totalPayout−stake) − pLose×stake`，代码计算 |
| 盈亏平衡胜率 | 无平价退款时 `stake / totalPayout`，代码计算 |
| snapshotId / asOf | 一次研究冻结的行情快照与其截止时间；各周期只用 `closeTime ≤ asOf` 的已收盘数据 |
| priceAsOf | 实时价格单独标注的时间，不混入已收盘 K 线信号 |
| knownAt | 结构事件实际可被知道的时间（通常晚于图形上的 pivot 位置） |
| provisional | 未确认的结构/状态标注；模型与回放须到 knownAt 才能使用 |
| 期限桶 | 预测模型按 10m/30m/1h/1d/1w 分别训练与验证的期限分组 |

## 参考来源

- docs/specs/market-data.md、docs/specs/brooks-engine.md、docs/specs/perpetual.md、docs/specs/event-contracts.md、docs/specs/prediction.md、docs/specs/api-storage.md
- docs/brooks-agent-architecture.md（调研结论）
- docs/brooks-price-action-manual.md（理论体系底稿）
- Brooks 官方术语表：https://www.brookstradingcourse.com/price-action-trading-terms-glossary/
- 币安事件合约说明（核验日期 2026-09-30）：https://www.binance.com/en/support/faq/detail/172247f1c4b8401ab106fb63900f3825
