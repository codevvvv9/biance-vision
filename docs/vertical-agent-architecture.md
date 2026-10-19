# 比特币垂类 Agent 架构改进方案（基于蚂蚁阿福逆向）

> 状态：P0 + P1 implemented（P0 2026-10-16 落地；P1 2026-10-19 落地，验收勾选见 §6；P2 待执行）｜proposed v2（2026-10-16 审核修订版，修订记录见 §8）｜创建：2026-10-16
> 逆向对象：蚂蚁阿福 `com.antgroup.aijk.android` v1.1.69.8000（Ant Group AI 健康管家，网页版 chat.antafu.com）
> 逆向产物留存：`/tmp/afu-apk/`（class_inventory.txt 十万类清单、dex_strings_cn.txt 70.9 万字符串、mth_*.json / cls_*.json JADX 反编译结果、AndroidManifest_decoded.xml）
> 配套技能：`.agents/skills/financial-research-agent/SKILL.md`、`.agents/skills/knowledge-rag/SKILL.md`、`.agents/skills/research-ui-spec/SKILL.md`

**阅读指引**：
- 只执行 P0/P1/P2 某一项的 agent：直接读 §0.1（红线）→ §3（现状详注）→ §4 对应域 → §6 对应任务项。
- 审阅整体方案的：通读即可。
- 想了解某条设计"为什么"的：§2 是阿福的对应做法与证据。

**证据分级约定**（全文适用）：本文引用的阿福事实分三级标注——
- **【静态证据】**：APK 静态分析直接观察到（类/方法/字段/字符串），可复查 `/tmp/afu-apk/` 产物。
- **【架构推断】**：由静态证据推断的完整系统行为（阿福服务端生产系统不可见，无法验证）。
- **【我方设计】**：本方案为 biance-vision 做的设计选择，不声称与阿福比较优劣。

---

## 0. TL;DR 与已确认决策

蚂蚁阿福的客户端呈现出一条清晰的工程路线【架构推断，基于静态证据】：**垂类智能集中在服务端按场景路由，客户端只做采集上下文、路由入口、流式呈现、配置驱动 UI**。其 APK 主链路静态分析未发现系统提示词与领域判断逻辑【静态证据】。

对照 biance-vision：我们的**研究管线纪律**（数值不进 LLM、发布门控、证据冻结）是应当保留的资产【我方设计】。v1 方案的排序偏重管理与展示能力；v2 按审核意见把**直接决定垂类回答质量与复现性的闭环提前到 P0**（评测基线、统一可信入口、逐条证据绑定、知识版本补齐、失败降级、提示词冻结），管理与展示能力后移。

**已确认决策**（2026-10-16，用户拍板 + 审核修订）：
1. 提示词组织：**管理后台版本化**——prompt_templates 注册表，复用 agentVersions 生命周期模式（draft→发布不可变→指针回滚）；执行阶段只读冻结内容。
2. 路线图颗粒度：**文件级 + 验收标准**（可直交其他 agent 执行）。
3. 旧聊天链路 A（`/api/ai/chat` + aiMemory）：**记忆收编进研究会话链路后退役**（收编 P1、退役 P2，分两步）。
4. **审核修订（v2）**：质量闭环进 P0；场景拆三维度；追问推荐改结构化动作；画像三层化且独立 PG 表；过程事件与安全事件二分；卡片配置后移并锁数据来源；评测先行（chatLite 未经评测不落地）；阿福结论按证据分级收敛措辞；前端落点更新到 WorkbenchPage 体系。

### 0.1 执行者须知：十二条红线（任何任务不得违反）

1. **数值纪律**：盈亏/费用/资金费率/EV/概率一律由代码计算（`perpetualAnalyzer`、统计模块），LLM 只做归纳与表述，禁止让 LLM 产出或改写任何数字。所有新增提示词模板必须包含否定性约束（"禁止编造/推算数字"）。受约束综合解释（P1-2）同样只能引用已计算事实。
2. **冻结语义不可破坏**：run 创建时 `freezeRunConfig`（`server/src/research/runs/store.ts:164-208`）冻结的配置在 run 生命周期内不可变；`version_mismatch` 校验（`server/src/services/validator.ts:147-150`）依赖这一点。执行阶段**只读冻结内容，不得再次解析当前发布指针**（提示词注册表同样适用，见 B 域）。不得让任何阶段在运行中读取"当前发布配置"替代冻结值（retrieve 阶段评审 F4 的教训，`stages.ts:386-387`）。
3. **反证轮次语义**：countercase 每次**执行**内恰好一轮 LLM 调用；修复环重入 countercase 时允许再次执行，总调用数仍受 `DEFAULT_MAX_LLM_CALLS`（当前 6，P1-2 落地时调 7）约束。禁止多轮辩论/投票当置信度。
4. **SSE 向后兼容**：新增事件类型不得改变现有五种事件（`shared/src/contract/research.ts:121-127`）的结构；旧客户端对未知事件类型安全忽略（`useResearchRun` 的 switch 有 default 分支，实施时确认）。SSE 链路（pipeline emit → runBus 落 `run_events` 拿 seq → `routes.ts:350-441` 游标重放）不改传输机制。
5. **step_detail 事件只描述真实过程**：只携带真实阶段名、工具状态、计数（如"反证归纳中→获得 3 条"），**不得描述为模型思维链**，不得携带提示词全文、证据原文、用户消息原文——防止 SSE 通道成为数据泄露面。
6. **PG 权威**：新增状态一律落 PostgreSQL，不引入 JSON 文件镜像（旧链路 A 的 ai-chats.json 与 `users.ts:68` 的 JSON 热数据模式都是反面教材；traderProfile 因此用独立 PG 表，见 D 域）。
7. **知识库不可变发布与复现性**：`knowledge_versions` 发布快照不可变（`knowledge/store.ts:249-297`）；引用冻结（`freezeEvidence`，`store.ts:280-301`）后文档更新不影响历史引用。**run 冻结的知识版本必须约束全部三层资料**（原始资料/规则卡/案例）——P0-4 补齐现有缺口。聊天引用冻结复用同一机制，不得另造。
8. **权限边界**：admin 端点全部 `requireSuperadmin` + 写 audit（现有模式，`knowledge/routes.ts`）；用户侧端点 `requireSession`。新增端点照抄现有挂法。
9. **外部页面是证据不是指令**：web 搜索核验（`research/search.ts` 白名单/重定向≤3/30s/1MB）的结果只作为证据行，永远不进入系统提示词的指令位。
10. **免责与风控不前端化**：免责文案、敏感判定阈值由服务端下发/执行（H 域），前端只渲染，不内置文案常量。
11. **事件分类二分**：`security_interrupt` 仅用于必须硬中断的安全场景（version_mismatch）；行情过期/模型未发布/报价缺失等**可用性问题是任务级受控降级**（`task_degraded` 事件：补问/禁用部分输出/降级发布，由任务语义决定），不得混用。
12. **敏感检测的处置边界**：LLM 输出侧命中敏感 → 拦截该输出或触发修复（重试一次/回退模板），**不处罚用户**；用户输入侧命中 → 走既有 chatPolicy 通道。类目仅限辱骂/诱导梭哈/保证收益（宏观政策研究是正当高频场景，不设"政治"类目）。

---

## 1. 逆向方法与边界

三轮递进，全部静态分析（未运行 APK）：

| 轮次 | 方法 | 深度 | 关键产出 |
|---|---|---|---|
| 一 | DEX 字符串表 + 类描述符清单（Python 直解，10.8 万类） | 包结构/端点面 | 五层架构、RPC 面、preAgentId 矩阵 |
| 二 | DEX field/method 表全扫描（按 class_idx 匹配，绕开 class_data uleb 解码坑） | 数据模型 | 请求/响应 PB 完整字段、HealthArchive 结构 |
| 三 | REA CLI + JADX（OpenJDK 17 + jadx-headless-mcp 0.7.1，62,085 类全索引） | 方法体 | XUIClient 请求组装、流式四通道、消息子类型枚举 |

**边界**：阿福服务端生产系统不可见——本文对阿福的全部结论限于客户端静态证据与其合理外推（分级标注）；不声称比较双方生产效果。方法级反编译覆盖聊天主链路，语音会话/端侧引擎只到类结构层。

---

## 2. 阿福垂类架构速览（十条核心机制）

### 2.1 服务端 Agent 矩阵 + 场景路由 + 上下文旁路

- 首页每个垂类功能 = 一个**服务端预置 agent**（`preAgentId`，如 `arec2_med_consultation`），客户端只带路由参数：`/chat?query=AI诊室&preAgentId=…`、`/chat?goto=camera&bizType=1`（拍报告）、`bizType=3`（拍皮肤）。【静态证据】
- 主问答接口刻意做薄（`ChatAnswerQueryReqPB`）：`{ sessionId, sceneCode, queryId, extParams(Map<String,String>) }`——**接口恒定、场景路由、垂类上下文全部走 extParams 旁路**【静态证据】；"一个聊天接口服务全部垂类功能、新增垂类不动协议"是【架构推断】。
- 非核心能力跳生态（专家问诊/购药跳支付宝小程序），不自建。【静态证据】

### 2.2 请求级用户上下文参数表（`XUIClient.startGrpcRequest` 方法体恢复）

每次发消息，客户端组装并上报一组参数（`Map<String,String>`）【静态证据】：

| 类别 | 参数 | 说明 |
|---|---|---|
| 位置 | `cityCode/cityName/latitude/longitude/lbsAuthStatus` | 实时定位（先 120s 缓存→现场定位流），连"是否授权定位"都上报 |
| 用户状态 | `appUserState`（游客/正式）、`oaid`（设备号）、`pushPermission` | 服务端决定引导策略【架构推断】 |
| 人群适配 | `elderCare`（适老化开关） | 服务端切换回答风格【架构推断】 |
| 隐私 | `privateMode` + `userPrivatePreference`（本地缓存偏好） | 隐私模式换数据处理策略【架构推断】 |
| 推理控制 | `customChatMode`（思考模式，`IJKChatConfig` 灰度控制是否携带） | 思考模式是下发开关 |
| 会话 | `queryFrom`、`chatBizVersion`、`rewriteChatId`、`first_query` | |
| 实验 | `afu_2.0`、`feedbackVersion`、`guestExpeTag` | 全链路 AB 旗标 |

**设计思想【架构推断】**：客户端把"用户是谁、在哪、什么状态、什么偏好"全部参数化上报，垂类适配全部由服务端完成。

### 2.3 消息协议：过程状态与安全是一等公民

