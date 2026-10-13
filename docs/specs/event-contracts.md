# Spec：事件合约研究（event-contracts）

> 状态：partial

> 修复验收（2026-10-09 八轮）：(C3) 报价级用户确认——`POST /api/event-quotes/:id/confirm` 写 `quote.userConfirmedOutcome` 并同步该报价下尚未确认的预测（`status=user_confirmed`），与预测级确认语义一致、estimated 轨道互不覆盖。(C4) 期限语义契约——`EventQuoteInputSchema` 新增 `expiryKind: 'duration'|'exact'`（默认 duration 兼容旧客户端）与可选 `horizon`；服务端校验：submitted 订单必须 `expiryKind=exact` 且 `expiryAt>now`；duration 模式必须落入 `EVENT_HORIZON_BUCKETS`（容差内）且与声明 horizon 一致，否则 400（不合法组合不再静默入库）。

> 修复验收（2026-10-09 七轮）：(1) 到期研究估算的行情缺口校验——`pickExpiryClose`（`server/src/research/event/calc.ts`）要求最后一根已收盘 1m K 线的 closeTime 落在到期前 60 秒内才作为结算估算价；到期分钟缺口时留空待补洞后重试，不再用相邻时刻价格冒充（修复前 `settleExpiredQuotes` 只防全缺不防局部缺口；回归锚点见 `scripts/perp-event-calc-check.ts`）。(2) 预测记录冻结推理特征向量——`predictForTarget` 返回实际使用的特征，`POST /api/predictions` 落库 `predictions.features`（修复前恒为 `{}`，"特征冻结可复现"不成立）。

> 修复验收（2026-10-08 六轮，P2）：已提交订单的「到期方式」锁死为 App 固定到期时刻——切到已提交时禁用「现在+期限」选项且不可切回、精确时间不预填（等待抄录 App 实际值，预填会被当成 App 数据）、提交时服务端契约校验兜底。

> 修复验收（2026-10-08 三轮，P1）：(1) 三分支互斥概率——pUp=P(高于平价区间上界)、pTie=平价区间、pDown=1−pUp−pTie 由同一结算规则生成（`mutuallyExclusiveThreeWay`）；EV 使用互斥分支（回归锚点 0.49/0.02/0.49、投入 100/总返还 200 → EV=0；修复前 pUp 取执行价中心阈值、平价双重计入输出 EV=+2 并误过参与门槛，见 `scripts/p1-regression-check.ts`）。(2) 已提交订单到期时间录入——表单「到期方式」二选一：预览=录入时刻+期限；已提交=直接抄录 App 显示的固定到期时刻（提交时强制切到精确模式并校验晚于当前时刻），9 分钟前购买的 10 分钟单不再获得新的完整期限。

> 修复验收（2026-10-08 二轮）：概率→EV→决策闭环打通——研究流水线内完成 期限匹配→模型门控→特征→research-py 分位数→P(结算价高于执行价)→EV，conditional_entry 需同时满足 期限匹配∧概率可用∧EV>0（decisions.ts decideEvent，负 EV/零 EV/无概率一律 wait）；真实链路验证：执行价高于现价 0.2% → pUp=5%、EV=−9.1、决策 wait。

> 实现状态（2026-10-01）：报价存储 + /api/event-quotes CRUD（stake/totalPayout 分列、关键字段禁改、EV 评估、期限桶匹配）与 worker 到期研究估算（estimatedOutcome 与用户确认互不覆盖）已落地；EV 的概率支路等模型注册表就绪后接通。

## 目标

定义 Binance Event Contracts（事件合约）场景的研究流程：报价手动录入、预测目标语义、期限桶匹配、期望净收益（EV）与盈亏平衡胜率计算、平价退款处理、输入冻结与到期结算。官方仅通过 App 提供该产品、**不开放 API**（见币安官方说明，核验日期 2026-09-30），因此报价由用户从 App 手动录入，结算以用户确认为准。本场景不自动抓取报价、不连接交易账户、不做收益承诺。

