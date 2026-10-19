# 评测与部署

> 状态：partial

> 实现状态（2026-10-01）：评测链路已落地（eval:run 任务 + rag hit@k/MRR、structure 因果回放通过率，与 scripts/causality-check 同口径；dialog/replay 显式 failed 不伪造）；模型训练链路已验证（Node 构建数据集+时间切分 70/15/15 → research-py /tasks/train → 注册表 ready → /api/predictions 产出真实概率 0.478，测试集 Brier 落 metrics）；compose 已含 pgvector/worker/research-py。待办：上线门槛指标基线、监控告警、镜像发布流程（GitHub Actions）。

## 目标

定义四类测试集、评测指标、回放口径、上线门槛，以及 Docker Compose 六服务部署、依赖锁定、监控与恢复方案。评测回答的问题是「系统在各自环节是否可信」，不预设、不承诺任何收益。

## 已确定决策

- 测试集四类，存 `eval_datasets`、版本化、Admin 页面管理：结构标注集（含反例与边界样本）、RAG 金标查询集、对话用例集、事件与预测回放集。
- 质量对照四版本：规则单独 / +RAG / +反证 / +搜索，报告质量、延迟、费用；基线：买入持有、空仓、简单趋势。增加 Agent 只有在样本外质量改善且延迟/费用可接受时才上线。
- 事件合约结算分别报告：worker 分钟行情「研究估算」与用户确认的真实订单结算（`outcomeSource: estimated|user_confirmed`）分开统计，不混算。
- 上线门槛：无已知前视路径、关键数值可溯源、陈旧/缺失数据正确降级；其他指标阈值由标注集与业务目标确定，不设收益承诺门槛。
- LLM 参数记忆风险单列：严格行情/规则回放与完整 LLM 历史模拟分别报告；仅限制工具日期不足以证明无泄漏。
- 回放口径：滚动样本外；计入费用、滑点与成交约束；同一 K 线同时触及目标与止损时按预先声明的保守规则成交；重叠标签样本 purge/embargo；历史交易池包含当时存在而后来退市的资产。
- 实施顺序六阶段：文档/技能 → 契约/引擎/行情 → 知识库/RAG → 研究流程 → UI → 评测/部署，每阶段以验收命令收口并同步升级各 spec 状态。

## 数据与接口

- `eval_datasets`（类型、版本）、`eval_runs`（数据集版本、指标结果）；API `/api/admin/evaluations/*`（数据集 CRUD、触发运行走 pg-boss、报告查询），见 docs/specs/api-storage.md。
- 评测代码：当前执行为 `server/src/research/evalRunner.ts`；独立评测台的目标设计见 docs/specs/evaluation-harness.md。因果性检查复用 `scripts/causality-check.ts`（`pnpm brooks:causality`）；结构自测 `scripts/brooks-selftest.ts`（`pnpm brooks:selftest`）。
- 部署：`docker-compose.yml` 六服务，卷 `pgdata`、`miniodata`：

| 服务 | 镜像/来源 | 职责 |
| --- | --- | --- |
| `app` | 现有 `Dockerfile`，`server/dist/index.js` | REST/SSE/WS、鉴权、研究运行状态机、入队任务；同源托管前端 `web/dist` |
| `worker` | 同 app 镜像，`node server/dist/worker.js` | pg-boss 消费：行情采集/补洞、解析编排、训练/预测编排、到期结算、评测 |
| `research-py` | `research-py/`（Python 3.12 + FastAPI） | 固定任务端点：Docling 解析、分位数 GBM 训练/推理/校准报告；无任意代码执行入口 |
| `db` | `pgvector/pgvector:pg17` | PG + vector 扩展；`docker/postgres-init.sql` 增加 `CREATE EXTENSION IF NOT EXISTS vector`；pg-boss 用独立 schema |
| `minio` | `minio/minio` + mc 初始化 bucket job | 原始文件、解析产物、模型工件（joblib） |
| 前端 | 由 `app` 同源托管 | 不单独成服务 |

- 依赖锁定：`pnpm-lock.yaml` 冻结；research-py 用 `pyproject.toml` + `uv.lock` 或 pip-tools 锁定；模型工件（joblib）按版本存 MinIO，元数据入 `prediction_models`。
- 配置键：`DATABASE_URL / MINIO_* / RESEARCH_PY_URL / QUEUE_SCHEMA` 等加入 `server/.env.example`。

## 流程

### 评测指标

| 层次 | 指标 | 说明 |
| --- | --- | --- |
| 结构 | precision / recall / 确认延迟 | 对照人工逐根标注（含反例、边界样本）；确认延迟以 `knownAt` 衡量 |
| RAG | Recall@K / 引用准确性 / 反例覆盖 / 无答案拒答 | 金标查询集；引用必须能定位到冻结片段 |
| 对话 | 工具应调未调 / 伪造数值 / 周期混淆 / 陈旧数据 / 越权与注入 | 用例集逐条断言 |
| 预测 | 分位覆盖 / Brier / 样本量与置信区间 / 无未来泄漏 / 版本冻结复现 | 样本外校准报告；同一版本重跑结果一致 |

### 回放与对照