流式消息体 `ChatContentVOPB` 含 **`cot`（思维链）+ `cotStep`（步骤）** 字段，与正文一起流式下发；`tool`（工具调用标识）、`delta`（增量标记）、`ref`（引用）、`subList`、`feedbackData`、`status`。【静态证据：字段存在与流式下发；服务端如何生成 cot 内容未知】

消息块 `XUITextInfo = {content, extParams, full, hasNext, itemId, subType}`，`subType` 枚举（17 值）【静态证据】：

- 输入：`INPUT_TEXT / INPUT_IMG / INPUT_PDF / USEDOM`（agent 直接操作界面）
- 展示：`DISPLAY_MARKDOWN / A2UI / XUIHTML / XUIHTMLUPDATE / XUISCHEMA` —— **A2UI = 服务端直接流式下发结构化 UI**
- 安全：**`SECURITY_INTERRUPT / SECURITY_TERMINATE`** —— 安全拦截是流协议内建的消息类型
- 音频：`AUDIO_ASR / AUDIO_TTS`；流式文本：`BIZ_STREAMTEXT`

引用模型 `ChatCitationVOPB = {title, url, summary, channel, doc, icon, publishTime}`；TTS 字幕时间轴 `TtsTimeLinePB = {startIndex, endIndex, startTime, endTime}`。【静态证据】

> 我方借鉴边界：我们采纳"过程状态随流下发"（C 域），但 step_detail 只描述**真实阶段/工具状态/计数**，不展示也不声称展示模型思维链【我方设计】。

### 2.4 四通道流式 + 卡片化 + 分级超时

`XUIClient.doSendByGrpc` 建立**四个独立 SharedFlow**：数据流（正文块 `XUIResponseInfo`）/ 事件流（卡片级事件 `Triple<chatId, int, XUICardInfo>`）/ 数据状态流（String）/ 查询状态流（`Triple<chatId, int, JSONObject>`）。`CardProcessTracker` 把流数据逐条转成卡片懒生成（Deferred + 状态机）。超时按输入类型分级：**纯文本单条 5 秒、含图/PDF 30 秒**（ChatWatcher）。传输层为 `com.alipay.mobile.streamingrpc`（gRPC MethodDescriptor over 网关长连接）；`AQGrpcWorker`（接口）→ `XUIClient`（实现）；cognicore `ChatRpcFacade` 引用追踪 total=0，为死代码。【静态证据】

### 2.5 输入面板全配置驱动 + 健康档案上下文卡

`InputDATA = {extInfo, inputHasPlusButton, inputPlaceholderList, inputPlusPanelConfig, inputServiceList, inputShortcutButtonConfig, inputSugLimitCount}`——占位文案、加号面板、服务入口、快捷按钮、建议条数上限全部服务端下发。【静态证据】

**HealthArchive 是聊天输入管线的一等公民**（`ijkchat.biz.input.impl`，与文字/图片并列的输入类型）：

```
ExtInfo = { healthArchive, imageUploadConfig, inputType }
HealthArchive = {
  healthArchivesConsumerCurrent/Default : HealthConsumer,   // 当前/默认服务的家庭成员
  healthArchivesConsumerSize : Int,  healthArchivesHasSelected : Boolean,
  uniqueConsumer : HealthConsumer,
  healthArchiveBtnConfig / healthArchiveDialog / viewHealthArchive : HealthItemData,
  healthConsumerCardData : JSONObject
}
HealthConsumer = { memberId, name, role, consumerHealthInfoCompleted }
HealthItemData = { title, selectTitle, actionType, actionUrl, btnStatus, canShowTips,
  resourceUrl, privateModeResourceUrl, switchConsumerResourceUrl, unFillHealthInfoResourceUrl }
```

连「隐私模式」「切换成员」「健康信息未填写」三种状态都有独立的服务端下发资源 URL——**上下文卡是按用户状态动态拼装的配置树**，随请求经 `ExtInfo(healthArchive=…)` 发送。【静态证据】档案成员由 `RpcRequestClient.requestHealthInfo` 拉取。

### 2.6 RAG：引用 + 追问推荐 + 多模态预处理

网关 RPC（29 个请求类型）中与 RAG 相关：`ChatCitationQuery`（引用查询）、**`ChatQueryRec` / `LlmAppChatSugRec`（追问推荐）**、`LlmHealthFilePreprocess`（文件解析预处理）、`LlmHealthImageRecognition`（图像识别）。【静态证据】

图像识别的场景自动路由（`recognizeImageSync` 方法体）：`uploadScene` 未指定时按 UI 状态判断——数字人房间（`AIRoomState`）开着就 `SCENE_IMAGE_AIROOM`，否则 `main_chat`；新旧链路 `ChatConfig.enableSuspend()` 灰度切换。【静态证据】

### 2.7 MCP 工具层 + UI 自动化

预装 H5 运行时 **MiniUse**（agent.min.js，ap/v3.1.13）带完整 MCP 客户端：`mcpServerToolsMap / executeMCP / mcpServerConfig`，工具可被服务端开关（`mcpServerToolsDisabledBySwitchMap`）。XUI 语音 agent 经 MCP 调工具（`XUIMCPAbilityImpl`），并有 AlipayUse UI 自动化（`clickByIndex / onTargetFound`）。状态机 `AGENT_STATUS_LISTENING → THINKING → TTSPLAYING`。【静态证据】

### 2.8 端云分工

云端大模型做推理【架构推断】；**端侧小模型**（`llm_init_tokenizer / llm_init_xnn_compile_kernel / llm_loraid` LoRA 适配器）只做轻任务：会话标题生成、敏感内容检测（`llm_offensive_titile / llm_sensitive_event`）。【静态证据：接口名与调用面；"只做轻任务"为推断】另有 mobileaix 端侧引擎（1672 类：传感器特征/决策链/工具执行）。【静态证据：类结构】

### 2.9 数据护城河（健康垂类特有）

BLE 直连硬件：微泰 CGM（197 类）+ 鱼跃 CGM + Welland 体脂秤 + bravechipring 智能戒指（OTA）；手机健康 kit；血糖阈值告警、CGM 桌面小组件；manifest 291 项权限。【静态证据】**我们的对应物是行情库 + Brooks 结构引擎——已是资产，无需新增。**【我方设计】

### 2.10 主动服务与跨端

- **静默追问**：数字人/语音房间空闲时 `sendAIRoomSilenceQuery` 主动发 query。【静态证据：方法存在；触发策略未知】
- 首页 agent 分区：`ijklauncher.biz.fragment.agents`，卡片全模板化（`templateId/templateData/extInfo`），数据来自 `medinsaiservice.afu` SDK。【静态证据】
- 扫码跨端续聊；Markdown/表格专用预览页；数字人配置全参数化（`DigitalDoctorRpc`）。【静态证据】

---

## 3. 现状盘点与差距矩阵

### 3.1 差距总表

| # | 能力项 | 阿福做法（分级） | biance-vision 现状（文件:行号） | 差距 |
|---|---|---|---|---|
| 1 | 场景路由 | sceneCode+preAgentId【静态证据】 | 七意图硬编码（`conversation.ts:19`）+ 四产品代码分支（`stages.ts`） | 意图≠场景、无注册表；需按产品/任务/界面三维度拆分 |
| 2 | 提示词组织 | 服务端集中+热更新【架构推断】 | 5 处内联 + promptRef 空壳（§3.2.2） | 无版本化、无后台管理、无场景分层；queryRewrite 也要纳入 |
| 3 | 流式协议 | 过程状态+安全消息类型【静态证据】 | SSE 仅 5 种事件（§3.2.3） | 过程黑盒；需按安全中断/任务降级二分补事件 |
| 4 | 用户上下文 | 请求级参数表【静态证据】 | 无结构化画像；aiMemory 只服务死链路 A（§3.2.4） | 需三层上下文模型；存储需独立 PG 表（users.ts 是 JSON 镜像模式，不可沿用） |
| 5 | 上下文卡 | HealthArchive 挂输入管线【静态证据】 | 左栏点选+context PATCH+确认卡 | 有雏形，无统一"当前分析对象"卡 |
| 6 | 多 agent 编排 | 单 agent+服务端矩阵【架构推断】 | 八阶段+修复环；分析者=代码模板（§3.2.1） | 纪律保持【我方设计】；缺受约束综合解释与过程播报 |
| 7 | 回答质量闭环 | （不可比） | **四个质量缺口**（§3.2.7） | 逐条证据绑定/引用支持性校验/知识版本过滤/失败降级 |
| 8 | RAG | 引用+追问推荐【静态证据】 | 检索/冻结/调试是长板（§3.2.5） | 缺追问推荐（须结构化动作）；聊天概念问答不冻结引用 |
| 9 | 工具层 | MCP 统一调用【静态证据】 | 无统一注册表；五能力配置 | 工具分散 |
| 10 | 安全合规 | SECURITY_INTERRUPT【静态证据】 | chatPolicy/掐断/version_mismatch；免责硬编码 | 免责可热更；事件二分；敏感检测边界 |
| 11 | UI 交互 | 输入配置驱动/A2UI/扫码【静态证据】 | 研究台（刚重构为 Workbench，§3.2.6） | 结果卡表达、结构化追问、分享 |
| 12 | 模型分工 | 端云分工【静态证据】 | 单一 chat 模型 | lite 分工**须经评测验证后**再落地（P2） |

### 3.2 关键事实详注（执行者必读）

#### 3.2.1 研究管线与全部 LLM 调用点

管线是**固定八阶段状态机**：`plan → snapshot → structures → retrieve → product_analysis → countercase → validate → publish`（`STAGE_NAMES`，`orchestrator/types.ts:18-27`；实现 `runs/stages.ts:209-1112`：plan 210-247 / snapshot 249-280 / structures 282-369 / retrieve 371-505 / product_analysis 508-855 / countercase 857-955 / validate 957-1037 / publish 1039-1109）。失败修复环 `REPAIR_LOOP = ['product_analysis','countercase','validate']`（`pipeline.ts:34`，126-131 行回环重跑，耗尽后落 failed——**受控降级缺口见 3.2.7-D**）。状态机每步边界检查取消/预算（`pipeline.ts:95-113`）；执行器 `executeRun`（`runner.ts:51-157`）管终态去重、租约抢占（`store.ts:125-138`）、检查点水化（`runner.ts:24-34`）。pg-boss 队列 + `event:settle` 每 10 分钟（`jobs.ts:73-87`）。

**全管线 LLM 调用点 5 处**（P1-2 落地后变 6 处）：

