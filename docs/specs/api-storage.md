# API 与存储

> 状态：partial

> 五轮复审修复（2026-10-14）：确认指纹与持仓编辑的交叉一致性——`PUT /api/portfolio/:id` 改变身份字段（symbol/side/qty/entryPrice/leverage/riskBudget）时清除 `confirm_fp`（编辑即改变持仓身份）；会话确认冲突路径在刷新 confirmedAt 前核对指纹锚定记录的实际字段，不一致则清除其旧指纹并按草稿新建（修复前：编辑过的记录会被旧指纹误锚定，确认草稿可能返回并刷新一条内容已不同的持仓）。集成锚点：`pnpm linkage:smoke` §3b（编辑后同草稿再确认 → 新建持仓、被编辑记录保持编辑内容且指纹清除）。

> 四轮复审修复（2026-10-14）：(1) 时刻解析不再截断表达——「10点半」=10:30、「10点30秒」=10:00:30（秒位不再误读为分）、「10点30分25秒」支持秒。(2) 确认幂等与重确认语义分离：同指纹确认走 `onConflictDoNothing + 回读`，且**刷新 confirmedAt**——重复提交/重试幂等返回同一持仓（不重复建仓），间隔很久的重确认解除过期标记（修复前被指纹快路径当作旧重试跳过，持仓永久过期）。集成锚点：`pnpm linkage:smoke` §3b（同指纹仅一条持仓 + confirmedAt 刷新）。

> 复审修复（2026-10-13，R2/R3/R5）：(R2) 会话写操作并发幂等——postMessage/patchContext 经 `serializeConversation` 按会话串行（先查后写的窗口去重在串行下闭合）；`portfolio_positions` 新增 `confirm_fp` 列 + (user_id, confirm_fp) 部分唯一索引（迁移 0014），确认写入带指纹、23505 冲突回读已落库持仓——并发确认/双击/重试不重复建仓。(R3) 复盘时刻解析：`parseReplayAsOf` 支持「10:00 / 10点30分」（UTC+8 精确到该时刻），非法/未来时刻 invalid，仅日期保持当日 23:59:59 约定。(R5) 快照降级显式化：`useResearchCandles` 返回 source/fallbackReason，冻结视图下输入包不可读时页面显示「非原始输入、不可复现」警告，不再静默换数据源；确认卡「取消」同步清除服务端待补齐草稿（PATCH draft:null）。回归锚点：`pnpm linkage:smoke`、`pnpm research:smoke` 全绿。

> 评审修复（2026-10-13，F3/F6/F10）：(F3) 资金费率 `listFunding` 增加 `asOf` 过滤（历史复盘不泄漏未来费率）；product_analysis 统一消费快照冻结 funding（类型/水化/装载贯通），旧快照缺 funding 时按 asOf 补读；新增 `GET /api/research/runs/:id/candles?interval=&priceType=`——结果图表读冻结输入包（无包返回 snapshot:false，前端回退实时库）。(F6) 会话持仓草稿闭环：待确认草稿持久化于会话上下文，后续消息槽位合并补齐；确认写入改走共享 `PositionInputSchema`（非法方向/非正数量/越界杠杆 400）；确认幂等（草稿指纹重复确认返回已落库持仓，不重复建仓）；会话消息 10s 同内容窗口去重。(F10) `run_events` 持久化按 run 串行化（消除 SELECT max(seq)+1 竞争；主键 (run_id,seq) 冲突重试一次），终态清理串行链；事件仍先落库拿 seq 再推送。回归锚点：`scripts/p1-regression-check.ts` [评审 F6/F7]、`pnpm linkage:smoke`、`pnpm research:smoke`。

> 修复（2026-10-19，快照双后端分裂）：本地源码进程此前不加载任何 .env，BlobStore 静默落本地磁盘，与容器（MinIO env）形成双后端——容器 worker 写 MinIO、本地 API 读磁盘，图表报「快照不可复现」。修复：入口首位 `import './env.js'` 加载 `server/.env`（不覆盖已有环境变量），启动日志/`/api/health` 暴露 `blobStore` 后端类型；`GET /api/research/runs/:id/candles` 响应新增 `reason`（`ok/no_snapshot/no_row/no_key/blob_missing/hash_mismatch/no_interval`），前端按原因展示回退文案；`loadSnapshotPack` 对「有 key 读不到/哈希不匹配」打 warn。历史磁盘数据用 `pnpm blobs:migrate` 幂等迁入 MinIO。

