# UI 与交互

> 状态：partial
>
> P0 质量闭环（2026-10-16，vertical-agent-architecture.md §6）：后端受控降级（task_degraded 事件 + degraded 结果字段）与前端降级徽章/横幅已落地（RunBubble/ResearchResult，双 UI 模式共用）；提示词注册表、逐条证据绑定、知识 as-of、可信回答组装器为服务端改动（/api/admin/prompts 五端点供后续管理页使用）。浏览器端到端验收待线上 rebuild 后执行。

> 新对话工作台（2026-10-16）：`implemented`。`codex/dev-agent-workbench` 已实现 `/research?ui=dev`：左侧会话、中央回答、右侧按需证据/冻结图表、底部现货/USDT 永续/事件合约标签。无参数、`ui=legacy` 或未知值继续使用下文旧布局。两套页面按需挂载，同账号、同 API、同研究结果；`ui` 只选择界面。未登录新模式提供静态欢迎页、独立场景草稿及登录返回。类型检查、构建和浏览器受控接口回归已通过；尚未完成真实账号与研究 worker 的端到端验收，保持 implemented。见 [实施方案](../dev-agent-workbench-plan.md) 与 [验收记录](../references/workbench-ui-qa-2026-10-16.md)。

### 新对话模式的实现约束（`ui=dev`）

- `WorkbenchPage` 使用独立全屏外壳与作用域样式，不叠加旧顶栏、行情带或悬浮助手；桌面会话栏可折叠，手机为可关闭抽屉。会话来自真实 `/conversations`，按今天/昨天/最近 7 天/更早分组，保留大盘、价格行为与管理员入口。
- `uiMode` 统一解析模式与站内登录返回；模式切换保留 conversation/run 及其他查询参数，不发消息、不创建 run。登录/开通说明/返回/登录成功保留模式与深链；认证状态变化时清理私人组件状态。会话、消息或确认操作未完成时禁用模式切换。
- 输入框上沿为现货（teaching+spot）、USDT 永续（perp+usdm_perp）、事件合约（event+usdm_perp）三个场景。每个场景独立草稿，sessionStorage 仅用于同标签页的登录恢复；不存储 UI 模式。切换场景或标的清除持仓/报价关联，异步保存返回也不能把关联带入另一个场景。
- 会话懒创建；只有登录后才加载会话、持仓与报价。未登录可以编辑，发送进入登录；失败消息保留错误并恢复草稿。消息/上下文恢复/运行/确认期间锁定产品、交易对与期限；新会话只停止当前页面订阅，不取消后台任务。
- 复用运行气泡、确认卡与最终结果卡。历史消息中的研究入口按 ID 打开结果；当前选中研究卡嵌入对应回答，独立 run 深链展示独立卡片。一次只跟踪一个 run；支持 step_started/completed、发布、失败、取消、重连游标及 5s 终态轮询兜底。只有 published 结果进入最终结论展示，详情/结果读取错误可见。失败重试复用该 run 的产品、标的与期限，不从当前场景挪用持仓/报价。
- 引用编号按当前结果的 evidenceIds 首次出现顺序去重，点击后打开右栏、高亮并展开对应冻结片段；来源、支持/反证、页码/图号仅展示接口已有字段。证据按 runId 键控。结构事件点击切到该 run 的图表，使用其 symbol/marketType/horizon/asOf 与冻结输入包；图表操作不改历史结论，快照回退警告始终可见。止损/强平/执行价只取该结果 payload 的有效字段。
- 右栏默认关闭，桌面宽度 340–700px（同时受视口宽度限制），可拖动分隔线或用左右键调整；手机为全屏资料层。小于 760px 保留图表/对话/证据视图按钮，与底部三个产品场景分开。
- 持仓/报价录入、关联与结算使用已有真实接口；不展示尚无后端支持的附件和思考模式控件。沿用模型/概率/EV 不可用、证据不足与 1w 研究模式提示。
- 仅靠近消息底部时自动跟随内容增长；阅读历史时显示回到底部。抽屉和弹窗支持 Escape、焦点约束与焦点返回；场景标签支持左右/Home/End 键；遵循 reduced-motion。

> 复审修复（2026-10-13 晚，R5/F6 前端）：(1) 冻结视图下快照输入包不可读时，图表下方显示琥珀警告「快照不可复现：…（非原始输入）」（`useResearchCandles` 返回 source/fallbackReason，不再静默回退实时库）；正常读取输入包时快照行标注「输入包数据」。(2) 持仓确认卡字段不齐（card.complete===false）时确认按钮禁用并显示缺失槽位提示，补齐路径为对话内续聊（服务端草稿合并）。