| # | 调用点 | 位置 | 提示词 |
|---|---|---|---|
| 1 | 意图分类（会话层） | `runs/intent.ts:42-82`（确定性 27-37 优先，LLM 纠偏） | `intent.ts:20-36` 内联 |
| 2 | 检索查询改写 | `knowledge/queryRewrite.ts:26-75`（反漂移校验） | queryRewrite 内联 |
| 3 | 反证归纳（唯一 run 内 LLM） | `stages.ts:919-924` | `stages.ts:889` 默认模板 |
| 4 | 新闻归因附答（会话层） | `conversation.ts:458-501` | `conversation.ts:481-484` 内联 |
| 5 | 概念教学附答（会话层） | `conversation.ts:503-531` | `conversation.ts:515` 内联 |

三个"角色"的真实身份：**Brooks 分析者是代码模板**（`analyzeBrooks`+`structureView` 装配 claims，无 LLM）；**反证审查者**=调用点 3；**事件研究者**=web 搜索通道（`research/search.ts`）。

#### 3.2.2 提示词现状与 promptRef 空壳

5 处提示词全部内联（见上表）。promptRef 机制（未启用）：`AgentRoleSchema.promptRef`（`shared/src/contract/admin.ts:56`）+ `resolveRolePrompt`（`stages.ts:192-207`，支持 `inline:`/文件）——`server/data/prompts/` 不存在。Agent 版本机制（B 域复用其生命周期）：draft 可编辑（WHERE 带 status 防写穿，`agentVersions.ts:52-57`）、发布不可变+指针切换（78-100）、回滚=指针切回（114）。没有 base+角色+上下文分层拼装；产品分化全在代码层。

#### 3.2.3 SSE 现状

`RUN_PROGRESS_TYPES = ['step_started','step_completed','run_published','run_failed','run_cancelled']`（`shared/src/contract/research.ts:121-127`）。推送链：pipeline `emit()` → `runBus`（`store.ts:70-78`，先落 `run_events` 拿 seq）→ SSE（`routes.ts:350-441`，`?after=` 游标重放+按 seq 去重）。前端 `useResearchRun.ts:52-168`。**无中间产物事件；错误经 run_failed.payload.error。**

#### 3.2.4 聊天链路与双会话体系

- **链路 B（当前唯一前端链路）**：`POST /api/conversations/:id/messages`（`conversation.ts:202`，返回确定性模板回复+runId）→ SSE。`AiChat.tsx` 复用同链路。七意图路由；concept/news 直接作答不建 run；回复文本硬编码模板（687-699）。持仓草稿确认卡 `PATCH :id/context`（250-376，指纹幂等）；symbol 不一致自动摘除（550-576）；会话串行（386-400）。
- **链路 A（已死）**：`POST /api/ai/chat`（`index.ts:720-773`）+ aiMemory（JSON 镜像+PG 双写，84-141；每 6 条消息提取，40 条上限；`memoriesPromptBlock` 注入）——链路 B 不读，P1-5 收编、P2-1 退役。
- chatPolicy 三重限额口径见 `chatPolicy.ts:1-14`。

#### 3.2.5 知识 RAG（长板，只补闭环不改内核）

`searchHybrid`（`knowledge/retrieval.ts:173-399`）：发布版本过滤（180）→ 术语归一（199）→ 词项召回（230-241）→ **规则卡/案例伪 chunk 并列进 RRF（243-264，各留 1 席 319-324）→ 向量召回（268-295）→ RRF（76-86，k=60）→ 精排（140-171）→ 邻接扩展（358-385）**。引用冻结 `freezeEvidence`（`store.ts:280-301`）。规则卡发布不可变（`ruleCards.ts:134-165`）；案例 outcome 永不出库（317-340）。检索调试端点（`routes.ts:353-381`）。消费方：retrieve 阶段、聊天附答（不冻结引用，P1 补）、规则卡草拟、RAG 评测（`evalRunner.ts:46-70`，hits/MRR——评测基线 P0-1 的扩展基础）。

#### 3.2.6 前端结构要点（2026-10-16 工作台重构后）

研究台刚完成重构：新增 **`web/src/research/WorkbenchPage.tsx`**（313 行）+ **`UiModeSwitch.tsx`**（`ui=legacy/dev` 双模式开关）+ `WorkbenchChart.tsx`；`ResearchPage.tsx` 作为 legacy 保留（29,937 字节）。**执行涉及前端的任务前必须先确认当前 UI 模式与组件树**（本节行号基于重构前探索，执行时以实际代码为准）。其余组件：`useResearchConversation.ts:87-297`（发消息/PATCH/resolveCard）、`useResearchRun.ts:52-168`（SSE/取消）、`RunBubble.tsx`（8 步气泡）、`ResearchResult.tsx`（ResultCard 67-255、引用标记 135-160、EvidenceDrawer 257-345）、`useResearchCandles.ts:43-120`（冻结 K 线包回退）、`MiniMarkdown.tsx`（react-markdown+katex，禁 raw HTML）。K 线三层联动：证据定位 bar / 冻结输入包 / 价位叠加。

#### 3.2.7 四个质量缺口（v2 审核确认，P0 修复对象）

| # | 缺口 | 代码位置 | 事实 |
|---|---|---|---|
| A | **反证证据绑定粗粒度** | `stages.ts:930` | `counterClaims.push({ text: line, evidenceIds: rows.slice(0, 2).map(e => e.id) })`——每条理由不分内容统一绑前两条反证资料 |
| B | **校验器只查引用存在** | `validator.ts:65-70` | 仅 `reference_missing`（ID ∈ knownEvidenceIds）+ 概率红线；不检查资料是否支持该声明 |
| C | **规则卡/案例不按冻结知识版本过滤** | `retrieval.ts:243-264` | `publishedRuleCards()/publishedCasesForRetrieval()` 无版本参数——原始资料层有 `publishedDocVersionIds` 过滤（180 行），这两层没有：历史 run 复现时会读到后来发布的规则卡/案例，破坏复现性 |
| D | **修复耗尽无受控降级** | `pipeline.ts:126-135` | `repairs < maxRepairAttempts` 耗尽后落 `stepFailed`→run failed；未实现注释承诺的受控降级 |

另有存储反例：`users.ts:68-70` 是"JSON 镜像热数据 + PG 副本"模式——与红线 #6 冲突，traderProfile 必须用独立 PG 表（D 域）。

---

## 4. 改进方案（十大域）

每域格式：阿福做法 → 我们的差距 → 目标设计（含结构定义）→ 改动步骤 → 落点文件。

### A. 场景注册表（产品/任务/界面三维度分离）

**阿福**：sceneCode 路由【静态证据】。**我们**：七意图+四产品都在代码层，未显式建模。

**目标设计**：保留三个独立维度，`sceneCode` 只统一**任务场景**配置，不替代产品契约与服务端权限校验；界面模式（`ui=legacy/dev`，已存在）单独传递，**不得**同时改变模型与研究逻辑；后台能力版本沿 run 冻结（已有），与界面模式解耦：

```
Product     = 'spot' | 'perp' | 'event'                  // 产品契约：数值计算/校验规则/结果契约随产品走（现有 product 分支的显式化）
TaskScene   = 'hold-review' | 'structure-scan' | 'concept-teach'
            | 'quote-review' | 'replay-analysis' | 'news-attribution'   // 场景：决定提示词集/追问动作集/结果卡模板
UiMode      = 'legacy' | 'dev'                            // 纯前端展示模式，不入研究语义
SceneDef    = { code: TaskScene, product: Product[], promptSet, followUpSet, resultCardTemplate }
```

**改动步骤**：
1. `shared/src/contract/research.ts` 加三维 schema 与 `TASK_SCENES` 枚举；新建 `server/src/research/scenes.ts`（SCENES 常量表 + `resolveScene(intent, ctx)`：按会话上下文把意图映射到场景，携带 product）。
2. `conversation.ts` 意图路由后调 resolveScene，场景记入 `conversation_messages.sceneCode`；`POST /api/research/runs` 接受 sceneCode 记入 run 行。
3. 前端场景下拉与 TaskScene 对齐；每个入口卡带预设 query+sceneCode（"入口即 agent"）。涉及 WorkbenchPage 体系（§3.2.6，执行时定位）。
4. **约束**：sceneCode 不得绕过产品级校验（perp run 仍须持仓归属校验）；ui 参数只作用于前端渲染开关，服务端不读。

**落点**：`shared/src/contract/research.ts`、`server/src/research/scenes.ts`（新）、`conversation.ts`、`routes.ts`、`models.ts`（加列）、`web/src/research/WorkbenchPage.tsx`/`ResearchPage.tsx`（双 UI 模式均接）。

### B. 提示词组织（管理后台版本化，含审核补强的五条约束）

**阿福**：服务端集中+热更新【架构推断】。**我们**：5 处内联+空壳。

**目标设计**：prompt_templates 注册表，复用 agentVersions 生命周期。**审核补强**：

1. **冻结即终解析**：run 创建时（freezeRunConfig）解析模板并冻结 `{templateId, name, version, content}` 全文进 `frozenConfig.raw.prompts`；**执行阶段只读冻结内容，禁止再次解析发布指针**（红线 #2）。
2. **五个模板迁移**（含此前遗漏的 queryRewrite）：`intent-classifier` / `counter-reviewer` / `news-attribution` / `concept-teaching` / `query-rewrite`（run 内调用点 #2，同样受冻结约束）。
3. **指针键复合场景作用域**：`prompt_template_pointers` 主键为 `(name, scene)`（scene 可空=全局）；同名模板可按场景差异化。
4. **不可变与生效分离**：published 行永久保留可解析（rollback=指针切换，不删除历史版本）；run 冻结引用具体 templateId+version，与"当前生效"无关。
5. **不做长缓存**：resolvePromptTemplate 每次 run 创建直接查 pointer 表（每 run 1-2 次索引查询，成本可忽略）——规避 API 与 pg-boss worker 双进程缓存失效问题，不引入失效机制。

```sql
prompt_templates: { id uuid PK, name text, scene text NULL, status 'draft'|'published'|'retired',
  version int, content text, note text, published_at, created_by, created_at, updated_at }
  -- 同 (name, scene) 内 version 递增；published 不可编辑（WHERE status='draft' 防写穿）
prompt_template_pointers: { name text, scene text NULL, published_id uuid, updated_at }  PK(name, scene)
```

解析链（新模块 `server/src/research/prompts.ts`）：run 冻结显式 promptRef（`inline:`/`registry:`/旧文件名兼容）> pointer→published > 工程默认内联（三级回退，缺省不阻塞，记日志）。占位符：`{{vertical}}`（按 product 注入差异化段落）、`{{traderProfile}}`、`{{memory}}`、`{{knowledgeVersion}}`，服务端统一拼装。会话层提示词不冻结全文，在 `conversation_messages.promptRefs` 记 `{name, scene, version}`（可审计）。

