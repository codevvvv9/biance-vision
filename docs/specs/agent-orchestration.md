# Agent 编排

> 状态：partial

> 修复（2026-10-13，浏览器实测发现）：`market/funding.ts` 的 `listFunding(symbol, limit, asOf)` 对 `funding_time`（bigint epoch ms 列）传 `new Date(asOf)`，Drizzle 按 bigint 序列化成 `Tue Oct 13 2026 ...` 本地串导致 PG 解析失败——凡快照缓存未命中需实时查 funding 的 run 在「行情快照」步骤整体失败（ETHUSDT 复现；BTCUSDT 因命中既有快照未暴露）。改为直接传数字 `asOf`。同屏排查确认 `read.ts` K 线路径与 `snapshot.ts`（timestamp 列）传参类型均正确，无同类错配。

> 评审修复（2026-10-13，F4/F9/F11）：(F4) 配置冻结贯穿 RAG——`searchHybrid` 新增 `caps` 选项，run 内检索（主检索两路 + 规则关联逐目标）严格消费冻结配置的 embedding/rerank/chat（不回退全局）；`proposeLlmVariants` 同步严格化；非 run 路径（会话概念问答）仍读全局生效配置。(F9) 结构事件保留周期来源：合并事件标记周期与序列长度，「最新 setup」只从执行周期按事件时间选取（修复前背景周期末位 setup 被当作整体最新），失效距今根数按所属周期计算，`structure_events.interval` 写真实周期。(F11) 数值红线补全：`validateResearch` 对 counterClaims（LLM 反证文本）无条件扫描概率/胜率数字（modelVersion 存在不再豁免）；claims 的 modelVersion 空门控不变。回归锚点：`scripts/p1-regression-check.ts` [评审 F11] 等。

> 对话编排增强（2026-10-13，feat/chat-first-advisor）：(1) 意图路由叠加 LLM 层——`runs/intent.ts` 的 `classifyIntentOrchestrated` 在确定性 `classifyIntent` 之后叠加一次 LLM 分类（严格 JSON 枚举校验；chat 能力未配置/超时/非法输出一律降级确定性，不伪造理解）；新增 system 意图（寒暄/与交易无关 → 直接回复引导，不启动研究）；LLM 可拆出 ≤2 个附加子问题，concept 类子问题在主回复内联 RAG 附答（不另起 run）。意图层只做路由，结论仍由流水线与代码校验器产出。(2) 检索消费改写变体——`knowledge/queryRewrite.ts` 由 chat LLM 生成改写变体（反漂移校验：须与原查询或命中术语共享词项）；`searchHybrid` 新增 `llmVariants` 选项：变体词项进词项召回并集、变体（≤2）批量 embed 各自成列表进 RRF；缺省不开启时行为与历史一致（确定性变体仅出现在 debug）。(3) web 搜索能力落地——`research/search.ts`（Brave 兼容；allowedDomains 白名单含子域名、手动重定向 ≤3 次逐跳重验、30s 超时、1MB 体积上限、仅 https）；plan 阶段 `searchNeeded` = search 已启用 ∧ 问题命中新闻/归因措辞；retrieve 阶段核验通过的网页冻结为 `evidence_items`（kind=web_page、sourceTier=web，独立于支持/反证计数，不进证据充分性判定）；validate 已知证据集合并入 webEvidenceIds。(4) 会话 news 意图接通：未配置保持「待配置」显式回复；启用时 searchAndVerify → chat LLM 归纳（仅用核验网页内容，附来源列表），LLM 不可用降级为原文摘录列表。(5) retrieve 主检索两路消费冻结策略 `retrieval.variants`（预算护栏：chat 可用且 LLM 预算剩余 ≥2，按最坏情况 +2 记账；规则关联逐目标检索不开启防止调用膨胀）。回归锚点：`pnpm knowledge:smoke`、`pnpm linkage:smoke`、`pnpm research:p1-check`、`pnpm research:smoke`、`pnpm web:smoke`（23 项）全绿。