## 已确定决策

- 报价字段与录入依据：官方无 API、仅 App 展示，故以下字段全部由用户从 App 抄录，系统不抓价、不补价：

| 字段 | 说明 |
| --- | --- |
| `strikePrice` | 执行价 |
| `expiryAt` | 到期时间 |
| `stake` | 投入金额 |
| `totalPayout` | **含本金的总返还**（不是净收益） |
| 执行参考价 | App 展示的结算参考价来源说明 |
| 录入时间 / 冻结 `asOf` / 剩余期限 | 保存报价时冻结 |

- `stake` 与 `totalPayout` 在存储、计算与展示中始终分列，不得混用。
- 官方支持的期限为 10m / 30m / 1h / 1d 四种；**1w 属于研究预测模式**，界面显著标注「研究模式」，不得显示为币安已有事件合约产品。
- 预测目标语义：预测「`expiryAt` 到期时刻标的价格相对**已有执行价** `strikePrice` 的高/低」，与「从现在起涨跌」严格区分；报价创建时冻结 `asOf` 与剩余期限。
- 期限桶匹配：模型按期限桶（10m/30m/1h/1d/1w）分别训练与验证；`|剩余期限 − 模型期限|` 超出容差（默认 20%）或该期限未验证 → 返回 `unavailable` 及原因；**不得把完整 10 分钟预测复用给只剩 3 分钟的订单**。
- EV 与盈亏平衡由代码计算：期望净收益 `EV = pWin × (totalPayout − stake) − pLose × stake`；无平价退款时盈亏平衡胜率 `= stake / totalPayout`（示例：stake=100、totalPayout=180 时盈亏平衡胜率≈55.6%，pWin=0.6 时 EV=0.6×80−0.4×100=8；示例数字仅用于说明公式，非任何真实预测）；**预测概率唯一来自统计模块**（见 `docs/specs/prediction.md`），LLM 不生成或修改概率。
- 平价退款（到期价格等于执行价按官方规则退款）单独分支处理，不并入胜负两分支的 EV 公式。
- 倒计时与剩余期限由 `expiryAt` 实时派生，不入库存储；派生以服务端时钟为准，避免用户本机时钟偏差影响剩余期限判断。
- 到期后结果追加不覆盖：worker 到期任务取分钟级已收盘 K 线给出「研究估算」结果；用户在 UI 确认真实订单结算；两者分别统计（`predictions.outcomeSource: estimated | user_confirmed`）。
- 预测记录冻结：`snapshotId`、`featureVersion`、特征向量、模型版本、报价输入随预测记录一并冻结，可复现。

## 数据与接口

- 表 `event_quotes`：`symbol`、`strikePrice`、`expiryAt`、`stake`、`totalPayout`、执行参考价、录入时间、冻结的 `asOf` 与剩余期限；`outcome`/`outcomeSource` 到期后追加写入。
- API `/api/event-quotes` CRUD：请求/响应由 `shared/src/contract/` 的 zod schema 约束。
- 表 `predictions`：关联报价、`snapshotId`、`featureVersion`、模型版本、冻结特征向量、概率与分位输出、到期结果与 `outcomeSource`。
- 计算模块：`server/src/research/event/`（EV/盈亏平衡/倒计时/期限匹配纯函数）、`server/src/research/prediction/`（特征与模型调用编排）；到期结算任务由 worker（pg-boss）到期触发。
- 结果契约：run 结果 `product: 'event'`，携带期限预测、盈亏平衡胜率、EV、倒计时；1w 结果附带研究模式标识；EV、盈亏平衡胜率挂代码计算路径，概率挂 `predictions` 记录。

## 流程