**改动步骤**：表+迁移（种子=5 个 published v1，逐字拷贝现文本）→ prompts.ts → stages/intent/conversation/queryRewrite 换链 → freezeRunConfig 冻结解析结果 → admin API（GET/POST/PUT/publish/rollback，requireSuperadmin+audit）。编辑页 P1。

**落点**：`server/src/models.ts`、`server/drizzle/`、`server/src/research/prompts.ts`（新）、`stages.ts`、`intent.ts`、`conversation.ts`、`knowledge/queryRewrite.ts`、`store.ts`、`admin/routes.ts`。

### C. 会话协议升级（过程事件与任务降级二分）

**阿福**：过程状态流式+SECURITY_INTERRUPT【静态证据】。**我们**：5 种事件、过程黑盒。

**目标设计**（红线 #4/#5/#11）：

```
RUN_PROGRESS_TYPES += ['step_detail', 'security_interrupt', 'task_degraded']

StepDetailPayload = { step, kind: 'llm_call'|'retrieval_variant'|'repair_loop'|'evidence_frozen'
  |'structure_claim'|'synthesis', label, status: 'started'|'finished',
  detail?: { count?, round? } }            // 真实阶段/工具状态/计数；不称思维链，无正文

SecurityInterruptPayload = { code: 'version_mismatch', reason, at }   // 仅硬中断场景

TaskDegradedPayload = { code: 'data_stale'|'model_unpublished'|'quote_missing'|'repair_exhausted',
  handling: 'ask_user'|'partial_output'|'degraded_publish', reason, at }
  // 任务级受控降级：补问用户 / 禁用部分输出 / 降级发布（P0-5），由任务语义决定
```

**改动步骤**：
1. `shared/src/contract/research.ts` 扩枚举+三个 payload schema。
2. 发射点：反证 LLM 前后、检索变体、修复环、证据冻结、结构声明装配（stages/pipeline 内，各 1-2 行 emit，payload 严格无正文）。
3. `validator.ts` version_mismatch：先 emit security_interrupt 再终态；行情过期/模型未发布/报价缺失 → task_degraded + 对应 handling（与 P0-5 降级路径衔接）。
4. 前端：`useResearchRun.ts` 三分支；`RunBubble.tsx` 子步骤行（真实状态，不称思考）；task_degraded 横幅（附 handling 文案）；security_interrupt 醒目中断横幅。涉及 Workbench 体系组件定位（§3.2.6）。

**落点**：`shared/src/contract/research.ts`、`stages.ts`、`pipeline.ts`、`validator.ts`、`web/src/research/useResearchRun.ts`、`RunBubble.tsx`（及 Workbench 对应组件）。

### D. 用户上下文与画像（三层模型 + 独立 PG 表）

**阿福**：请求级参数表【静态证据】。**我们**：无画像；`users.ts` 是 JSON 镜像模式（红线 #6 冲突）。

**目标设计**：**三层上下文**（对齐现有会话 context 结构并补元数据）：

```
第一层 长期研究偏好（trader_profiles 表，独立 PG，用户确认后生效）
  { riskProfile: 'conservative'|'balanced'|'aggressive'|null,
    experienceLevel: 'novice'|'intermediate'|'pro'|null,
    leverageHabitMax: number|null,        // 描述性字段："历史持仓最大杠杆"，由持仓历史派生+用户可改
                                           // 不是授权上限——展示名即"历史习惯"，aggressive 判定需用户显式确认
    disclaimerAck: boolean }
第二层 已确认但会过期的上下文（现有 portfolio/quote 数据，已带 confirmedAt/isStale）
  使用时必须检查有效期；过期 → task_degraded(code:data_stale, handling:ask_user) 补问
第三层 本次假设（会话 context 的 symbol/interval/draft，随会话生存）
每项携带：{ source: 'user_confirmed'|'derived'|'session', confirmedAt, validUntil?, version }
```

- 存储：新表 `trader_profiles`（PG 权威，红线 #6；**不挂 users.json**）；`GET/PATCH /api/users/me/profile`；admin 可代改。
- 随 run 上报：run 创建时画像快照进 run context；提示词 `{{traderProfile}}` 注入一行摘要。适配规则服务端实现：novice 概念回答附术语解释（规则卡链接）；过期持仓强制补问（C 域 task_degraded）。
- **Context Card**：`ContextCard.tsx` 常驻研究台与 AiChat，显示当前分析对象三态（持仓/报价/裸 symbol+周期+快照时间）+ 有效期徽章（新鲜/过期需确认）；切换/清除操作不变（仍走 context PATCH）。

**落点**：`server/src/models.ts`（trader_profiles）、`server/src/research/profileRoutes.ts` 或并入现有（新端点）、`routes.ts`（run 快照）、`prompts.ts`（占位符）、`web/src/research/ContextCard.tsx`（新）、Workbench/ResearchPage、`AiChat.tsx`、admin 用户页。

### E. 多 Agent 编排（保持纪律，补受约束综合解释与过程播报）

**阿福**：单 agent+服务端矩阵【架构推断】。**我们**：八阶段+代码模板分析者+单轮反证——"LLM 不碰数字"纪律保持【我方设计】。

**目标设计**：
1. **过程可视化**（C 域承载）：结构声明装配逐步播报（来自 Brooks 引擎输出）；反证归纳播报条数与立场分布。
2. **受约束综合解释**（新增第 6 个 LLM 调用点，P1-2）：publish 前对用户原问题做一次受约束综合——提示词只允许引用：已计算事实（claims/fact 行）、适用条件与失效条件（规则卡/结构规则）、已冻结证据；禁止产出任何新数字/新结论。产出经统一校验（引用 ID 有效+锚定词项支持+概率红线）。`DEFAULT_MAX_LLM_CALLS` 6→7（冻结配置，未开启时维持 6）。
3. **反证三视角分组**（P2 评估）：仍是一轮调用，模板要求按「规则失效/宏观事件/数据质量」三视角各归纳一条。
4. **静默跟进**（P2）：`event:settle` 扩展——最近 24h 发布 run 的关键价位是否被新收盘 bar 打破（Brooks 引擎判定辅助）；命中写 follow_up_suggestions；研究台顶部提示+一键重跑（同 context）；不做外部推送。

**落点**：`stages.ts`、`pipeline.ts`、`jobs.ts`、`models.ts`（follow_up_suggestions）、Workbench 提示条。

### F. RAG 与知识库流程（结构化追问 + 聊天引用冻结 + 规则卡前置）

**阿福**：ChatQueryRec 追问推荐【静态证据】。**我们**：检索/冻结/调试是长板。

**目标设计**：
1. **结构化追问推荐**（v2 修订：动作而非聊天文字）：
```
FollowUpAction = {
  action: 'open_evidence'        // 打开当前 run 证据抽屉（不触发新研究）
        | 'rerun_with'           // 以 sourceRunId 的 context 重建 run（parameters 可改 interval/symbol）
        | 'switch_context'       // 修改会话 context 参数（明确改哪个：interval/symbol/positionId）
        | 'open_rule_card'       // 打开命中的规则卡
        | 'counter_search',      // 反证方向的定向检索（新研究，明确告知）
  label: string,                 // 仅显示文案
  sourceRunId: Id,               // "查看反证"=打开这个 run 的证据，而不是重新提问
  parameters: { interval?, symbol?, positionId?, quoteId?, stance? },
  prerequisites: { tool?, dataReady? }   // 服务端按工具/数据就绪门控展示；未就绪不返回该动作
}
```
语义纪律：触达执行价（touch）与到期高于执行价（above）在 event 场景建议文案中明确区分；"历史触达统计"类动作仅在对应数据/工具就绪时返回。发布时由确定性模板按 scene 生成动作对象（P1-3）；文案不包含未在结果中出现的数字。
2. **聊天引用冻结**：concept 回答（`conversation.ts:503-531`）复用 `freezeEvidence`（owner 泛化 `{runId?|messageId?}`，红线 #7）；reply 用 `[N]` 标记；消息行存 evidenceIds；前端标记可点开证据抽屉。
3. **规则卡前置**：concept-teaching 场景提示词接收命中规则卡 JSON，回答按其结构组织；未命中维持现状。

**落点**：`stages.ts`（publish 生成动作集）、`shared/src/contract/research.ts`（FollowUpAction）、`models.ts`（evidence_items 加 conversation_message_id）、`conversation.ts`、`ResearchResult.tsx`/Workbench 结果组件、`AiChat.tsx`。

### G. MCP 与工具层（内部工具注册表）

**阿福**：MCP 统一调用+服务端开关【静态证据】。**我们**：工具散在各阶段。**先内部注册表、后 MCP 化**：

```
server/src/tools/registry.ts（新）：ToolDef = { name, inputSchema(zod), handler, numericOutputOnly }
market.candles / market.snapshot / knowledge.search / structure.analyze / portfolio.evaluate / news.search
（全部包装现有函数，保留冻结/白名单语义；outcome 不泄漏等约束原样保留）
```

短期：会话层附答与未来工具循环统一走注册表；admin 展示工具清单+开关（app_settings，关闭后对应附答降级并日志说明）。长期：registry 外包 MCP 适配器（modelcontextprotocol SDK），多端开放时再启用。

**落点**：`server/src/tools/registry.ts`（新）、各服务导出内部函数、`capabilities.ts`、AdminAgentsPage。

### H. 安全与合规

**阿福**：SECURITY_INTERRUPT【静态证据】。**我们**：chatPolicy/掐断/version_mismatch 已有，免责硬编码。

**目标设计**：
1. **免责服务端配置**：`app_settings` 键 `research_disclaimer_{perp|event|common}`；回复组装与结果卡从配置读取；admin GET/PUT+audit。基线文案："研究结论基于历史结构与公开数据，不构成投资建议；合约交易有爆仓风险。"
2. **事件二分**（C 域）：version_mismatch=security_interrupt 硬中断；行情过期/模型未发布/报价缺失=task_degraded 受控降级（补问/禁用部分输出/降级发布）。
3. **敏感检测边界**（红线 #12）：类目仅 辱骂/诱导梭哈/保证收益（**无"政治"类目**——宏观政策研究正当）；LLM 输出命中→拦截或修复（重试一次/回退模板），不处罚用户；用户输入命中→chatPolicy 通道。检测模型经评测验证后启用（P2，与 chatLite 同批）。
4. **提示词红线**：所有模板注入否定性约束（禁止保证收益表述/编造数字；结论须附可溯源引用或不确定性说明）。

**落点**：`conversation.ts`、`admin/routes.ts`、`chatPolicy.ts`（挂钩）、`llm.ts`、admin 设置 UI。

### I. UI 交互