> 修复验收（2026-10-09 九轮，P1/P2）：(1) 版本一致性语义修正——validate 阶段不再重新执行 `freezeRunConfig()`（那读的是「当前发布配置」，Admin 运行中发布新版本会让旧冻结任务误报 version_mismatch）；改为重读 run 行持久化的 `frozenConfig` 用导出的 `hashFrozenConfig()` 纯函数重算哈希与内存值比较——「本次实际使用的配置（ctx.frozenConfig，各阶段全部读它）与创建时冻结值一致」，发布新版本只影响新 run。(2) 已有持仓保护止损——`positionLogic` 区分新仓/已有持仓：新仓止损必须在入场亏损侧（原规则不变）；已有持仓的止损可能是浮盈后上移的保护止损（多头 stop>入场合法），有效性结合当前价判断（多头 stop<last、空头 stop>last，越过市价=已触发或无效）；lastPrice 从冻结快照末根成交价取，随 checkpoint 持久化。(3) 聊天切换币种一致性——postMessage 解析 symbol 后校验上下文持仓/报价引用的交易对，不匹配不带入新 run 并在回复中说明（切回原交易对自动恢复引用）；stages 的 loadPosition/loadQuote 增加 symbol 条件（纵深防御，防 BTC 入场价混入 ETH 行情）。(4) 意图路由——「预测+一周涨跌/走势」路由方向研究（teaching+1w，不继承 perp/event），event 意图明示一周同样降级并说明（1w 非事件合约期限）。(5) 配置驱动执行——检索数量读 frozenConfig.retrieval（finalLimit/counterFinalLimit，不再固定 6/4）；plan.requiredTools 从 roles[].tools 并集与工具域取交集（search 能力关闭时 web_search 剔除）；反证审查者 system 模板从角色 promptRef 解析（inline: 或 data/prompts/<ref>.txt，失败回退工程默认并记日志），角色级 budget 优先于全局。回归锚点见 `scripts/p1-regression-check.ts` [九轮-1/2/3/5]。

> 修复验收（2026-10-09 八轮）：(B1) 校验器接上 perp 数据——validate 阶段传入数值复算（保证金，容差 1e-3）与方向逻辑（`positionLogic`：long 止损必须低于入场/目标高于入场，short 反之；不一致 → `direction_logic` issue，ValidationRejected）。(B2) `version_mismatch` 真校验——validate 阶段重新执行 `freezeRunConfig()` 拿运行时 configHash 与冻结值比对，不一致拒绝发布（不再只依赖钉住字段）。(B3) 结果契约运行时校验——publish 阶段结果装配后过 `ResearchResultV2Schema.safeParse`，非法结构抛 ValidationRejected 不发布；zod strip 语义下 perp/direction 新增字段（fundingStale/bindingConstraint/feeLegs/probabilityUp 等）已先入契约。(C1) 流水线预测落库——事件/方向研究概率产出后写入 `predictions` 表（userId/quoteId/symbol/horizon/modelVersion/featureVersion/probabilityUp/quantiles/features/snapshotId），`probabilityBlock.predictionId` 回填可溯源。回归锚点见 `scripts/p1-regression-check.ts` [八轮-B1/B2]。

> 修复验收（2026-10-08 六轮，P1/P2）：(1) 租约约束全写入——stepStarted/stepFailed/fail/publish/transition（带 owner 时）都以 lease_owner 条件写入，丢租约抛 LeaseLostError 且流水线立即退出（不再写 stepFailed/fail——不得把接管者正在运行的 run 改成失败；隔离复现锚定见 research:p1-check）。(2) 发布恢复窗口闭合——checkpoint 存 result：publish 阶段 completed 之后、最终发布写库之前崩溃 → 恢复方从 checkpoint 恢复结果并在流水线末尾幂等补发布（不再抛「pipeline 缺少阶段实现」）。(3) SSE 实时与重放同序列——事件先落库拿 seq 再推送（订阅者拿到连续序号，落库失败才降级无 seq 直推）；轮询通道持续读取 run_events 新增事件并与订阅通道按 seq 去重。(4) 预算调用前执行——LLM 调用前检查剩余运行时间（<10s 不发起）与费用预留（按 prompt 粗估+maxTokens 最坏情况预估，超上限不发起）；调用超时 = min(剩余预算, 90s)，剩余≤0 直接拒绝发起。