> 追加修复（2026-10-13 下午）：(1) 顶栏「研究场景 + 市场」两个下拉合并为单一「场景」下拉（现货 / USDT 永续 / 事件合约），对齐下方决策行——现货 = teaching 产品 + spot 行情（纯结构研究，无持仓/费用/强平表单），永续/事件固定 usdm_perp 行情；原「教学研究」选项移除（概念与方向研究仍由对话意图路由自动进入 teaching）。(2) 悬浮助手运行气泡补「重新发起（相同标的与期限）」一键重试：以该 run 自身的 product/symbol/marketType/horizon + 会话内最近一条用户消息重新 POST（助手无顶栏上下文，不携带持仓/报价引用）。(3) 服务端 PATCH /conversations/:id/context 清理 confirmPositionDraft 死分支（实际落库路径只有 positionDraft+confirm 一条）。(4) `/research?run=:id` 消费改为监听 searchParams 变化（浏览器实测发现：助手是全局浮层，跳转是同路由参数变化、ResearchPage 不重挂载，原 mount-only 写法在已停留在 /research 时点击「在研究工作台打开」无效）；同一 runId 去重不重开。

> 改版（2026-10-13，对话优先）：(1) 研究工作台右栏改为对话为主——消息流内嵌运行气泡（SSE 步骤/连接徽章/取消/失败重试）、结果卡与持仓确认卡；「发起研究」与持仓/报价录入表单收进弹层（`modal-overlay` + `.research-tools-modal`，默认收起，从对话面板头打开）。(2) 中栏图表从 canvas 版 ResearchChart 切换为 klinecharts 的 `BrooksChart`（`web/src/brooks/BrooksChart.tsx`），扩展指标层支持证据高亮（琥珀竖带 `highlightTime`）与关键价位虚线（`levels`：止损/强平/执行价）。(3) 悬浮 AI 助手删除 three.js 3D 机器人，改为简洁 FAB 图标按钮（保留打开/隐藏交互）；助手链路从 `/api/ai/chat|command|news|memories|tickers` 切换到 `/api/conversations`，与研究工作台共用同一条会话——助手内发消息触发研究时以运行气泡跟踪，并提供「在研究工作台打开」链接（`/research?run=:id`）。(4) 样式治理：`styles.css` 按职责拆分为 `web/src/styles/`（base/components/pages/ai/research + index.css 入口）；`.panel` 玻璃拟态与扁平双定义合并为扁平；按钮命名统一 `btn-primary`/`btn-ghost`（连字符），视觉统一为扁平 cyan-soft；补齐 `--text-1`/`--line-3`/`--blue`/`--on-accent` token 与 `.err-text`，琥珀/紫/蓝色值收敛到 token。状态保持 partial：浏览器验收清单未逐条核对，不得升 verified。

> 修复验收（2026-10-09 九轮）：(W0) 事件报价提交补齐 `expiryKind`（服务端契约必填字段：duration=录入时刻+期限，submitted 强制 exact，缺失会被 400 拒绝）；/admin/evals 训练入队提示改为新状态机措辞（training→candidate→published）。(W1) 持仓确认卡替换 window.confirm——内联卡片展示草稿各字段（方向/数量/开仓价/杠杆/保证金模式/风险预算），「确认写入」为键盘可达真按钮（aria-label 齐全），调 `PATCH /conversations/:id/context`（positionDraft+confirm:true）后结果回显消息流并刷新左栏；「取消」只标记卡片状态不落库。(W2) 事件结果卡加「倒计时」行（唯一来源为契约字段 `quote.expiryAt` 的时钟换算，30s 自刷新，附运行 asOf 时剩余 `remainingMs`）；1w 期限（或 payload `researchMode:true`）结果卡显示「研究模式（非币安事件合约产品）」徽章（.stale-tag 同款琥珀色）。(W3) 中栏图表上方加多周期结论条——ResearchResultV2 契约不含 structureView，故取结果 claims 中结构阶段写入的执行/背景周期与周期冲突事实原文（前端不重新计算、不编造）；关键价位只取 payload 契约字段（perp `position.stopPrice`/`liquidation.price`、event `quote.strikePrice`）画水平虚线+标签，标的与当前 run 不一致或价位超出可视区间时不渲染。(W4) 顶栏：交易对改 datalist（`/api/market/symbols`，失败回退静态常用列表）；显示最后一根已收盘 K 线时间（「数据至 HH:MM」，距今超过周期长度+一个周期宽限标「数据陈旧」，30s 重估）；SSE 连接状态徽章（未订阅/连接中/已连接/断开重连/已断开，由 EventSource readyState 派生）；左栏拉取失败显示「数据服务不可用（只读）」横幅（role=alert），不再静默吞错。(W5) 运行失败面板加「重新发起」按钮（以该 run 的 product/symbol/marketType/horizon + 当前关联持仓/报价/问题重新 POST /research/runs）；移动端三标签断点 960px→760px 对齐 spec 决策行，标签「研究」改「对话」。(W6) 永续结果卡：`fundingStale` 为真显示资金费率过期警示；`riskCap.bindingConstraint` 显示仓位上限触发约束；盈亏矩阵标题附 `feeLegs.note` 费率档说明；左栏报价行加「确认结算」（高于/低于/平价三选小按钮组，POST `/api/event-quotes/:id/confirm`，已确认的报价不再显示入口）。状态保持 partial：浏览器验收清单未逐条核对，不得升 verified。

