# 金融 Agent 开源模式与交互模式参考

> 核验日期：2026-09-30。本文只记录「借鉴什么模式、不借鉴什么」，
> 任何项目的市场假设、数据与回测表现都不能直接证明 Brooks 方法在币安任何品种/周期的效果。
> 项目代码与文档会变动，落地时应固定所参考的 commit/依赖版本，并复核实际 API 与许可。

## 1. 开源项目：借鉴点与本项目适配差异

| 项目 | 链接 | 借鉴点 | 本项目适配差异 |
|---|---|---|---|
| TradingAgents | <https://github.com/TauricResearch/TradingAgents> | 专业角色分工（分析、看多/看空研究员、交易员、风险）与正反研究的组织方式；把「反方观点」作为正式产物而非附属 | 本项目禁止递归委派与自由多轮辩论；反证审查默认恰好一轮、返回 evidenceIds 与明确异议；角色由 `agent_versions` 声明式配置，同一 run 共享 snapshotId/knowledgeVersion/configVersion；不以投票数量当置信度。其股票/新闻数据流与本项目 Brooks 价格行为引擎不同，不引用其回测表现 |
| FinRobot | <https://github.com/AI4Finance-Foundation/FinRobot> | 确定性数值计算与模型解读分离：代码算指标，LLM 负责解释；金融研究任务的工具化拆分 | 其股票估值/财报逻辑不直接迁入价格行为；本项目所有数值（计划盈亏、费用、资金费率情景、仓位上限、EV、盈亏平衡胜率）一律由代码计算并挂 evidenceId；预测概率唯一来自统计模块，LLM 不生成或修改概率 |
| Freqtrade | <https://github.com/freqtrade/freqtrade> 与 [lookahead-analysis 文档](https://docs.freqtrade.io/en/stable/lookahead-analysis/) | 回放方法论与前视偏差检查：对比完整数据运行与切片运行的结果差异；回放计入费用/滑点/成交约束的纪律 | Freqtrade 是自动交易机器人框架，本项目是研究 Agent、不自动下单；借鉴 lookahead-analysis 的方法思想，针对本 TypeScript 引擎实现等价的因果性检查（前缀一致性/逐根一致性/未收盘拒绝，见 `scripts/brooks-selftest.ts` 同风格校验脚本），不能直接引用其结果证明本引擎无泄漏 |
| FinRL | <https://github.com/AI4Finance-Foundation/FinRL> | 训练/测试/交易样本按时间划分的纪律 | 不引入强化学习；本项目采用 dev/calibration/sealed-test 时间切分 + 重叠标签 purge/embargo；模型为 scikit-learn 分位数梯度提升，而非 RL 策略 |

## 2. 公开产品交互模式研究

以下条目来自各产品公开文档与公开页面的交互模式研究，用于 `/research` 工作台设计参考。独立来源共 8 个：AlphaSense、Fiscal.ai、Perplexity、Bloomberg Terminal、OpenBB、Daloopa、LangGraph、Kalshi（FinRobot 与 §1 项目重复，LangGraph 两条出自同一官方文档站，均不重复计数）。