> 修复验收（2026-10-08 三轮，P1）：(1) 断点恢复原子化——阶段状态（run_steps 置 completed）与上下文检查点（research_runs.ctxState）在**同一事务**提交（`PgRunStore.completeStage`），两者之间崩溃不再产生「阶段 completed 但恢复缺输出」窗口；checkpoint 写库失败即阶段失败（恢复时重跑），不再吞错。(2) 运行租约互斥——worker 执行前 `acquireRunLease` 原子抢占（lease 过期才可接管，`leaseOwner` 标识持有者；续租校验 owner，旧 worker 不得覆盖新 owner）。(3) 预算执行完整化——冻结预算纳入配置的 `maxRuntimeMs` 与 `maxCostUsd`（费用经 `RESEARCH_LLM_USD_PER_MTOK_PROMPT/_COMPLETION` 单价换算累计，单价未配置时不假装执行费用控制）；工具调用/时长/费用三类上限都在步骤边界强制。

> 修复验收（2026-10-08 二轮）：K 线读取改为「最新窗口」语义（readCandles DESC+反转，readCandlesPaged 分页凑数）；对话入口 /api/research/chat 落地（确定性意图槽位 + lastRunId 多轮继承 + 自动关联最新持仓/报价 + 缺口引导文案）；检索按 Agent 版本绑定的 knowledgeVersion 钉住；LLM 预算上限读版本 budgets.maxToolCalls。

> 实现状态（2026-10-01）：固定八步流水线 + PG RunStore（每步持久化/取消/修复轮）+ SSE + structure_events 落库 + 版本钉住（snapshotId/ruleVersion/knowledgeVersion/configVersion）已落地并通过队列端到端验证；v1 阶段为代码优先（chat 能力未配置时解读类声明为空并标注待配置），LLM 角色执行器与预算计数待能力配置接入。
> 关联链路补齐（2026-10-09 验收轮）：新增 `services/ruleLinkage.ts` 打通「K 线结构 → Brooks 规则 → 适用条件与反例 → 建议 → 原文引用」——retrieve 阶段对已确认 setup/执行与背景周期状态/周期冲突做逐规则定向检索（支持+反例各≤2 条），结构声明 evidenceIds 非空并附「Brooks 依据」文本；evidenceSufficient/evidenceQuality 由链接覆盖度判定（知识库为空时显式回退计数语义），validate 增加 unlinked_decision（知识库非空时动作级决策须有带引用声明）；exit/hold 等动作 reasons 附「理论依据：」注记。配套修复：① 止损触发（DecisionPolicy 增 lastPrice，当前价穿越用户止损 → exit 条件研究，先于 riskCap；校验器不再拒绝已触发止损）；② 聊天上下文同步（顶栏 symbol/marketType/horizon/product 随消息 PATCH 进会话上下文，服务端校验非法值 400）；③ 冻结配置哈希改键序规范化（pg jsonb 按字母序重排键导致 version_mismatch 误报）；④ 实时指数参考价仅事件研究必需（perp 不再被 5s 时效门阻断动作）。验证：`pnpm linkage:smoke` 15 项 + `research:p1-check` 74 项全绿。
> 验收轮二（2026-10-09）：① 断点恢复补齐理论关联状态（ruleLinks/knowledgeEmpty 进入检查点序列化与水化列表，阶段入口防御缺省；linkage:smoke 覆盖「检索后崩溃→续跑发布」跨阶段恢复）；② 事件参与最终门控（gateEventDirection/applyEventDirectionGate：报价方向 vs 执行/背景周期方向 → 通过/否决/证据不足三态进决策，反证结论与解除条件随附；p1 覆盖双空头+看涨→否决等 8 用例）；③ 论断引用定位（/evidence 端点补 docTitle，ResultCard 论断渲染 [n] 引用标记，点击展开冻结原文/页码/来源，浏览器实测）。

## 目标

定义研究 Agent 的查询规划、问题路由、固定流水线、角色分工、预算与校验机制，保证每次研究可审计、可恢复、数值可溯源。编排层只负责把「用户问题 → 校验后结论」串成确定性的状态机；行情事实由代码采集，结构由引擎计算，数值由代码计算，模型只做语义解释、受控补检索与回答组织。

## 已确定决策