**阿福**：输入配置驱动/A2UI/扫码【静态证据】。**我们**：Workbench 刚重构，表达力待补。按价值排序：

1. **结构化追问条**：结果卡底部渲染 FollowUpAction chips（F 域数据）；点击按 action 分发（开抽屉/建 run/改 context），**不默认转成聊天消息**。
2. **结果卡 schema 化（P2，数据来源锁定）**：`cardSchema` 只定义布局块序列，**块引用已校验字段/事实 ID，数值由前端从 result 数据渲染**——schema 不携带可自由生成的价格与结论；`confidence` 块必须有统计模块来源，概率不可用时显示"暂无校准置信度"而非高/中/低。已有块重组无需发版；**新增块类型仍需前端支持**（v1 过度承诺已修正）。
3. **输入面板配置化**：`app_settings` 键 `chat_input_config`（按 scene：快捷按钮（动作型）/占位文案/建议条数上限）；Workbench 对话面板与 AiChat 渲染，缺失回退内置。
4. **行情截图多模态（P2）**：贴图→vision 识别 symbol/周期/图上文字→确认卡（screenshot_context）→写 context。截图只用于定位，价格一律以行情库为准（红线 #1 延伸，确认卡明示）。
5. **分享链接（P2，含字段投影与撤销）**：`share_tokens` 表+只读快照页；**默认字段投影排除画像/持仓/未发布内容**，仅公开结论+证据+冻结 K 线；token 可撤销（admin+创建者）、可过期。

**落点**：`shared/src/contract/research.ts`、`stages.ts`、Workbench/ResearchPage 结果组件、`AiChat.tsx`、`routes.ts`。

### J. 模型分工与成本（评测先行）

**阿福**：端云分工【静态证据】。**我们**：单 chat 模型。**v2 修订：chatLite 全部后移到 P2，且以 P0-1 评测集验证为前提**——"lite 是否降低成本且不损失路由/生成质量"由评测结果决定，不先验假设。

评测通过后落地：capabilities 第六能力 `chatLite`（解析链同现有）；`resolveLlmClient({kind})` 回退 chat。消费者：意图分类、会话标题、敏感检测、追问推荐 v2、记忆提取。主模型保留：反证归纳/概念教学/新闻归因/综合解释。

**落点**：`shared/src/contract/admin.ts`、`capabilities.ts`、`llm.ts`、`intent.ts`、`conversation.ts`、AdminAgentsPage。

---

## 5. 明确不照搬清单

| 阿福能力（分级） | 不采用原因【我方设计】 |
|---|---|
| 硬件生态【静态证据】 | 健康垂类专属；我们的数据护城河是行情库+Brooks 结构引擎 |
| 数字人视频【静态证据】 | 重投入、与交易决策场景价值不匹配 |
| USEDOM/UI 自动化【静态证据】 | 无 App 内操作诉求；"帮我做事"由研究管线阶段承担 |
| 端侧 LLM【静态证据】 | App 场景专属；web 架构下 lite 云模型可覆盖同等分工（经评测验证） |
| gRPC 长连接【静态证据】 | SSE+pg-boss 已满足规模 |
| 语音通话/TTS 时间轴【静态证据】 | 交易研究高频看图场景语音价值低；远期可选 |
| 纯 LLM agent 决策【架构推断】 | 我们选择"数值代码算、LLM 只归纳"的纪律——这是**我方设计立场**（金融数字幻觉风险高），不声称与阿福生产系统比较优劣 |

---

## 6. 落地路线图（文件级 + 分步实施 + 可勾选验收）

> **v2 排序原则**：直接决定垂类回答质量与复现性的闭环进 P0；管理与展示能力进 P1；卡片配置/多模态/分享/主动跟进/模型分工进 P2（模型分工须评测验证）。
> 依赖：P0-1（评测）约束 P0-3/P0-6 与 P1-2 的效果验证；P0-2（可信入口）是 P1-2/P1-3 的地基；P0-6（提示词冻结）先于任何提示词改动；P1-1（场景）先于 P1-3/P1-8。
> 执行任何项前先读 §0.1 红线与 §3.2 对应详注。涉及前端的项先按 §3.2.6 确认 Workbench 组件树。

### P0：质量闭环（先于一切管理与展示能力）

#### P0-1 会话评测基线

**背景**：改任何提示词/模型分工前必须先固定基线（v2 新增，审核点 8）。现有 `evalRunner.ts` 只评 RAG（hits/MRR），需扩会话级。
**改动文件**：`server/src/research/evalRunner.ts`（扩展会话评测类型）；`server/data/evals/`（评测集 JSON，新增目录）；`scripts/eval-conversations.ts`（新，可重复执行）；README 评测说明。
**实施步骤**：定义评测集 schema（输入消息+期望路由/期望引用支持/期望降级行为）→ 覆盖六类场景：补问（过期持仓/缺报价）、引用支持（每条声明有对应证据）、过期持仓处理、事件剩余期限语义（触达 vs 高于）、正确降级（修复耗尽/预算不足）、历史回放（同 frozenConfig 重跑一致性）→ 写入首批 ≥30 条评测（含回归保护用例）→ 脚本产出基线报告存 `server/data/evals/baseline-<date>.json`。
**验收清单**：
- [x] `pnpm eval:conversations` 可重复执行并产出结构化报告（通过率/分类指标；`--against` 逐类别回退门禁，exit 1）
- [x] 六类场景每类 ≥5 条用例；评测集入库（`server/data/evals/conversations-baseline.json`，42 条含 reply_assembler 类）
- [x] 基线报告已生成并提交（`server/data/evals/baseline-2026-10-16.json`：31/36，4 个 baselineExpectFail 钉住 P0-3/P0-5 目标行为）；P0-3/P0-5 落地后 41/42 无类别回退

#### P0-2 统一可信回答入口

**背景**：会话回复模板散落硬编码（`conversation.ts:687-699` 与各意图分支），内容来源不受约束。**目标**：所有场景回复经单一组装器，内容只允许来自 {已计算事实, 冻结证据, 配置文案}。
**改动文件**：`server/src/research/runs/replyAssembler.ts`（新）；`conversation.ts`（各意图回复改走组装器）；`conversation.ts`/`stages.ts`（免责拼接点统一，文案先内置常量，P1-8 换配置）。
**实施步骤**：定义 `assembleTrustedReply({scene, facts, evidence, config, disclaimer})` → 迁移现有六类意图回复 → 组装器内强制校验（引用 ID 有效；不允许出现 facts/evidence 之外的数字——复用 `hasFabricatedProb` 思路扩展为数字白名单来源检查）→ 单测覆盖。
**验收清单**：
- [x] 全部意图回复经组装器（`replyAssembler.ts`：system/news×3/concept×2/run_started/draft×3/replay×2 共 12 类模板；conversation.ts 不再有散落模板串）
- [x] 越界拒绝用例被回退安全模板（评测 r2 残留占位 / r3 引用编号越界 / r4 概率红线均降级且不露出异常内容）
- [x] P0-1 评测基线上回归无退化（reply_assembler 类 6/6；ask_completion 等类别持平）

#### P0-3 反证逐条证据绑定

**背景**：§3.2.7-A。**目标**：每条反证理由绑定其自身引用的证据，而非统一前两条。
**改动文件**：`stages.ts`（counter prompt 增加输出格式要求：每行末尾带 `[k]` 证据编号；`parseClaimLines` 扩展解析标记）；`prompts.ts`（模板更新经注册表）；`validator.ts`（新增标记有效性：k ∈ 证据编号集合；保留锚定词项回退）。
**实施步骤**：模板改造（要求 LLM 每行引用 [k]，无合适证据则标 [0]）→ 解析与校验 → 无标记/非法标记时回退策略（锚定词项重叠匹配，仍失败则 evidenceIds=[] 并在 step_detail 标注）→ 评测对比。
**验收清单**：
- [x] 绑定随内容变化（评测 b1：三行绑定集合互不相同；b2 [1][3] 精确绑定）——真实 run 抽样 10 例人工核对待线上 LLM 流量后补
- [x] LLM 未按格式输出时回退路径生效（锚定词项重叠回退；无重叠 → 空绑定+log.warn 标注，不误绑；评测 b3）
- [x] 越界编号丢弃不整体误绑；P0-1 评测"引用支持"3/5 → 5/5（提升）

#### P0-4 知识版本过滤补齐（规则卡/案例 as-of）

**背景**：§3.2.7-C——复现性漏洞。**目标**：run 冻结的知识版本约束全部三层资料。
**改动文件**：`server/src/knowledge/ruleCards.ts`（`publishedRuleCards/publishedCasesForRetrieval` 增加 asOf 参数：按 publishedAt ≤ 知识版本发布时间过滤；若规则卡已带 knowledgeVersion 字段则按其过滤，实施时查表结构二选一并在迁移中补列）；`retrieval.ts:243-264`（透传 run 的 knowledgeVersion）；聊天附答路径同步。
**实施步骤**：确认规则卡/案例的版本关联字段 → as-of 过滤实现 → 检索调试端点展示过滤前后差异 → 回归。
**验收清单**：
- [x] as-of 语义落地（`publishedRuleCards/publishedCasesForRetrieval(asOf)` + retrieval 按知识版本发布时刻自动推导；`p0:db-check` 验证过去时刻 ⊆ 当前）——含真实规则卡/案例数据的重放核对待线上数据积累后补
- [x] search-debug 端点 debug.notes 可见「规则卡/案例 as-of 过滤：…」说明；未指定版本的路径（聊天附答）行为不变（最新语义）

#### P0-5 修复耗尽受控降级

**背景**：§3.2.7-D。**目标**：修复环耗尽不再直接 failed，按产品规则降级发布并显式标注。
**改动文件**：`orchestrator/pipeline.ts:126-135`（耗尽分支改走降级路径）；`stages.ts` validate/publish（degraded 标志与门控：降级发布仅保留代码计算的结构结论与事实行，剔除 LLM 归纳内容；结果 JSON 加 `degraded:true, degradedReasons[]`）；`shared/src/contract/research.ts`（result 契约加字段）；emit `task_degraded(code:repair_exhausted, handling:degraded_publish)`；前端结果卡降级徽章。
**验收清单**：
- [x] 构造 validate 连续拒绝（mock 八阶段 runPipeline）→ published(degraded) 而非 failed；LLM 归纳 counterClaims（origin='llm'）被剔除，仅保留代码计算内容与规则反证（评测 e1/e2/e5）
- [x] 前端降级徽章（ResultCard degraded-tag + degradedReasons 列表）与运行气泡横幅（RunBubble degraded-note，双 UI 模式共用）；SSE 顺序：task_degraded → run_published（pipeline 降级分支先 emit）；浏览器验收待线上
- [x] P0-1 评测"正确降级"类 5/5（基线 3/5）

