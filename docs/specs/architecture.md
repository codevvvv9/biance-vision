# 架构规格：进程拓扑、模块职责与扩展点

> 状态：implemented

> 实现状态（2026-10-01）：模块拓扑全部落地（app/worker/research-py/PG+pgvector/pg-boss；MinIO 由 BlobStore 接口的本地实现替代，接口已隔离）。

## 目标

定义系统的进程/服务拓扑、各模块职责、研究流水线的分析时序、对 Lumen 的复用映射、技术选型，以及七个 OCP 扩展点。架构决策以「确定性与可审计」为纲：数值由代码计算，概率由统计模块给出，LLM 只做解释、检索组织与受控编排。

## 已确定决策

### 进程拓扑（Docker Compose 六服务）

| 服务 | 来源 | 职责 |
| --- | --- | --- |
| `app` | 现有根 Dockerfile（入口 `server/dist/index.js`） | REST/SSE/WS、鉴权、研究运行状态机、任务入队、同源托管 `web/dist` |
| `worker` | 同一镜像，CMD `node server/dist/worker.js` | pg-boss 消费：行情采集/补洞、文档解析编排、训练/预测编排、到期结算、评测 |
| `research-py` | 新增 `research-py/`（Python 3.12 + FastAPI + uvicorn） | 固定任务 HTTP 端点：Docling 解析、分位数 GBM 训练/推理/校准报告；**不提供任意代码执行入口** |
| `db` | `pgvector/pgvector:pg17`（替换 postgres:17-alpine） | PostgreSQL + vector 扩展；pg-boss 使用独立 schema |
| `minio` | `minio/minio` | 原始文件、解析产物、模型工件（joblib） |
| 前端 | 不独立部署 | 由 `app` 同源托管 `web/dist` |

### 技术选型

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 语言/运行时 | Node.js 22 + TypeScript（strict） | 保留现有栈 |
| 服务端框架 | Fastify 4 | 保留；新增标准 SSE 端点 |
| 前端 | React 18 + Vite 5 + klinecharts 9.8 | 保留；新增 /research 与 /admin 页面 |
| ORM/迁移 | Drizzle + drizzle-kit | 启动时自动执行迁移 |
| 数据库 | PostgreSQL 17 + pgvector | **新业务数据唯一权威**，不延续旧模块的 JSON 双写 |
| 队列 | pg-boss | 不引入 Redis/Kafka |
| 对象存储 | MinIO | 原始文件/解析产物/模型工件 |
| Python 侧 | FastAPI + Docling + scikit-learn + joblib | 固定端点任务，版本锁定 |

### 数据权威与降级

- 行情、研究运行、知识、持仓、报价、预测、评测等新业务数据以 PostgreSQL 为唯一权威。
- 数据库不可用时：停止新增研究与发布（返回 503 + `storage: unavailable`），界面显示实际可用状态；已有结果只读。

## 数据与接口

### 模块职责表

| 模块（路径） | 职责 |
| --- | --- |
| `shared/src/`（workspace 包 `biance-vision-brooks`） | Brooks 引擎纯函数、bars/swings/regime/signals/analyze、`market.ts` 行情契约、`contract/` 全部新 API 的 zod schema |
| `server/src/index.ts` | REST/SSE/WS 路由、鉴权、静态托管 |
| `server/src/market/` | 行情提供者（`providers/binance-spot.ts`、`providers/binance-usdm.ts`）、`ingest.ts` 幂等写入、`backfill.ts` 补洞、`snapshot.ts` 快照、`quality.ts` 数据质量 |
| `server/src/worker.ts` | pg-boss 启动与周期任务注册 |
| `server/src/knowledge/` | 知识文档流水线、混合检索 `retrieval.ts`、引用快照 |
| `server/src/portfolio/`、`server/src/research/perp/` | 持仓 CRUD、永续产品分析（纯代码数值） |
| `server/src/research/event/`、`server/src/research/prediction/` | 事件合约分析、特征计算、模型调用编排 |
| `server/src/research/orchestrator/` | 研究流水线状态机、角色执行器、校验器 |
| `server/src/admin/` | 能力配置、Agent 版本、审计 |
| `server/src/eval/` | 评测数据集与评测器 |
| `research-py/app/main.py` | `/tasks/parse-document`、`/tasks/train`、`/tasks/predict`、`/tasks/calibration-report`、`/health` |
| `web/src/research/`、`web/src/pages/Admin*` | 研究工作台与 Admin UI |

### 关键共享契约（shared）

- `shared/src/market.ts`：`MarketType`（spot/usdm_perp）、`PriceType`（trade/mark/index）、`Interval`、`CandleRow`、`SnapshotRef`。
- `shared/src/contract/`：research run 创建/进度事件/结果、portfolio、event quote、prediction、admin knowledge/agents/evaluations 的 zod schema，server 与 web 同源引用。

## 流程

### 研究流水线时序（每步输入 → 输出，全部持久化到 `run_steps`）