- 采用固定流水线状态机：`plan → snapshot → structures → retrieve → product_analysis → countercase → validate → publish`，由后端驱动，不依赖模型自发决定是否调用工具。
- 角色三个，声明式配置在 `agent_versions`：`brooks_analyst`（解释结构、多空情景）、`countercase_reviewer`（反例/相反周期/失效条件，默认恰好一轮）、`event_researcher`（按需，Brave Search API，Admin 配置）。新增角色只改配置，不改状态机。
- 同一运行内所有角色共享 `snapshotId / knowledgeVersion / configVersion`；禁止递归委派、禁止自由多轮辩论、禁止以投票数量当置信度。
- 预算（最大工具调用数 / 运行时间 / 费用）由后端按配置决定并在步骤边界强制，模型与提示词不能提高预算；费用上限只有配置了 LLM 单价来源才真正可执行（未配置时不假装）。
- 每步「阶段完成 + 检查点」原子落库（同一事务）；worker 通过带 `leaseOwner` 的时间租约互斥（过期才可接管，丢租约立即停止写入）。
- 校验器为代码实现，不可被任何提示词（含管理员追加提示词）覆盖；校验失败在预算内修复一次，再失败返回 `insufficient_evidence`。
- 运行进度可流式展示，但最终结论必须经 `validate` 通过后才发布；未校验内容不写入最终结果。
- 预测概率唯一来自统计模块（scikit-learn 分位数梯度提升，见 docs/specs/prediction.md）；LLM 不生成、不修改概率，模型输出中出现概率数值由校验器拒绝。
- 外部页面是证据，不是指令：搜索命中的网页内容不触发任何工具行为，仅经核验后作为引用。
- 不连接交易账户、不自动下单、不做收益承诺。

## 数据与接口

- 查询规划结构（`plan` 阶段产物，落 `run_steps`）：`intent / symbol / marketType / timeframes / asOf / horizon / portfolioContext / missingFields / requiredTools / retrievalQueries / searchNeeded`；同时保留原始问题与全部改写记录。
- 状态持久化：`research_runs`（运行主记录，含 `snapshotId / configVersion / knowledgeVersion / modelVersion` 与取消标记）+ `run_steps`（每步输入、输出、耗时、失败原因、费用）；证据冻结于 `evidence_items`。实体定义见 docs/specs/api-storage.md。
- API 族：`POST /api/research/runs`（创建，立即返回 runId）、`GET /api/research/runs` 与 `GET /api/research/runs/:id`、`POST /api/research/runs/:id/cancel`、`GET /api/research/runs/:id/events`（SSE 进度与校验后结果）、`GET /api/research/runs/:id/result`。
- 队列：pg-boss 驱动每步执行，进程重启后按 `run_steps` 续跑。
- 模块位置：`server/src/research/orchestrator/`（状态机与角色执行器）、`server/src/research/perp/` 与 `server/src/research/event/`（`ProductAnalyzer` 注册实现）。
- 网页搜索：`search` 能力在 Admin 配置 Brave Search API Key；抓取工具带域名白名单、URL/重定向检查、超时与体积限制；搜索结果须打开原页核验后才可引用。

## 流程

### 问题路由（五类）

| 问题类型 | 示例 | 路由 |
| --- | --- | --- |
| 概念问答 | 「H2 是什么」 | 知识检索：规则、上下文与反例；不需要行情与网页搜索 |
| 实时结构 | 「BTC 目前结构如何」 | 行情快照 → 各周期结构计算 → 相关概念检索 |
| 持仓决策 | 「我有 BTC 多单，要不要减」 | 上述证据 + 用户已确认持仓/风险预算 → `product_analysis` 条件计划 |
| 历史复盘 | 「上周那次突破为什么失败」 | 明确历史 `asOf`，只用当时已收盘前缀行情与当时可见的事件证据 |
| 事件归因 | 「今天下跌是不是因为某公告」 | 行情事实 + `event_researcher` 搜索核验；因果联系一律标为假设 |

### 规划纪律

- 扩写不改变问题中的币种、市场类型、周期与买卖方向；不把「还能涨吗」改写成只寻找支持上涨的证据。
- 检索分支持依据与反例两路执行（见 docs/specs/knowledge-rag.md）。
- `missingFields` 非空（如持仓未确认、风险预算缺失）时，进入补全对话，或按通用研究口径输出并在结果中列出 `missingInputs`；持仓未知不得当成空仓。