> 修复验收（2026-10-09 七轮）：(1) 证据抽屉按 runId 键控拉取——切换 run 先清空再重取，杜绝展示上一个 run 的缓存证据（修复前 `items` 不随 runId 重置，会张冠李戴）。(2) 证据联动接线——`/api/research/runs/:id/evidence` 附带快照结构事件（含 atTime/knownAtTime/provisional），抽屉中点击结构事件高亮定位中栏对应 K 线（highlightTime）；EMA20 与逐根状态背景条接入共享引擎 `analyzeBrooks`（修复 ResearchChart 的死参数），regime 色板对齐 `RegimeType` 枚举。(3) 状态自 verified 降为 partial：2026-10-09 代码审计证伪「证据点击联动」验收用例；上述修复为代码级实现，verified 需浏览器验收清单逐条核对后恢复。待办：多周期结论条、关键价位、事件结果卡倒计时、确认卡正规 UI（现为 window.confirm）、顶栏行情时间/连接状态。

> 修复验收（2026-10-08 六轮，P2）：事件表单——已提交订单锁定「App 固定到期时刻」（duration 选项禁用、不预填、提交校验）；预览单可自由二选一。

> 修复验收（2026-10-08 三轮，P1）：(1) 事件表单「到期方式」二选一——预览=录入时刻+期限；已提交订单=直接抄录 App 显示的固定到期时刻（切到已提交时自动切换并预填、提交校验晚于当前时刻；否则九分钟前买的十分钟单会再得十分钟剩余时间，污染监控与期限桶匹配）。(2) 查看历史研究时中栏图表按该 run 的 `asOf` 冻结取数（快照行显示冻结时刻与「回到实时」按钮；手动切换交易对/市场/期限解除冻结回到实时），历史结果与图同一时刻。(3) SSE 重放闭环——服务端按 `?after=` 或浏览器自动重连的 `Last-Event-ID` 头从 `run_events` 游标续发；前端跟踪事件 id，重新打开同一 run 时以 `?after=` 续发不重复。

> 实现状态（2026-10-01）：/research 工作台已落地（四区：顶部场景/交易对/期限/快照状态、左侧持仓+报价+历史、中间 asOf 冻结 K 线（EMA20+逐根状态条）、右侧发起研究+SSE 步度+结果卡+证据抽屉；移动端图表/研究/证据三标签）；admin 知识库/Agent 配置/评测与模型三页接入真实接口。待办：结构事件在图表上的点击定位强化、键盘细节打磨（verified 需 UI 验收清单逐条过）。

## 目标

定义研究工作台与 Admin 页面的布局、表单、图表联动、异常状态与可访问性，使用户能完成「发起研究 → 查看进度 → 核对证据 → 管理持仓与事件报价」的完整闭环，且界面展示的任何结论均可追溯到 run 记录与证据。

## 已确定决策