| 模式名称 | 来源链接（核验日期） | 借鉴点 | 本项目适配差异 |
|---|---|---|---|
| 数据与结论并排 | [FinRobot](https://github.com/AI4Finance-Foundation/FinRobot)（开源，同 §1 项目；2026-09-30） | 实时数据与结论并排展示——数据面板与分析结论相邻呈现，用户可即时对照 | 借鉴为工作台中栏（真实 K 线/已确认结构）与右栏（对话/建议卡/证据）的并排布局；结论仅展示校验通过后的结果 |
| 引用定位来源片段 | [AlphaSense Agent API response parsing 文档](https://developer.alpha-sense.com/agent-api/response-parsing)（2026-09-30） | 回答中的引用可定位到来源片段（citation 级溯源） | 借鉴为证据抽屉：点击引用联动 K 线定位或打开原文页码/图号，且发布时冻结引用快照 |
| 数值可追溯到原始资料 | [Fiscal.ai MCP skills 文档](https://docs.fiscal.ai/docs/guides/mcp-skills)（2026-09-30） | 数值可追溯到原始资料——每个关键数值携带来源 | 借鉴为校验器纪律：价格、关键位、EV 等关键数值必须挂 evidenceId 或由代码计算，模型不得产生无法溯源的数值 |
| 搜索型回答内建引用 | [Perplexity 官方开发文档](https://docs.perplexity.ai/)（2026-10-09） | 答案与引用同一次生成返回（built-in citations），引用是答案的组成部分而非事后附加 | 本项目引用来自库内知识库快照（发布时冻结），不做实时 web 检索；引用必须可定位到页码/图号并挂 evidenceId |
| 终端型多面板多任务 | [Bloomberg Terminal 公开入门指南（耶鲁大学图书馆）](https://guides.library.yale.edu/Bloomberg/Bloomberg_Basics)（2026-10-09） | 4 个独立面板并行多任务、面板间快速切换、命令行检索；信息密度优先于装饰 | 单页 Web 工作台以桌面四区同屏对应其多面板思想；不引入命令行面板体系；移动端 <760px 退化为「图表/对话/证据」三标签 |
| 仪表盘 + AI 侧栏并存 | [OpenBB Workspace Copilot Basics 文档](https://docs.openbb.co/workspace/analysts/ai-features/copilot-basics)（2026-10-09） | 可伸缩 AI 侧栏与数据组件并存，回答内展示逐步推理，底部栏管理上下文数据/组件 | 本项目四区为固定布局，不支持用户自定义面板与拖宽；AI 上下文由后端按 snapshotId 固定取数，而非用户勾选组件 |
| 数值单击溯源原文 | [Daloopa 官方 Deepest Dataset 页](https://daloopa.com/benefits/deepest-dataset)（2026-10-09） | 每个数据点超链接回原始文件（SEC 文件/演示材料等），单击即可核验 | 本项目数值不链接外部文件，而是挂 evidenceId 指向库内证据（行情 bar、知识片段页码/图号）或由代码计算；事件报价为用户手动录入，溯源对象是用户录入记录而非官方数据源 |
| Agent 过程透明化（流式步骤） | [LangGraph Streaming 文档](https://docs.langchain.com/oss/python/langgraph/streaming)（2026-10-09） | 以 updates/messages 等 stream mode 把每个节点（步骤）的增量输出实时推送，用户可见「做到哪一步」 | 本项目不依赖特定编排框架，以 SSE `/api/research/runs/:id/events` 按 run_events 游标推送步骤；中间文本未经校验不作为结论展示，仅 `run_completed` 后的校验结果落卡 |
| 人在回路确认（中断/审批） | [LangGraph Interrupts 文档](https://docs.langchain.com/oss/python/langgraph/interrupts)（2026-10-09） | interrupt 暂停执行并把问题/表单 schema 抛给前端，用户补齐或批准后 resume 继续 | 本项目确认卡用于缺失信息补全与关键参数确认，确认后继续流水线；恢复粒度是 run 步骤而非执行图断点，且不自动执行任何交易动作 |
| 概率作为一等展示对象 | [Kalshi 官方内容页](https://kalshi.com/learn)（2026-10-09） | 事件合约行情直接以概率百分比语言呈现（如「priced at 44%」），概率是主展示而非附属 | Kalshi 概率来自市场撮合价格；本项目概率唯一来自统计模型且须经校准，展示须标注来源与期限桶，模型未就绪/期限未验证时显示不可用原因而非编造数值 |

> 声明：上述资料仅用于**模式研究**，均来自官方文档或公开页面，不宣称完成对这些付费产品的完整交互审计。

> 候选未采纳记录（2026-10-09）：FinChat（finchat.io）已更名为 Fiscal.ai，与上表为同一产品，不计独立来源；Polymarket、天气预报概率呈现、TradingAgents 演示站未检索到可核验的官方交互资料，未写入；Perplexity 产品页（perplexity.ai/finance，403）与 Kalshi 帮助中心具体定价文章（未定位到稳定 URL）抓取受限，分别以官方开发文档与官方内容页替代。

## 3. 使用边界

- 这些参考只决定「流程与交互怎么组织」，不决定「结论是否正确」；能力结论一律来自本项目的评测集与回放（见 `docs/specs/evaluation-deployment.md`）。
- 引入任何新项目作为参考前，先核对许可与当前 commit，并在本文追加一行说明借鉴点与适配差异。