#### P0-6 提示词注册表与冻结（B 域地基）

**背景**：§3.2.2 + 审核点 2 全部五条约束。**目标**：§4.B 的 P0 部分（编辑页 P1-6）。
**改动文件**：`server/src/models.ts` + `server/drizzle/00XX_prompt_templates.sql`（两张表，指针键 (name,scene) 复合，种子=5 个 published v1 含 query-rewrite）；`server/src/research/prompts.ts`（新：三级回退、无长缓存、冻结记录 {templateId,version,content}）；`stages.ts`（resolveRolePrompt 换链；执行阶段只读 frozenConfig.raw.prompts）；`intent.ts`、`conversation.ts`、`knowledge/queryRewrite.ts`（五处换链）；`conversation_messages.promptRefs` 列；`store.ts`（freezeRunConfig 终解析）；`admin/routes.ts`（五端点）。
**验收清单**：
- [x] `pnpm typecheck` 通过（0 错误）；`p0:db-check`（真实 PG）确认 `frozenConfig.raw.prompts` 含五个模板全文+版本号+templateId
- [x] 执行阶段零指针解析（countercase/retrieve 只读 `frozenConfig.raw.prompts`，frozenPrompt 不查 pointer 表；发布新版本只影响新 run 的冻结）
- [x] published 模板编辑返回 400（updateDraft 先读后写 + WHERE status='draft' 防写穿）；rollback=指针切回且历史版本永久保留可解析
- [x] 清空 pointers 后解析回退工程默认（`p0:db-check` 验证 source=default 不阻塞；恢复后 registry）
- [x] P0-1 基线上无类别回退（评测 --against 全绿）

### P1：场景化与确认上下文

#### P1-1 场景注册表（三维度）

**目标**：§4.A。**改动文件**：`shared/src/contract/research.ts`、`server/src/research/scenes.ts`（新）、`conversation.ts`、`routes.ts`、`models.ts`（sceneCode 列）、Workbench/ResearchPage 场景入口。
**验收清单**：
- [x] 七意图×产品组合全部映射到 TaskScene（`resolveScene`；评测 sc1-sc6 钉住六映射）；sceneCode 记入消息与 run 行（迁移 0020；会话路径服务端推导、直建路径显式携带或按产品推导）
- [x] perp run 仍强制持仓归属校验（sceneCode 不绕过产品契约；routes.ts 创建时归属校验原样）
- [x] `ui` 参数只在前端生效（服务端不读；检索整个 server/src 无 ui 解析）
- [x] 入口卡点击带预设 query+sceneCode 直达研究（双 UI 模式均可用）——Workbench 直建 run 携带 sceneCode；legacy ResearchPage 直建由服务端按产品+引用推导记录；预设问句按场景措辞

#### P1-2 受约束综合解释（第 6 个 LLM 调用点）

**依赖**：P0-2 入口、P0-6 冻结。**目标**：§4.E-2。**改动文件**：`stages.ts`（第 9 阶段 synthesis（countercase 后 validate 前，进修复环）：只引用 claims/fact、适用/失效条件、冻结证据；`runs/synthesis.ts` 句级校验）；预算 6→7（freezeRunConfig：ruleParams.synthesis 未显式关闭且 chat 可用时 +1）；SSE step_detail(kind:synthesis)；结果契约 `result.synthesis` + 前端「回应你的问题」块；synthesis-writer 模板种子（迁移 0021）。**另附语义支持校验（复核缺口②）**：validator 新增 `unsupported_reference`——带引用声明与被引证据正文无内容词项重叠即拒（validate 传入冻结证据文本；主题相关性级，非极性/蕴含判断）。
**验收清单**：
- [x] 综合解释回应用户原问题（评测 sy1-sy5：mock LLM 注入钉住行为），且不含 facts/evidence 之外的数字（句级白名单剔除，sy2）
- [x] LLM 失败时回退模板文案（降级不失败；sy4/sy5）
- [ ] P0-1 基线上"引用支持"与"回答质量"人工评分不劣化（双人抽评 10 例）——**待线上真实流量后人工抽评**（本地 mock 已钉住校验行为）

#### P1-3 结构化追问推荐

**依赖**：P1-1 场景。**目标**：§4.F-1。**改动文件**：`stages.ts` publish 按 scene 生成 FollowUpAction 对象集（`scenes.ts buildFollowUpActions`，prerequisites 服务端门控）、`shared/src/contract/research.ts`（FollowUpActionSchema + result.followUpActions）、WorkbenchPage 分发器（open_evidence 开抽屉 / rerun_with 换周期建 run / switch_context 开持仓确认 / counter_search 定向新研究）+ ResultCard chips。
**验收清单**：
- [x] "查看证据"打开 sourceRun 的证据抽屉，不触发新研究；"换周期重跑"以原 context 建 run（Workbench 分发器）
- [x] 数据/工具未就绪的动作不返回（counter_search 需 search 能力；open_rule_card 需规则卡证据；switch_context 需持仓过期——服务端门控后才进结果）
- [x] event 场景建议文案区分"触达执行价"与"到期高于执行价"（scenes.ts eventDirectionSemantics，当前产品契约只研究 above 结算语义）
- [x] 动作文案不含结果之外的数字（确定性模板常量，无插值数字）

#### P1-4 已确认画像与 Context Card

**目标**：§4.D。**改动文件**：`models.ts`（trader_profiles 独立 PG 表，迁移 0022）、`research/profile.ts`（load/save/traderProfileLine）、GET/PATCH `/api/users/me/profile` + admin 代改、`store.ts`（freezeRunConfig 画像快照进 raw.traderProfile）、`prompts.ts`（{{traderProfile}} renderPrompt）、`web/src/research/ContextCard.tsx`（新，三态+有效期徽章+画像快捷编辑）、WorkbenchPage 常驻。
**验收清单**：
- [x] 三层上下文在请求快照中可见（第一层 raw.traderProfile 冻结快照；第二层持仓 confirmedAt/isStale 既有；第三层会话 context 既有）
- [x] 过期持仓触发补问（task_degraded(data_stale)→ask_user，product_analysis 发射）而非静默使用
- [x] leverageHabitMax 界面标注"历史习惯（描述性）"，不作为授权上限（ContextCard 文案 + profile.ts 注释 + 契约注释）
- [x] 画像变更后历史 run 冻结快照不变（创建时快照语义）

#### P1-5 记忆收编（第一步）

**目标**：从 `aiMemory.ts` 抽纯 PG 记忆模块进链路 B。**改动文件**：`server/src/research/memory.ts`（新：纯 PG research_memories（迁移 0023），无 JSON 镜像；6 条节流/40 上限；memory-extraction 模板入注册表种子）、`runner.ts`（run 发布后 fire-and-forget 提取）+ `conversation.ts`（concept/news 附答后同触发）、synthesis 提示词 `{{memory}}` ≤400 字注入。
**验收清单**：
- [x] 新记忆出现在后续 run 提示词 {{memory}}（代码链路：memoryBlock→synthesis renderPrompt）；ai-memories.json 不再被写（链路 B 不触碰 aiMemory；链路 A 文件待 P2-1 退役）——**线上真实提取流量观察待补**
- [x] 提取失败不影响会话主流程（fire-and-forget 全 catch）；P0-1 基线无退化（--against 全绿）

#### P1-6 admin 提示词编辑页

**依赖**：P0-6。**改动文件**：`web/src/admin/AdminPromptsPage.tsx`（新：列表/草稿编辑/占位符文档/发布确认/回滚/LCS 行级 diff/场景作用域选择 + 免责三段与 chat_input_config 管理）、`admin/index.tsx` 路由 + `menu.tsx` 入口。
**验收清单**：
- [x] 编辑→发布→run 用新文（查 frozenConfig）→回滚→旧文（P0-6 e2e 已实证该生命周期，v2.2 记录；页面复用同一五端点）
- [x] 场景作用域模板互不干扰（(name,scene) 复合指针键）；diff 正确（LCS 行级，+/- 着色）
- [x] 页面在 admin chunk 内（admin 子应用整体 lazy，页面直接 import 进 admin chunk）

#### P1-7 过程事件展示（step_detail / task_degraded / security_interrupt）

**目标**：§4.C。**改动文件**：`stages.ts`（emitDetail 发射点：检索变体/证据冻结/结构声明/反证 LLM/综合；validate 的 version_mismatch 先 security_interrupt；过期持仓 task_degraded ask_user）、`useResearchRun.ts`（details/securityInterrupt 状态 + listener）、`RunBubble.tsx`（子步骤行 + 安全横幅 + 场景徽章）。
**验收清单**：
- [x] 反证/检索/证据冻结/结构声明/综合解释的子步骤行可见（真实状态与计数；界面文案无"思维链"字样）——**浏览器端实测待线上 rebuild 后补**
- [x] version_mismatch 先 security_interrupt 再终态（validate 发射后抛 ValidationRejected）；数据过期走 task_degraded 并按 handling 呈现（ask_user 补问横幅/P0-5 降级徽章）
- [x] 断线重连重放含新事件（run_events 落库 + 游标重放机制复用）；旧前端忽略不报错（新 prop 全 optional + 未注册 listener 天然忽略）；payload 无正文（emitDetail 只带 kind/label/status/count）

#### P1-8 免责配置与输入面板配置化

**目标**：§4.H-1 + §4.I-3。**改动文件**：`app_settings` 两键（research_disclaimers 三段/chat_input_config 按场景，`admin/settingsStore.ts`）、`admin/routes.ts`（GET/PUT+audit）、`replyAssembler.ts`（disclaimer 参数拼接）、`conversation.ts`（run_started 按产品追加）、`GET /api/config/research-ui`、WorkbenchPage（占位/建议条数渲染回退）、ResultCard（免责行，服务端下发）、AdminPromptsPage（配置管理段）。
**验收清单**：
- [x] 免责文案修改即时生效（不重启；无缓存直读 app_settings）；占位文案/建议条数按配置渲染，缺失回退内置默认——**动作型快捷按钮待 P2 工具注册表（G 域）一并落地**
- [x] 非法 JSON 拒绝（validateChatInputConfig/免责长度上限）；修改入审计

### P2：扩展能力（多数需前置条件验证）

#### P2-1 旧链路退役（第二步）

**依赖**：P1-5。**改动文件**：删 `POST /api/ai/chat`、`/api/ai/command`（`index.ts:720-773,783`）与 `ai.ts` 档案逻辑；ai_chats/ai_memories 历史转只读（AiInsightsPage 保留）；ai-config.json 迁移说明入 admin 手册；chatPolicy 头注释更新口径。
**验收清单**：
- [ ] 前端全功能回归，网络面板无 /api/ai/chat 调用
- [ ] admin 全景页可看历史（只读）；限额口径单一化说明更新