- 新增路由 `/research`（`web/src/research/ResearchPage.tsx`），加入 `web/src/App.tsx` 认证区与 `web/src/components/Header.tsx` 的 TABS；新增 `/admin/knowledge`、`/admin/agents`、`/admin/evals` 三个 Admin 页面（superadmin 自守卫，沿用 `web/src/pages/AdminPage.tsx` 模式；页面路由为 `/admin/evals`，`/api/admin/evaluations/*` 是 API 端点前缀，勿混淆）。
- 视觉沿用现有深色 token 与面板体系：`--bg-0..3`、`--cyan`、`--up/--down`（见 `web/src/styles/base.css`，样式按职责拆分为 `web/src/styles/` 的 base/components/pages/ai/research 五文件）与 `.panel` 系列扁平样式；研究页与复盘页 K 线统一复用 klinecharts 的 `web/src/brooks/BrooksChart.tsx`（含 Brooks 结构指标层）。
- 悬浮 AI 助手为右下角 FAB 图标按钮（无 3D 机器人/three.js 依赖），打开后是固定浮层聊天窗；助手与研究工作台共用 `/api/conversations` 会话链路（同一套消息、上下文与持仓确认卡），助手内触发的研究以运行气泡跟踪并可跳回 `/research?run=:id`。
- 研究进度通过 `/api/research/runs/:id/events` 的 SSE 渲染；最终结论只展示校验通过后的结果（`run_completed`），未校验的中间文本不作为结论展示。
- 图表切换周期、交易对不修改历史回答：已发布结果以 run 记录为准，回看历史研究时按当时 `snapshotId/asOf` 复现。
- 移动端（<760px）改为「图表 / 对话 / 证据」三个标签页；全站键盘可达并带 aria 标签。
- 数值（计划盈亏、费用、资金费率情景、仓位上限、EV、盈亏平衡胜率）全部由后端代码计算，前端只渲染；模型未就绪、期限未验证、数据过期时展示明确的不可用原因。
- 1w 期限是研究预测，界面显著标注「研究模式」，不得展示为币安已有事件合约产品。

## 数据与接口

- 研究运行：`POST /api/research/runs`、`GET /api/research/runs/:id/events`（SSE）、`GET /api/research/runs/:id/result`、`POST /api/research/runs/:id/cancel`。
- 持仓：`/api/portfolio` CRUD（字段含 `confirmedAt/staleAfter`，过期标 stale）。
- 事件报价：`/api/event-quotes` CRUD（`stake` 与 `totalPayout` 分列录入）。
- 预测：`/api/predictions/*`（创建、查询、到期后确认结算）。
- 行情：`/api/market/*`（candles/snapshot/funding/open-interest/quality）。
- Admin：知识库 `/api/admin/knowledge/*`、Agent 版本 `/api/admin/agents/*`、评测 `/api/admin/evaluations/*`。
- 证据原文（W2 第三批）：`GET /api/research/runs/:id/evidence` 增 `fileUrl/contentHash/docUpdated` 源字段；`GET /api/research/evidence/:id/file` 用户侧只读原文（按当前 access 判权）。
- 端点与字段契约详见 docs/specs/api-storage.md；请求响应共享 `shared/src/contract/` 的 zod schema。

## 流程

### `/research` 工作台布局（对话优先）

| 区域 | 内容 |
| --- | --- |
| 顶栏 | 场景切换（现货 / 永续 / 事件）、交易对（复用 datalist）、研究期限、行情时间与连接状态 |
| 左栏 | 自选交易对、持仓与事件报价、历史研究（runs）、会话列表 |
| 中栏 | klinecharts K 线（`BrooksChart`：EMA20、结构标注、regime 背景）+ 多周期结论条 + 证据高亮竖带 + 关键价位虚线 |
| 右栏 | **对话为主**：消息流内嵌运行气泡（SSE 步骤/取消/重试）、结果卡、持仓确认卡；「发起研究」与持仓/报价录入表单收进弹层（默认收起，从对话面板头按钮打开） |

- 页面状态逻辑收敛在三个 hook：`useResearchRun`（SSE 订阅 + `?after=` 游标续发）、`useResearchConversation`（会话 + 上下文同步 + 确认卡）、`useResearchCandles`（按 asOf 拉取与 isClosed 过滤）；页面组件只做组装。
- 支持 `/research?run=:id` 直接打开指定运行（悬浮助手「在研究工作台打开」链接的目标）。

### 悬浮 AI 助手（FAB）