1. `plan`：用户问题 → 结构化查询规划（intent/symbol/marketType/timeframes/asOf/horizon/portfolioContext/missingFields/requiredTools/retrievalQueries/searchNeeded）。
2. `snapshot`：规划 → `snapshotId`（各周期 `closeTime ≤ asOf` 的已收盘集合；实时价格另标 `priceAsOf`）。
3. `structures`：快照 → 结构事件集合（含 ruleId/ruleVersion/knownAt/provisional）。
4. `retrieve`：结构 + 查询 → 支持/反证双路知识证据（引用快照冻结）。
5. `product_analysis`：快照 + 结构 + 持仓/报价 → 产品分析（perp 或 event 分析器，数值全代码计算）。
6. `countercase`：上述证据 → 反例、相反周期、失效条件（默认恰好一轮）。
7. `validate`：全部产出 → 代码校验（市场类型/数据时效/引用存在/已确认结构/数值可溯源/方向逻辑）；预算内可修复一次，再失败返回 `insufficient_evidence`。
8. `publish`：校验后结果落库并经 SSE 发布；进度可见但未校验结论不落最终结果。

同一运行共享 `snapshotId` / `knowledgeVersion` / `configVersion`；角色间禁止递归委派。取消后无后续步骤写入；进程重启可按 `run_steps` 续跑。

## Lumen 复用映射

模式与接口形态对齐 Lumen，**本项目为独立部署**：去身份服务耦合、去 Milvus 耦合、以 pgvector + 应用侧词项索引替代。

| 参考源码 | 复用内容 | 本项目适配差异 |
| --- | --- | --- |
| `lumen/rag/src/parsing/client.ts` | 解析客户端、OCR/图片选项、失败降级 | 改为 research-py 固定端点；保留页码/图号；图示缺失显示解析不完整 |
| `lumen/rag/src/chunking/` | 结构化切分、图文关联、位置元数据 | 按 Brooks 概念/例图/解释段组织 |
| `lumen/rag/src/retrieval/pipeline-v2.ts` | 多路召回、RRF、可配置精排 | pgvector 向量召回 + 应用侧 terms 词项召回；中文分词应用侧处理 |
| `lumen/service/src/knowledge-bases/backends/` | 知识后端接口形态 | `KnowledgeStore` 接口首版仅 pgvector 实现，无 Milvus |
| `lumen/service/src/chat/query-rewrite.ts` | 查询改写、失败回原文 | 提示词替换为金融意图规划；不改写币种/市场/周期/方向 |
| `lumen/service/src/chat/rag-store.ts` | 引用快照、指纹去重、溯源 | 绑定 snapshotId 与 ruleId，落 `evidence_items` |
| `lumen/service/src/chat/agentic/orchestrator/delegate.ts` | 委派、超时、取消、用量记录 | 受控三角色 + 固定状态机，无自由多轮辩论 |

## 边界与失败处理

- 不拆业务微服务、不引入 Redis/Kafka、不引入强化学习；完整 Lumen 服务不接为依赖（仅对齐接口形态）。
- `research-py` 只暴露固定任务端点，不提供任意代码执行；Node worker 经 HTTP 调用。
- 采集由 worker 常驻执行，与网页是否打开无关；现有 WS 广播仅服务前端展示，不作为落库来源。
- 数据库不可用：新增研究/发布返回 503 + `storage: unavailable`，界面降级展示实际状态。
- 各扩展点新增实现 = 新增文件并注册，不修改已有分支逻辑。

## 七个 OCP 扩展点

1. **行情提供者**：`MarketDataProvider` 接口（restKlines/wsStreams/fundingRates/openInterest/symbols），新增交易所 = 新增实现并注册。
2. **价格类型与周期**：`market_type`、`price_type: trade|mark|index`、`interval` 作为数据维度进入契约与表结构，不在代码分叉。
3. **Brooks 规则注册表**：`shared/src/rules/registry.ts`，结构事件携带 `ruleId/ruleVersion/params`，参数只能从已注册 schema 取值。
4. **模型插件**：`ModelPlugin` 接口（features → 分位数分布），首版 `quantile-gbm` 调 research-py。
5. **知识后端**：`KnowledgeStore` 接口（upsertChunks/searchHybrid/fetchCitation），首版 pgvector。
6. **Agent 角色声明式配置**：名称/工具白名单/提示模板/预算存 `agent_versions`，新增角色不改状态机。
7. **产品分析器**：`ProductAnalyzer` 接口，`perp` 与 `event` 两个实现注册；新增产品类型 = 新增分析器。

## 验收用例

- [ ] `docker compose up -d --build` 后六服务（app/worker/research-py/db/minio + 前端同源）全部健康。
- [ ] `pnpm typecheck`、`pnpm build` 通过；`web/dist` 由 app 同源托管，非 `/api` GET 回退 `index.html`。
- [ ] 创建 research run 后 SSE 事件序列与最终落库结果一致；取消后无后续步骤写入。
- [ ] 停库后创建 run 返回 503 + `storage: unavailable`，界面显示实际可用状态；恢复后可继续。
- [ ] worker 常驻采集：网页未打开时行情仍持续落库（查 `market_candles` 增量）。
- [ ] research-py 不存在任意代码执行端点；仅四个固定任务端点 + 健康检查。
- [ ] 七个扩展点各有注册表/接口落点，新增实现不需改动已有分支。

## 参考来源

- docs/specs/market-data.md、docs/specs/brooks-engine.md、docs/specs/knowledge-rag.md、docs/specs/agent-orchestration.md、docs/specs/api-storage.md、docs/specs/evaluation-deployment.md
- docs/brooks-agent-architecture.md（§3 总体架构、§6 Lumen 复用调研）
- docs/references/financial-agent-patterns.md（开源模式研究）
- pgvector：https://github.com/pgvector/pgvector
- Freqtrade 前视偏差检查方法：https://docs.freqtrade.io/en/stable/lookahead-analysis/