#### P2-2 结果卡 schema 化（数据来源锁定版）

**目标**：§4.I-2。**改动文件**：`shared/src/contract/research.ts`（CardBlock：块引用字段/事实 ID，不携带自由数值；confidence 块必须带统计来源标记）、`stages.ts`（publish 产 schema）、Workbench/ResearchPage 结果组件（schema 渲染器+回退）。
**验收清单**：
- [ ] schema 渲染与现有卡信息等价（3 个 run 对照）；数值全部来自 result 数据（schema 中无自由数字）
- [ ] 无统计来源时显示"暂无校准置信度"；新增块类型需前端支持的边界在文档注明

#### P2-3 模型分工（chatLite，经评测验证）

**前置**：P0-1 评测证明 lite 在路由/短生成任务上质量不降。**目标**：§4.J。**改动文件**：`shared/src/contract/admin.ts`、`capabilities.ts`、`llm.ts`、`intent.ts`、`conversation.ts`（标题）、AdminAgentsPage。
**验收清单**：
- [ ] 评测报告：意图分类准确率与主模型持平（±2pp 内）、成本对比数据
- [ ] 未配置回退 chat；标题生成失败静默降级

#### P2-4 行情截图多模态

**目标**：§4.I-4。**改动文件**：`AiChat.tsx`/Workbench 输入（上传）、附件端点（vision 固定指令：识别 symbol/周期/文字，禁出价格）、screenshot_context 确认卡、`conversation.ts`。
**验收清单**：
- [ ] 识别→确认→context 生效链路；任何价格数字可溯源行情库（截图数值不进管线）
- [ ] vision 未配置时入口隐藏

#### P2-5 分享链接（字段投影+撤销）

**目标**：§4.I-5。**改动文件**：`models.ts`（share_tokens：token 哈希/runId/字段投影/有效期/revokedAt）、`routes.ts`（生成+只读访问）、公开只读页（复用 schema 渲染器）。
**验收清单**：
- [ ] 默认投影排除画像/持仓/未发布内容；撤销后 token 立即失效（403）
- [ ] 未登录可看冻结结论+证据；数据全部来自冻结快照

#### P2-6 静默跟进

**目标**：§4.E-4。**改动文件**：`jobs.ts`（event:settle 扩展）、结构破坏判定、`models.ts`（follow_up_suggestions）、Workbench 提示条。
**验收清单**：
- [ ] 构造破坏场景后 24h 内写入建议；每个关键位去重；seen 后不再显示；无外部推送

#### P2-7 工具注册表（MCP 前置）

**目标**：§4.G。**改动文件**：`server/src/tools/registry.ts`（新）、各服务导出函数、`conversation.ts` 附答改走 registry、AdminAgentsPage 工具开关。
**验收清单**：
- [ ] concept/news 附答行为等价（3 条历史问题对比）；关闭工具后降级+日志
- [ ] 每工具 input/output zod 校验；后续 MCP 适配器只需包一层

---

## 7. 附录：阿福证据索引

| 结论 | 证据分级 | 证据（类/方法/字段） | 产物文件 |
|---|---|---|---|
| preAgentId 矩阵与路由 | 静态证据 | 内置首页配置 JSON（AI诊室/报告解读 bizType=1/拍皮肤 bizType=3/AI挂号/找医生/专家问诊/购药/药管家） | dex_strings_cn.txt |
| 薄接口+extParams | 静态证据 | `ChatAnswerQueryReqPB {sessionId, sceneCode, queryId, extParams}` | /tmp/afu-apk（field 表扫描） |
| 请求参数表 | 静态证据 | `XUIClient.startGrpcRequest`（cityCode/…/elderCare/privateMode+userPrivatePreference/customChatMode/queryFrom/chatBizVersion/rewriteChatId/first_query/afu_2.0/feedbackVersion/guestExpeTag/oaid） | mth_xui_start.json |
| 四通道+分级超时 | 静态证据 | `XUIClient.doSendByGrpc`（4×MutableSharedFlow；ChatWatcher 5000/30000ms） | mth_xui_send.json |
| 消息子类型 17 种 | 静态证据 | `XUITextInfo$SubType`（INPUT_TEXT/IMG/PDF/USEDOM；DISPLAY_MARKDOWN/A2UI/XUIHTML/XUIHTMLUPDATE/XUISCHEMA；SECURITY_INTERRUPT/SECURITY_TERMINATE；AUDIO_ASR/TTS；BIZ_STREAMTEXT） | DEX field 表 |
| cot/cotStep 字段 | 静态证据（内容生成方式未知） | `ChatContentVOPB {cot, cotStep, delta, tool, ref, subList, feedbackData, status}` | 同上 |
| 引用模型 | 静态证据 | `ChatCitationVOPB {title,url,summary,channel,doc,icon,publishTime}` | 同上 |
| HealthArchive | 静态证据 | `input/impl/HealthArchive/HealthConsumer/HealthItemData` 字段集（含 private/switch/unfilled 三态资源 URL） | 同上 |
| 输入面板配置驱动 | 静态证据 | `InputDATA/ImageUploadConfig/InputPlaceholderItem` 字段集 | 同上 |
| 追问推荐 | 静态证据 | `ChatQueryRecReqPB`、`LlmAppChatSugRecRpc`、`RpcRequestClient.querysugRec/requestSugTexts` | cls_RpcRequestClient.json |
| 语音 Agent | 静态证据 | `VoiceAgentStartRequestPB`（avatar/voice/rate/volume/scene/geo）、`TtsTimeLinePB` | 同上 |
| MCP 运行时 | 静态证据 | MiniUse agent.min.js `mcpServerToolsMap/executeMCP/mcpServerConfig/mcpServerToolsDisabledBySwitchMap` | /tmp/afu-h5/nb1 |
| UI 自动化 | 静态证据 | `XUIMCPAbilityImpl`、AlipayUse、AGENT_STATUS_* | dex_strings_cn.txt |
| 端侧 LLM | 静态证据 | `llm_init_tokenizer/xnn_compile_kernel/loraid/llm_sensitive_event` | 同上 |
| 传输层与死代码 | 静态证据 | `streamingrpc`；AQGrpcWorker(接口)→XUIClient(实现)；cognicore ChatRpcFacade 引用 total=0 | cls_*.json、ref_*.json |
| 静默追问 | 静态证据 | `sendAIRoomSilenceQuery`（触发策略未知） | class_inventory.txt |
| 硬件 | 静态证据 | microtechcgm(197类)/yuwellcgm/wellandbodyfatscale/bravechipring/AIJKCGMHomeWidgetProvider；291 权限 | class_inventory.txt、AndroidManifest_decoded.xml |

**逆向环境备忘**：OpenJDK 17（brew openjdk@17）+ jadx-headless-mcp 0.7.1（`~/.rea/`，sha256 6e5eacf5…）；MCP 工具需 ZCode 重启后才可见，当前用 CLI：`JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home REA_JADX_MCP_JAR=~/.rea/jadx-headless-mcp-0.7.1-all.jar rea inspect-android-method <apk> <class> <method> --format json`。

---