- 右下角圆形图标按钮（`.ai-fab`），hover 浮现隐藏小钮（隐藏后可从右上角用户菜单重新唤起）；聊天窗打开时按钮退场。
- 聊天窗（`.ai-chat`）为固定浮层：历史会话浮层、建议 chips、拖拽改尺寸与最小化；消息为纯文本气泡 + 持仓确认卡 + 运行气泡（含「在研究工作台打开」链接）。
- 助手会话与研究工作台是同一条 `/api/conversations` 链路：在助手里的对话可在工作台继续，反之亦然。

### 永续表单与结果卡

- 表单：方向、数量、成本价、杠杆、保证金模式（cross/isolated）、风险预算；提交即用户确认（写入 `confirmedAt`）。
- 结果卡：条件计划（做多/做空/等待/持有/减仓/退出条件）+ 计划盈亏矩阵 + 费用与资金费率情景卡；强平价仅在用户自 App 录入时展示，缺失保证金档位信息时明确标「简化估算，非真实强平价」或不展示（见 docs/specs/perpetual.md）。

### 事件表单与结果卡

- 表单：期限（10m/30m/1h/1d/1w）或 App 固定到期时刻（二选一，已提交订单必须用后者）、执行价 `strikePrice`、到期时间 `expiryAt`、投入 `stake`、含本金总返还 `totalPayout`、执行参考价；报价全部为用户手动录入（官方仅 App 提供，无 API）。
- 结果卡：到期时刻相对执行价的高/低期限预测、盈亏平衡胜率（`stake/totalPayout`）、期望净收益 EV、倒计时、到期后复盘状态；预测目标明确表述为「到期时刻标的价格相对执行价」，与「从现在起涨跌」区分。
- 1w 结果带显著「研究模式」标识；期限桶不匹配（容差默认 20%）或模型未验证时展示不可用原因。

### 证据联动与来源抽屉

- 点击证据：行情类证据定位到中栏 K 线的对应 bar/结构事件；知识类证据打开来源抽屉，定位原文页码/图号（引用冻结字段见 docs/specs/knowledge-rag.md）。
- 证据列表区分支持/反对两组；反证审查的异议与普通证据同层展示。
- 查看原文（W2 第三批）：展开证据卡/引用气泡时，源文档当前可读则显「查看原文」→ 只读预览弹窗（PDF iframe 定位冻结页码；HTML iframe 加 sandbox 无 allow-scripts；MD/TXT 文本渲染；DOCX 下载降级）；文档已更新（重发布/归档/清除）时不定位页码并提示「文档已更新，定位可能失效」；受限/已清除如实提示不可用。

### Admin 页面

- 管理端入口（W3-S1 起独立构建）：admin 域名根路径 302 自 /admin（独立产品 dist-admin，经 /admin 前缀托管；未登录极简登录表单→非超管禁入提示）；用户端产物不再含 admin 子应用。本地开发 `pnpm --dir web dev:admin`（端口 17844，路径 /admin/）。
- `/admin/knowledge`：上传队列弹窗（三道校验+串行上传+取消回滚，URL/清单同窗 Tab）、文档卡片栅格与状态、差异轮询、解析日志抽屉、版本历史回滚、清单批量导入弹窗（条目状态/重新同步/单条重试/勾选导入）、解析预览、发布、`search-debug` 面板。
- `/admin/agents`：版本列表、草稿编辑、发布、回滚、调试运行。
- `/admin/evals`：数据集管理、触发评测运行、报告查看。

## 边界与失败处理

界面必须覆盖的异常状态清单（每种有独立视觉态，不用通用报错糊过去）：

| 状态 | 展示 |
| --- | --- |
| 数据过期 | 顶栏行情时间变陈旧标记，结果卡标 `stale` 并给出最后收盘时间 |
| 模型训练中 / 未就绪 | 预测区域显示「模型未就绪」及原因，概率区域为空而非编造值 |
| 报价缺失 | 事件场景提示先录入报价，EV 区域不可用 |
| 引用不足 | 结论降级为 `insufficient_evidence` 卡片，列出缺失证据 |
| 运行取消 | 对话流显示已取消，保留已完成步骤 |
| 运行错误 | 显示失败步骤与原因，提供重试入口 |
| 数据库不可用 | 停止新增研究与发布入口，界面显示实际可用状态（只读） |
| 1w 研究模式 | 显著标识，且不与官方四种期限并列展示为「币安产品」 |
| 受控降级发布（P0-5，2026-10-16） | 结果卡头部琥珀「降级发布」徽章 + 原因列表（已剔除未经校验的归纳内容）；运行气泡先收 task_degraded 横幅（修复耗尽等 code 有独立文案）再 run_published；旧客户端安全忽略新事件类型 |