### 流水线各步输入输出

| 步骤 | 输入 | 输出 |
| --- | --- | --- |
| `plan` | 原始问题、会话上下文 | 查询规划结构 |
| `snapshot` | symbol / marketType / asOf | `snapshotId`（各周期 `closeTime<=asOf` 的最后收盘集合） |
| `structures` | 快照 K 线 | `structure_events`（带 `knownAt / ruleId / ruleVersion`） |
| `retrieve` | 检索查询 | 支持/反证证据（`evidence_items`） |
| `product_analysis` | 结构 + 持仓或报价 | 条件计划、费用/资金费率情景、EV 等（纯代码计算） |
| `countercase` | 当前证据包 | 反例、相反周期、失效条件与异议（恰好一轮） |
| `validate` | 待发布结论 | 通过 / 修复一次 / `insufficient_evidence` |
| `publish` | 校验后结论 | 最终结果落库 + SSE `run_completed` |

### 校验器检查项（代码执行）

市场类型一致性、数据时效、引用存在（每个引用可在 `evidence_items` 定位）、只用已确认结构（provisional 不得作为结论依据）、数值可溯源（每个价格、关键位、EV 必须挂 `evidenceId` 或由代码计算产出）、方向逻辑（entry/stop/target 与方向一致）、必要用户信息齐全；并拒绝模型输出中的概率数值。

## 边界与失败处理

- 数据过期、模型未就绪、期限未验证：对应输出明确返回不可用并给出原因，不降级为无依据结论（见 docs/specs/prediction.md、docs/specs/event-contracts.md）。
- `event_researcher` 未配置 Brave Search Key：返回「待配置」状态，不静默跳过。
- 预算耗尽：中止运行，标记 `run_failed`（原因 `budget_exceeded`），已写入的 `run_steps` 保留。
- 取消：`cancel` 后不再写入后续步骤；SSE 发送 `run_cancelled`；恢复时从最后一个成功步骤续跑（已完成阶段的输出从 ctxState 检查点水化）。
- 数据库不可用：创建/发布返回 503 且 `storage: unavailable`，不产出无法审计的结论（见 docs/specs/api-storage.md）。
- 搜索来源冲突：并列展示冲突，不靠多数投票确定事实。

## 验收用例

- [ ] 一次完整 run 的 SSE 事件序列（`step_started/step_completed/run_completed`）与最终落库结果一致。
- [ ] 取消运行后无后续 `run_steps` 写入；重启进程后可从断点续跑。
- [ ] 阶段完成后、检查点写入前崩溃 → 恢复时该阶段重跑（不存在 completed 但缺输出的状态）。
- [ ] 两个 worker 同时接到同一 run → 只有一个持有租约执行，另一个放弃。
- [ ] 运行时长/工具调用/估算费用任一超冻结预算 → `budget_exceeded` 中止并落库原因。
- [ ] 五类问题分别路由到正确分支，路由表与实现一一对应。
- [ ] 扩写记录保留原始问题；「还能涨吗」类问题同时检索支持与反对证据。
- [ ] 模型输出含伪造概率数值时被校验器拒绝；校验失败修复一次后仍失败返回 `insufficient_evidence`。
- [ ] 同一 run 内所有角色读取相同的 `snapshotId/knowledgeVersion/configVersion`；不存在递归委派路径。
- [ ] 管理员追加提示词不能改变校验器行为与预算上限。
- [ ] 未配置搜索能力时事件归因类问题明确提示「待配置」。
- [ ] 抓取工具对非白名单域名、重定向出白名单、超时、超大页面分别拒绝并记录原因。

## 参考来源

- 仓库内：docs/brooks-agent-architecture.md（§7 查询规划、§8 Agent 编排）、docs/specs/api-storage.md、docs/specs/knowledge-rag.md、docs/specs/prediction.md、docs/specs/admin-security.md、server/src/aiTools.ts（现有工具循环）。
- [TradingAgents](https://github.com/TauricResearch/TradingAgents)：角色分工与正反研究模式参考。
- [FinRobot](https://github.com/AI4Finance-Foundation/FinRobot)：确定性计算与模型解读分离模式参考。