## 8. 修订记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v2.7 | 2026-10-19 | **P1 八项全部落地（复核三缺口闭环 + 执行中断恢复）**：①P1-1 场景注册表——TaskScene 六值契约 + `scenes.ts`（resolveScene/defaultSceneForProduct/buildFollowUpActions）+ scene_code 落 conversation_messages/research_runs（迁移 0020）；②P1-2 受约束综合解释——**第 9 阶段 synthesis**（countercase 后 validate 前进修复环；`runs/synthesis.ts` 句级校验：[k] 有效性+锚定支持+数字白名单+概率红线，失败回退代码装配模板）；预算 6→7（synthesis 未显式关闭且 chat 可用时）；result.synthesis + 前端「回应你的问题」块；synthesis-writer 种子（0021）；③**语义支持校验（复核缺口②）**——validator 新增 `unsupported_reference`：带引用声明与被引证据正文无内容词项重叠即拒（主题相关性级，极性/蕴含边界如实声明）；④P1-3 结构化追问——result.followUpActions（场景确定性模板 + search 能力/规则卡证据/持仓过期服务端门控）+ Workbench 分发器 + ResultCard chips；⑤P1-4 画像——trader_profiles（0022）+ profile 端点 + freezeRunConfig 画像快照 + {{traderProfile}} + ContextCard 三态/有效期徽章/画像快捷编辑 + 过期持仓 task_degraded(ask_user)；⑥P1-5 记忆收编——research_memories 纯 PG（0023）+ memory.ts（6 条节流/40 上限/memory-extraction 种子）+ run 发布与附答后 fire-and-forget 提取 + {{memory}}≤400 字；⑦P1-6 AdminPromptsPage（列表/草稿/发布/回滚/LCS diff/场景作用域/占位符文档 + 免责与输入配置管理）；⑧P1-7 过程事件——step_detail 发射（检索变体/证据冻结/结构声明/反证/综合）+ version_mismatch→security_interrupt 先于终态 + RunBubble 子步骤行/安全横幅/场景徽章；⑨P1-8 免责+输入配置——app_settings 两键 + settingsStore + admin 端点 + run_started 按产品追加 + /api/config/research-ui + 前端渲染回退。**执行事故与恢复**：落地中途遭另一并行会话同仓库同方案互踩（已跟踪文件被外部 git restore 回滚、产物被归档），对方完成后重放全部编辑并恢复模块；期间先落盘对方完成的「研究终端缺输入引导」成果（3c44ec0）避免二次冲突。**两个附带 bug 修复**：f6 评测用例 requires:'db' 未先 initDb（复核指出的脚本自身 bug——现在主流程先 initDb，失败转 skip）；freezeRunConfig 冷缓存陷阱——getCapabilities() 首调同步返回全关默认并异步刷新，新进程第一个 run 会冻结错误能力快照（f6 修复后实证暴露；现在冻结前显式 refreshCapabilities）。**验证终态**：typecheck 0；p1-check 134/0、calc 42/0、policy 14/0、quote-guide:selftest 全过、db-check 24/0（扩 P1 四断言）、评测 **67/67**（新基线 baseline-2026-10-19：semantic_support 10 + synthesis 5 新类；--against 2026-10-16 基线无类别回退）；生产构建过。遗留待线上：synthesis 真实 LLM 抽评 10 例、记忆提取真实流量、浏览器端 step_detail 实测、容器 rebuild。 |
| v2.6 | 2026-10-19 | **二轮外部审查 3 处缺口修复（真实数据复现验证）**：①历史快照在最终组装被丢弃——召回层 as-of 快照改为 Map 直传最终组装，删除 getRuleCard/getCaseWindow 的当前状态回查（旧卡归档/案例下架后历史候选不再消失；真实复现：v1 归档+v2 发布后 as-of 检索端到端仍取回 v1 历史内容）；②发布历史未还原时点有效集合——规则卡 as-of 改按 **concept** 取「asOf 前最后一次发布」的生效版本（同概念新版是新行新 id，按 ref_id 去重会同时返回新旧两版，复现「同概念 2 条」已修）；迁移 0019 加 event_type 列，案例取消发布记 unpublish 事件，as-of 按「每 ref 最后一条事件」判断有效性（复现：下架前可见/下架后不可见双时点重放）；③新闻数字白名单与模型所见正文不一致——evidenceTexts 改为发送给模型的同一份 block 文本（标题+URL+pageText 前 500 字），复现「正文含『净流入 500 万』而 snippet 无数字时正确回答被误删」已修（评测 r11 钉住）。p0:db-check 扩至 20 断言（概念生效版本/归档端到端/下架事件重放三钉，自建自清）。注意：词项提取截断 >20 字符 token，测试用概念名不得带长数字后缀。终态：typecheck 0、p1 134/0、calc 42/0、policy 14/0、db-check 20/0、评测 51/52（1 skip）。 |
| v2.5 | 2026-10-19 | **外部审查 5 处缺陷全部修复（真实数据复现验证）**：①降级发布绕过硬校验——修复环耗尽不再无条件降级：剔除 LLM 反证后**重跑完整真实校验**，仍拒绝（数值伪造/version_mismatch/行情质量门控/决策完整性/事件动作违规等硬红线）→ `validation_blocked` 阻断 failed，不再带病发布决策与概率（真实 DB 注入复现：篡改 frozen_config → failed validation_blocked，修正前为降级发布）；②降级状态断点恢复丢失——降级收尾从无检查点的 stepCompleted 改为 completeStage（检查点+步骤状态+续租同一事务），`degradedPublish` 纳入 runCheckpointOf 与 runner 恢复字段，崩溃恢复后 publish 仍按降级门控幂等装配（评测 e6 钉住）；③数字白名单跳过 llmText——组装器新增 evidenceTexts（证据正文数字入白名单）+ llmText 句级过滤（[k] 标记先剥离；白名单外数字句剔除，全部违例回退 llmFallback），用户复现句「BTC 当前价格是 999999 美元，可以加 100 倍杠杆」被剔除且证据数字句保留（r9/r10 钉住）；④as-of 过滤不保证历史复现——新增迁移 0018 knowledge_publications（append-only 发布历史，规则卡发布快照 concept+content，案例发布记 ref），as-of 检索按「每个 ref 在 asOf 前最后一次发布」重放，与当前状态（归档/下架/新版覆盖）解耦（真实复现：v1 发布→v2 发布归档 v1→as-of(v1 时刻) 仍重放 v1 内容快照，修正前查不到）；⑤显式 [0] 补绑——模型明确「无合适证据」时保持空绑定，禁止词项重叠补绑（不再计入有效反证数量，评测 b8 钉住）。**重要环境发现**：docker 旧容器 worker（旧镜像）与 dev worker 共享 PG 队列抢任务——旧镜像 SECRETS 路径 bug 致其执行的反证 LLM 调用 401、且无 stripCiteMarkers（此前误判为「代理间歇 401」实为双 worker 竞争；线上 rebuild 前需注意 dev 验证会被旧 worker 污染，验证时可临时 docker stop biance-vision-worker）。评测 47→51 条（e1 语义更新为阻断、新增 e6/b8/r9/r10）。终态：typecheck 0、p1 134/0、calc 42/0、policy 14/0、db-check 14/0、评测 50/51（1 skip）。 |
| v2.4 | 2026-10-19 | **统一验收五项全部完成（真实数据）**：①P0-5 降级双实锤——注入式（运行中 UPDATE frozen_config.budgets.maxLlmCalls 模拟配置篡改 → validate version_mismatch → 修复环耗尽 → task_degraded 事件(repair_exhausted/degraded_publish) → published(degraded) 且 LLM 反证 0 条残留）+ 自然式（SOL run LLM 反证写「80% 规则族」被 fabricated_number 拒绝 → 降级发布）；②P0-3 抽样 23 run（80 条反证声明，LLM 11 条全绑定零空绑，AVAX/ARB 逐条核对声明↔知识块内容相关性成立）——发现并修复标记+句读缺口：LLM 在行尾标记后补句号（「…[1][3]。」）时 stripCiteMarkers 不剥离且 cited 精确绑定退化为锚定回退，修复后标记照常剥离、原句标点保留净文本、cited 绑定恢复（评测 b7 钉住）；③P0-4 版本重放差分实锤——发布钉 kv-20261009-01 的 agent 版本，run 证据 doc_version_id 全部命中 #1 不可变版本，对照默认 run 命中 #2（同文档 v1/v2 差分），测试版本与指针已清理；④浏览器 UI 端到端（dev/legacy 双模式）：降级徽章+原因列表+修复环二轮步骤渲染、SSE 实时推进、八阶段结果卡/引用/条件情景/盈亏矩阵、legacy 完整兼容——**发现并修复第 5 个 bug：默认运行时长预算 60s 太紧**（快照+嵌入检索波动+LLM 反证 ~16s 常态 40-60s 偶发超限被误杀 failed，浏览器首跑即触发），DEFAULT_RUN_BUDGETS.maxRuntimeMs 60s→180s（租约每步续期 +120s 无接管风险，单次 LLM 另有 90s 硬顶），修复后浏览器重跑 published；⑤LLM 代理 内部 LLM 代理 存在间歇性 401（同配置直连随后即 200，非我方代码问题）——401 时「保留规则反证」兜底真实生效，23 run 无一 failed。终态：typecheck 0、p1-check 134/0、calc 42/0、policy 14/0、db-check 14/0、评测 46/47（1 skip DB e2e）。遗留：线上容器 rebuild 待用户确认时机。 |
| v1 | 2026-10-16 | 初版：三轮逆向结论 + 十大域 + P0(5)/P1(6)/P2(4) 路线图 |
| v2.3 | 2026-10-19 | **真实 LLM 链路端到端验证**（接入 dev 既有代理 内部 LLM 代理 / zhiman38_27b，key 经 server/data/secrets.json 引用）：意图纠偏真实生效（「我的多单止损放哪」structure→perp，日志可证）；反证 LLM 逐行 [k] 标记真实输出且各行绑定集合不同（P0-3 目标行为实证，对照基线统一前两条）；concept LLM 解释复述资料统计数字被概率红线拦截→回退资料原文（红线 #1 设计内行为）；五模板全部经注册表解析并冻结（promptRefs v1 + frozen 全文）。**发现并修复第 4 个 bug（既有代码）**：capabilities.ts SECRETS_FILE 路径少一层（指向 server/src/data/，secrets.json 从未被读到——embedding/rerank 免 key 才未暴露），修正为 server/data/secrets.json 并入 p0:db-check 断言；另修「无可用反证输出：无。」整行被当声明入库的格式边缘（评测 b6 钉住）。query-rewrite 变体：模板冻结+调用点接线就绪，retrieval.variants 未配置默认关（发布 agent 配置后启用）。chat 能力已在本地 dev 库启用（app_settings，secrets.json 不入库）。 |
| v2.2 | 2026-10-16 | **本地真实数据端到端验证**（PORT=3201 新代码 server+worker，真实 PG/行情流/知识库/账号）：用户侧（结构研究 run 全链路发布、concept 附答、news 降级、replay 补问、持仓草稿→确认卡→PATCH 落库、frozenConfig.raw.prompts 五模板冻结、promptRefs 落库）与 admin 侧（prompts 五端点全流程：草稿→编辑→published 不可编辑 400→发布指针切换→新 run 冻结 v2 新文→rollback→新 run 冻结 v1）。**e2e 发现并修复 3 个 bug**：concept 资料摘录误走 llmText 触发概率红线致空回复（改走 sections 证据豁免通道+组装器空兜底，评测 r7/r8 钉住）；prompts publish 归档旧版本与 rollback 死锁（publish 不再归档、rollback 兼容 retired，对齐 agentVersions 生命周期）；「为什么大跌/大涨」补入 news 正则（评测 a9 钉住）。chat 能力本地未配置：反证 LLM/[k] 绑定与 intent 纠偏的真实触发留线上。 |
| v2.1 | 2026-10-16 | **P0 六项落地**（分支 codex/dev-agent-workbench）：评测基线 42 例（`pnpm eval:conversations`，--against 门禁）；知识三层 as-of 补齐（迁移 0016）；提示词注册表+冻结（迁移 0017 五种子，`prompts.ts` 三级回退，五处 LLM 调用点换链，admin /api/admin/prompts 五端点，conversation_messages.promptRefs）；反证逐条 [k] 绑定+锚定回退；统一可信回答组装器（replyAssembler 12 模板+数字白名单/引用/概率校验）；修复耗尽受控降级（RUN_PROGRESS_TYPES 扩 step_detail/security_interrupt/task_degraded，pipeline 降级路径，degraded 发布门控，前端徽章/横幅）。验证：typecheck 0 错；p1-check 134/0、calc-check 42/0、policy-check 14/0；评测 41/42（1 skip DB e2e）对比基线无回退；`p0:db-check` 真实 PG 13/0。线上容器需 rebuild 后生效。
| v2 | 2026-10-16 | 用户审核修订（8 点全部采纳）：①质量闭环四缺口+统一可信入口+评测基线进 P0；②提示词注册表五条严苛化（执行期只读冻结/queryRewrite 纳入迁移/指针键复合场景/不可变与生效分离/不做长缓存）+反证轮次语义修正；③场景拆产品/任务/界面三维度+补场景注册表路线图任务；④追问推荐改结构化动作（action+sourceRunId+parameters+prerequisites，触达/高于语义区分）；⑤画像三层化+元数据四件套+leverageHabitMax 描述性定位+独立 PG 表（users.ts JSON 镜像模式弃用）；⑥过程事件与安全事件二分（security_interrupt 仅硬中断/task_degraded 任务降级）+敏感检测处置边界与类目收敛；⑦卡片配置后移+数据来源锁定+分享字段投影与撤销；⑧评测先行（chatLite 后移 P2 待验证）+前端落点更新 WorkbenchPage 体系+阿福结论按静态证据/架构推断/我方设计三级标注。路线图重排为 P0(6)/P1(8)/P2(7)。 |