1. 按时间切分 dev / calibration / sealed-test；重叠标签 purge/embargo（见 docs/specs/prediction.md）。
2. 回放含费用、滑点、成交约束与同 K 线触价保守规则；合约另计资金费率。
3. 四版本 × 基线出对照表（质量/延迟/费用）；事件合约的研究估算与用户确认订单分两列报告。
4. LLM 历史模拟与严格行情回放分开成节，注明参数记忆风险。

### 上线门槛核对

- 无已知前视路径（`pnpm brooks:causality` 全绿 + 前缀/逐根一致性）。
- 关键数值可溯源（每个价格/关键位/EV 挂 `evidenceId` 或由代码计算）。
- 陈旧/缺失数据正确降级（不可用态而非编造输出）。
- 以上逐条记录核对结果于本 spec 状态升级时。

### 监控与恢复

- 监控指标：断流缺口、证据缺失率、无效输出率、运行失败率、延迟、工具费用、检索质量（对应 `/api/market/quality` 与 `eval_runs` 趋势）。
- 恢复：`run_steps` 支持断点续跑；`ingest_state` 补洞游标在断网恢复后补齐缺口且无重复行；pg-boss 任务在进程重启后继续消费。

### 实施顺序（六阶段）

| 阶段 | 内容 | 收口 |
| --- | --- | --- |
| 一 | 文档与技能沉淀（本目录 spec、`docs/references/`、`.agents/skills/`） | 人工核对七段结构与状态标记 |
| 二 | 共享契约、引擎因果性修复、行情存储与采集 | `pnpm typecheck`、`pnpm brooks:selftest`、`pnpm brooks:causality` |
| 三 | research-py 与知识库/RAG | 导入 PDF/MD 后 `search-debug` 返回含页码引用 |
| 四 | 永续/事件研究流程、编排、Admin 配置 | 完整 run 的 SSE 与落库一致、伪造概率被拒 |
| 五 | 研究工作台与 Admin UI | 真实接口全链路 + 移动端/键盘验收 |
| 六 | 评测与部署（本文档） | compose 端到端验收 |

依赖关系：阶段二、三并行于阶段一之后，共同汇入阶段四；阶段五依赖四；阶段六收尾并升级各 spec 状态。

## 边界与失败处理

- 样本量不足：预测指标报告保持不可用/低置信展示，不输出看似精密的数字；`probability=null` 是合法结果。
- 评测数据泄漏防控：案例层「决策可见内容」与「未来结果标签」分开存储（见 docs/specs/knowledge-rag.md）。
- 历史交易池偏差：必须含退市资产，禁止只用今天仍存在的币。
- 部署降级：DB 不可用时停止新增研究与发布（见 docs/specs/api-storage.md）；`research-py` 不可用时解析/训练/预测任务排队并显示待恢复，不重试风暴。

## 验收用例

- [ ] 四类数据集可在 Admin 页面管理且版本化；评测运行落 `eval_runs` 并可查报告。
- [ ] 结构/RAG/对话/预测四组指标各有可运行评测器与输出样例。
- [ ] 因果性：`pnpm typecheck`、`pnpm brooks:selftest`、`pnpm brooks:causality` 全绿。
- [ ] 回放报告含费用/滑点/触价保守规则声明、purge/embargo 说明、含退市资产的交易池说明。
- [ ] 四版本与三基线的质量/延迟/费用对照表可复现；研究估算与用户确认订单分列。
- [ ] LLM 参数记忆风险在报告中单列一节。
- [ ] `docker compose up` 六服务全量启动：导入 manifest 并发布知识 → 发布 Agent 版本 → 永续研究 SSE 全程 → 证据联动 → 事件报价与预测 → 到期研究估算与用户确认 → 评测页出对照报告。
- [ ] 停库恢复后补洞游标续跑无重复行；运行中断后按 `run_steps` 续跑。

## 参考来源

- 仓库内：`scripts/brooks-selftest.ts`、`docker-compose.yml`、`Dockerfile`、`docker/postgres-init.sql`、`server/.env.example`、docs/specs/prediction.md、docs/specs/market-data.md、docs/specs/api-storage.md、docs/specs/knowledge-rag.md、docs/specs/evaluation-harness.md（独立评测台目标设计）、docs/brooks-agent-architecture.md（§11、§12）。
- [Freqtrade](https://github.com/freqtrade/freqtrade) 与 [lookahead-analysis](https://docs.freqtrade.io/en/stable/lookahead-analysis/)：回放与前视偏差检查方法参考。
- [FinRL](https://github.com/AI4Finance-Foundation/FinRL)：训练/测试/交易样本划分参考（不引入强化学习）。
- [NautilusTrader fill models](https://nautilustrader.io/docs/latest/concepts/backtesting/fill-models) 与 [QuantConnect LEAN reality modeling](https://www.quantconnect.com/docs/v2/writing-algorithms/reality-modeling)：fill/slippage/fee 假设显式化与敏感性扫描参考（2026-10-16）。
- [FinQA](https://github.com/czyssrs/FinQA)、[ConvFinQA](https://github.com/czyssrs/ConvFinQA)、[FinanceBench](https://huggingface.co/datasets/PatronusAI/financebench)、[FinBen](https://github.com/The-FinAI/FinBen)：数值推理与引用真实性评测协议参考；CC-BY-NC 资源仅用于非商用评测（2026-10-16）。