## 验收用例

- [ ] 真实接口全链路：创建 run → SSE 进度逐步渲染 → 校验后结果落卡 → 证据点击联动 K 线定位或原文页码。
- [ ] 永续表单提交后结果卡的盈亏矩阵、费用、资金费率情景与后端计算值一致（前端不二次计算）。
- [ ] 事件表单提交后展示期限预测、盈亏平衡胜率、EV、倒计时；1w 出现「研究模式」标识。
- [ ] 切换 K 线周期或交易对后，历史研究回答的内容与快照不变。
- [ ] 上表八种异常状态各有对应 UI 态并可人工触发核对。
- [ ] 移动端 <760px 三标签切换正常；仅用键盘可完成发起到查看结果的闭环；交互元素均有 aria 标签。
- [ ] Admin 三个页面仅 superadmin 可见可用，普通用户访问被守卫拦截。
- [ ] `pnpm typecheck` 与 `pnpm build` 通过。

## 参考来源

### 设计决策 ↔ 模式来源

各决策的完整模式描述与适配差异见 docs/references/financial-agent-patterns.md §2。

| 设计决策 | 借鉴的模式来源 |
| --- | --- |
| 四区布局（顶栏/左栏历史/中栏图表/右栏对话） | Bloomberg Terminal 多面板多任务、OpenBB Workspace 仪表盘 + AI 侧栏并存、FinRobot 数据与结论并排 |
| 证据抽屉与引用冻结快照 | AlphaSense 引用定位来源片段 |
| 点击证据联动 K 线 bar / 原文页码 | AlphaSense 引用定位 + Daloopa 数值单击溯源原文 |
| SSE 进度逐步渲染 | LangGraph Streaming 节点级流式输出 |
| 确认卡（缺失信息补全/关键参数确认） | LangGraph Interrupts 人在回路中断/审批 |
| 不可用状态展示（模型未就绪/报价缺失/期限未验证/数据过期） | Kalshi 概率作为主展示的反向约束（无可靠概率则空态不编造）+ Fiscal.ai 数值必须可溯源，无法溯源则不展示 |
| 移动端三标签（图表/对话/证据） | 多面板体系（Bloomberg/OpenBB）在小屏的退化策略，为本项目自适配决策，非直接借鉴某产品 |

### 链接清单

- 仓库内：`web/src/styles/`（token 在 `base.css`，`.panel`/按钮在 `components.css`）、`web/src/components/Header.tsx`（TABS）、`web/src/brooks/BrooksChart.tsx` 与 `web/src/brooks/indicator.ts`（研究/复盘共用图表与指标层）、`web/src/research/`（ResearchPage + useResearchRun/useResearchConversation/useResearchCandles + RunBubble/PositionConfirmCard）、`web/src/ai/`（AiAssistant FAB + AiChat + AiContext）、`web/src/pages/AdminPage.tsx`、docs/specs/api-storage.md、docs/specs/perpetual.md、docs/specs/event-contracts.md、docs/specs/knowledge-rag.md。
- 交互模式参考（模式研究，非完整审计；核验日期 2026-09-30 / 2026-10-09，详见 docs/references/financial-agent-patterns.md §2）：[FinRobot](https://github.com/AI4Finance-Foundation/FinRobot)（数据与结论并排）、[AlphaSense](https://developer.alpha-sense.com/agent-api/response-parsing)（引用定位来源片段）、[Fiscal.ai](https://docs.fiscal.ai/docs/guides/mcp-skills)（数值可追溯到原始资料）、[Perplexity 官方开发文档](https://docs.perplexity.ai/)（回答内建引用）、[Bloomberg Terminal 公开入门指南](https://guides.library.yale.edu/Bloomberg/Bloomberg_Basics)（多面板多任务）、[OpenBB Workspace Copilot 文档](https://docs.openbb.co/workspace/analysts/ai-features/copilot-basics)（仪表盘 + AI 侧栏）、[Daloopa](https://daloopa.com/benefits/deepest-dataset)（数值单击溯源原文）、[LangGraph Streaming](https://docs.langchain.com/oss/python/langgraph/streaming) 与 [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)（流式步骤与人在回路确认）、[Kalshi](https://kalshi.com/learn)（概率作为一等展示对象）。