1. 用户从 App 抄录报价并录入表单（期限/执行价/到期时间/投入/总返还/执行参考价），保存时冻结 `asOf` 与剩余期限。
2. 期限匹配检查：剩余期限落入已验证期限桶且在容差内 → 继续；否则返回 `unavailable` 及原因（期限未验证 / 超出容差）。
3. 预测：从冻结快照计算特征（`featureVersion`），调用当前已发布且适用该期限桶的模型版本，得到 pWin/pLose 概率；模型未就绪或数据过期 → 明确不可用。
4. 代码计算 EV、盈亏平衡胜率、倒计时；平价退款分支单独展示。
5. 结果经校验器（市场类型、数据时效、数值可溯源、概率来源）后发布；1w 结果带显著研究模式标识。
6. 到期后：worker 到期任务读取分钟级已收盘 K 线，对比到期时刻标的价格与 `strikePrice`，写入「研究估算」结果；用户在 UI 确认真实订单结算后写入 `user_confirmed` 结果；两类结果分别统计、互不覆盖，复盘状态在结果卡可见。

## 边界与失败处理

- 报价过期（`expiryAt` 已过且未结算）→ 不提供新预测，仅可补录结算结果。
- 报价录入后 `strikePrice`/`expiryAt`/`stake`/`totalPayout` 不可静默修改；更正报价 = 作废旧报价并新建，保留历史记录可追溯。
- 不支持或未验证的期限 → 返回 `unavailable`，注明「该期限未验证」。
- 剩余期限与模型期限不匹配（超出 20% 容差）→ 返回 `unavailable`，注明期限不匹配，不复用其他期限的预测。
- 模型未就绪 / 数据过期 / 快照缺失 → 概率与 EV 不可用并给出原因，界面明确展示。
- 到期时刻分钟行情缺失（缺口未补）→ 研究估算不可用，等待补洞或用户确认；不得用相邻时刻价格冒充到期时刻价格。
- 用户录入的报价与官方规则明显不符（如期限不在支持集合）→ 拒绝保存并提示核对 App。
- 数据库不可用 → 停止新增报价研究与发布，界面显示实际可用状态。
- 用户在结算确认中录入的结果与分钟行情研究估算冲突 → 两条记录都保留并展示差异，统计时按 `outcomeSource` 分列，不用一方覆盖另一方。

## 验收用例

- [ ] EV、盈亏平衡胜率、平价退款分支的数值与代码单测锚定一致；`stake` 与 `totalPayout` 在存储与展示中始终分列。
- [ ] 「到期相对执行价高/低」与「从现在起涨跌」在文案与数据结构上可区分，互不混用。
- [ ] 剩余期限 3 分钟的订单调用 10m 期限模型 → 返回 `unavailable`（超出 20% 容差），不复用完整 10 分钟预测。
- [ ] 1w 期限结果带显著「研究模式」标识，且不出现在官方期限列表中。
- [ ] 报价创建后修改行情或重新提问，预测记录中的快照、特征、模型版本保持冻结可复现。
- [ ] 到期后 worker 写入 `estimated` 结果；用户确认后写入 `user_confirmed`；两条记录并存、分别统计，互不覆盖。
- [ ] 到期行情缺口未补时研究估算不可用，且不会用相邻时刻价格替代。
- [ ] 过期报价 / 不支持期限 / 数据过期三种不可用返回各自带明确原因码。
- [ ] LLM 输出中的概率数值被校验器拒绝；概率字段只能来自统计模块。
- [ ] 倒计时与剩余期限以服务端时钟派生，与本机时钟偏差不影响期限桶判断。

## 参考来源

- 币安事件合约官方说明（仅 App 提供、不开放 API；四种官方期限；核验日期 2026-09-30）：https://www.binance.com/en/support/faq/detail/172247f1c4b8401ab106fb63900f3825
- `docs/specs/prediction.md`（期限桶、模型版本、概率唯一来源）
- `docs/specs/market-data.md`（分钟级已收盘行情与到期估算依据）
- `docs/specs/api-storage.md`（`event_quotes` / `predictions` 实体与 `/api/event-quotes` 契约）
- `docs/references/binance-products-and-apis.md`（产品限制说明与核验日期）