> 修复验收（2026-10-09 八轮）：(B2/B3) 研究发布门禁落地——validate 阶段重新 `freezeRunConfig()` 比对 configHash（不一致 → `version_mismatch` 拒绝发布），publish 阶段结果装配后经 `ResearchResultV2Schema` 运行时校验（非法结构 → ValidationRejected，不发布）。(D1) `PUT /api/admin/evaluations/datasets/:id` 落地：原地改名或整体替换 items（itemCount 同步），version 不变——版本递增语义仍由 POST 同名新建承担。新增端点见下表（`/api/predictions/stats`、`/api/event-quotes/:id/confirm`）。

> 实现状态（2026-10-01）：端点清单全部落地——/api/market/*、/api/admin/knowledge/*、/api/research/runs*（含 SSE 与 /evidence）、/api/portfolio、/api/event-quotes、/api/predictions*、/api/admin/agents|evaluations|models*（含训练触发）。迁移 0007（知识）/0008（研究）/0009（Agent 版本与评测）已产出并自动执行。

## 目标

定义新 API 族的端点清单与 SSE 事件协议、共享 zod schema 约定、PostgreSQL 实体清单、迁移策略与降级行为。新业务数据以 PostgreSQL 为唯一权威，不延续旧模块的 JSON 双写；数据库不可用时停止新增研究与发布，界面显示实际可用状态。

## 已确定决策

- 请求/响应契约统一放在 `shared/src/contract/`，以 zod schema 表达，server 与 web 同源引用，禁止前后端各自手写类型漂移。
- 保留现有接口兼容：`/api/ai/chat`、`/api/ai/conversations*`（历史消息读取）、`/api/tickers`、`/api/klines`、`/api/alerts*` 等对外契约不变。
- 鉴权沿用现有会话机制：用户接口需登录；`/api/admin/*` 需 superadmin（沿用现有守卫模式）。
- 迁移策略：`drizzle-kit generate` 生成迁移，应用启动时自动执行（沿用现有模式）。
- 数据库不可用：创建研究运行、发布知识/配置等写操作返回 503 且体含 `storage: unavailable`；界面降级为只读并显示实际状态（见 docs/specs/ui.md）。
- pg-boss 使用自己的 schema（`QUEUE_SCHEMA`），与业务表隔离。

## 数据与接口

### 新 API 族端点清单

鉴权列：user=登录用户，admin=superadmin。

| 方法 | 路径 | 要点 | 鉴权 |
| --- | --- | --- | --- |
| GET | `/api/market/symbols?marketType=` | 交易对列表（spot/usdm_perp 分别返回） | user |
| GET | `/api/market/candles?marketType&priceType&symbol&interval&from&to&asOf` | K 线查询；带 `asOf` 时只返回当时已收盘数据 | user |
| GET | `/api/market/snapshot?symbol&marketType&asOf` | 各周期 `closeTime<=asOf` 的最后收盘集合 → `snapshotId` | user |
| GET | `/api/market/funding?symbol` | 资金费率序列（永续） | user |
| GET | `/api/market/open-interest?symbol` | 持仓量序列（永续） | user |
| GET | `/api/market/quality` | 缺口/延迟/修订统计 | user |
| POST | `/api/research/runs` | 创建研究运行，立即返回 `runId` | user |
| GET | `/api/research/runs`、`GET /api/research/runs/:id` | 列表 / 详情 | user |
| POST | `/api/research/runs/:id/cancel` | 取消；此后不再写入后续步骤 | user |
| GET | `/api/research/runs/:id/events` | SSE 进度事件流 + 校验后最终结果 | user |
| GET | `/api/research/runs/:id/result` | 校验后的最终结果（区分 `product: perp\|event`） | user |
| GET/POST | `/api/portfolio` | 持仓列表 / 录入；含 `confirmedAt/staleAfter` 用户确认语义 | user |
| PUT/DELETE | `/api/portfolio/:id` | 修改（重新确认）/ 删除 | user |
| GET/POST | `/api/event-quotes` | 事件报价列表 / 手动录入；`stake` 与 `totalPayout` 分列 | user |
| PUT/DELETE | `/api/event-quotes/:id` | 修改 / 删除 | user |
| GET | `/api/predictions?quoteId=` | 预测记录查询 | user |
| GET | `/api/predictions/stats` | 命中率统计：`estimated` 与 `userConfirmed` 两轨分列（count/hits/hitRate，空轨 hitRate=null） | user |
| POST | `/api/predictions` | 对冻结报价生成预测（模型未就绪/期限不匹配返回 `unavailable` 及原因） | user |
| POST | `/api/predictions/:id/confirm` | 到期后用户确认真实订单结算（`outcomeSource=user_confirmed`） | user |
| POST | `/api/event-quotes/:id/confirm` | 报价级用户确认：写 `quote.userConfirmedOutcome` 并同步该报价下未确认的预测（不覆盖已有确认） | user |
| GET | `/api/predictions/models` | 模型注册表查询（版本/适用期限/状态） | user |
| POST | `/api/admin/knowledge/documents` | 文件上传（MinIO 预签名或 multipart） | admin |
| POST | `/api/admin/knowledge/documents/import-url` | 单 URL 导入 | admin |
| POST | `/api/admin/knowledge/documents/import-manifest` | 资料清单批量导入 | admin |
| GET | `/api/admin/knowledge/documents`、`GET .../documents/:id/preview` | 列表 / 解析预览 | admin |
| POST | `/api/admin/knowledge/documents/:id/reparse`、`POST .../documents/:id/publish` | 重解析 / 发布（生成不可变 knowledgeVersion） | admin |
| GET | `/api/admin/knowledge/search-debug?query=` | 召回/融合/精排各阶段打点 | admin |
| GET | `/api/admin/knowledge/chunks/:id` | 引用定位原文 | admin |
| GET/POST | `/api/admin/agents/versions` | 版本列表 / 新建草稿 | admin |
| PUT | `/api/admin/agents/versions/:id` | 编辑草稿（已发布版本不可变） | admin |
| POST | `/api/admin/agents/versions/:id/publish`、`POST .../versions/:id/rollback` | 发布 / 回滚 | admin |
| POST | `/api/admin/agents/versions/:id/debug-run` | 调试运行 | admin |
| GET/POST/PUT/DELETE | `/api/admin/evaluations/datasets(/:id)` | 评测数据集 CRUD，版本化（PUT 原地改名/替换 items，version 不变；同名新建=version+1 由 POST 承担） | admin |
| POST | `/api/admin/evaluations/runs` | 触发评测（pg-boss 任务） | admin |
| GET | `/api/admin/evaluations/runs/:id` | 评测报告查询 | admin |

### SSE 事件协议（`/api/research/runs/:id/events`）

标准 SSE（`text/event-stream`，`event:` + `data:` JSON）。每条事件带递增 `id:`（`run_events.seq`）；断线重放：服务端按 `?after=seq` 或浏览器自动重连携带的 `Last-Event-ID` 头从游标续发，不丢事件不重复。事件类型：

| 事件 | 含义 |
| --- | --- |
| `step_started` / `step_completed` | 流水线步骤开始/完成；data 含 `runId、step、耗时、费用` |
| `run_published` | 校验通过，附带最终结果（与 `GET .../result` 一致） |
| `run_failed` | 失败；data 含失败步骤与原因（含 `insufficient_evidence`、`budget_exceeded`） |
| `run_cancelled` | 用户取消生效 |

进度事件可即时展示；未校验的结论不通过 SSE 流出为最终结果。

### 实体清单（PostgreSQL，drizzle）

| 表 | 职责 | 关键字段 |
| --- | --- | --- |
| `market_candles` | 各市场/价格类型 K 线 | 复合主键 venue+marketType+priceType+symbol+interval+openTime；decimal OHLCV；isClosed；source；revision |
| `market_snapshots` | 研究冻结快照 | snapshotId、asOf、各周期最后收盘 openTime 集合 |
| `structure_events` | 引擎结构事件 | ruleId、ruleVersion、barIds、knownAt、setupAt/triggerAt/invalidatedAt、provisional |
| `ingest_state` | 每序列最后连续收盘点与补洞游标 | 序列键、游标、缺口登记 |
| `research_runs` | 研究运行主记录 | 输入、状态、asOf（决策时刻，图表按此冻结）、snapshotId、configVersion、knowledgeVersion、modelVersion、取消标记、ctxState 检查点、leaseUntil/leaseOwner 运行租约 |
| `run_steps` | 每步持久化 | 输入/输出/耗时/失败原因/费用 |
| `evidence_items` | 证据冻结 | chunkId/page/figure/contentHash 或行情 bar 引用 |
| `agent_versions` | Agent 配置版本（声明式角色/能力/预算/检索策略） | 草稿→发布不可变→回滚 |
| `knowledge_documents` | 资料文档 | 来源类型 file/url/manifest、状态机 uploaded→parsing→parsed→chunked→indexed→published/failed、来源等级 |
| `knowledge_chunks` | 切分块 | docVersionId、pageNo、figureId、contentHash、terms[]、embedding vector |
| `knowledge_versions` | 知识发布快照 | 不可变 |
| `knowledge_manifest_entries` | 批量导入清单条目 | url/type/topics/access/sourceTier/enabled |
| `portfolio_positions` | 用户确认持仓 | symbol、side、qty、entryPrice、leverage、marginMode、riskBudget、confirmedAt、staleAfter |
| `event_quotes` | 事件合约报价（手动录入） | strikePrice、expiryAt、stake、totalPayout、执行参考价 |
| `predictions` | 预测记录 | 冻结特征向量、期限桶、分位概率、outcomeSource estimated/user_confirmed |
| `prediction_models` | 模型注册表 | 特征版本、训练截止、适用期限、误差、状态、MinIO 工件路径 |
| `eval_datasets` | 评测数据集（四类） | 类型、版本 |
| `eval_runs` | 评测运行与报告 | 数据集版本、指标结果 |

## 流程

1. 新增/变更实体：改 `server/src/models.ts` → `drizzle-kit generate` 生成迁移 → 启动时自动执行。
2. 新增端点：在 `shared/src/contract/` 先写 zod schema，server 路由与 web 调用同源引用。
3. 写路径（创建 run、发布、导入、确认）一律落 PG；失败按上方降级语义返回，不写 JSON 镜像兜底。

## 边界与失败处理

- DB 连接失败/迁移失败：写接口 503 + `storage: unavailable`；已有数据只读可查；界面显示实际可用状态。
- SSE 断线：客户端可按 `runId` 重连 `events` 或回退 `GET .../result`；结果以落库为准。
- 幂等：`market_candles` 复合主键 + `revision` 处理重复/乱序/修订（见 docs/specs/market-data.md）；`knowledge_chunks.contentHash` 去重。
- 兼容红线：现有 `/api/ai/chat` 等接口的字段与行为不变；机器人入口仅新增跳转 `/research` 的链接。

## 验收用例

- [ ] 上表全部端点存在且鉴权符合列值；普通用户访问 `/api/admin/*` 被拒。
- [ ] 任一新端点的请求/响应通过 `shared/src/contract/` 的 zod 校验，server 与 web 无第二份类型定义。
- [ ] SSE 五类事件在真实运行中均可观察到，`run_published` 的 data 与 `GET .../result` 一致。
- [ ] 停库后创建 run / 发布知识返回 503 + `storage: unavailable`，界面进入只读降级。
- [ ] 迁移由 `drizzle-kit generate` 产出、启动自动执行；重复启动幂等。
- [ ] 现有 `/api/ai/chat`、`/api/ai/conversations/:id`、`/api/tickers`、`/api/klines`、`/api/alerts*` 行为回归不变。

## 参考来源

- 仓库内：`server/src/models.ts`、`server/src/index.ts`（现有路由）、`server/drizzle/`、`server/drizzle.config.ts`、docs/specs/market-data.md、docs/specs/knowledge-rag.md、docs/specs/agent-orchestration.md、docs/specs/admin-security.md、docs/brooks-agent-architecture.md（§10）。
