# Spec：知识库与 RAG（knowledge-rag）

> 状态：implemented（W1/W2 变更项为 planned，以实际提交为准更新）

> 增强（2026-10-13，feat/chat-first-advisor）：`searchHybrid` 新增 `llmVariants` 选项消费改写变体——`knowledge/queryRewrite.ts` 由 chat LLM 生成变体（反漂移校验须共享词项，失败/未配置降级确定性），变体词项进词项召回并集、变体（≤2）批量 embed 后各自成列表进 RRF；缺省关闭时召回行为与历史一致（确定性变体此前仅出现在 debug，不参与召回）。概念问答会话路径已开启（support=2/counter=1）；流水线 retrieve 按冻结策略接入为后续项。

> **方案变更（2026-10-21，统一路线 `docs/unified-roadmap.md`，详设见两份 v2 方案文档）**：
> ① **access 语义定案为方案甲（参与检索过滤）**——purchase/member 资料对普通用户不可见（superadmin 由服务端判定的权限上下文例外），过滤贯穿六条检索/消费路径且先于送入 LLM；「已确定决策」中检索流水线的「权限/版本过滤」从规划性表述落为硬约束（W1-A 实施）。历史快照语义：冻结证据按冻结时授权供原研究所有者渲染，新检索/新研究/自动上下文一律按当前权限。
> ② **删除语义改两段式**——默认「移出当前发布集合+归档」（chunks/blob 保留，历史版本可恢复）；彻底清除为独立流程（DB 删除标记+幂等异步清理，冻结证据自包含不依赖文档行回查，服务端校验版本恢复能力）。
> ③ 解析事件表按 `attemptId` 组织（异步任务取消/迟到结果隔离/自动重试与手动重解析区分），管线九步/staging/三类指纹等详设见 `docs/rag-pipeline-design.md` v2。

## 实现状态（2026-10-01）

已实现并验证（`pnpm knowledge:smoke` 28 项全绿 + HTTP 端到端：上传→worker 解析→发布→search-debug）：

- 三通道导入（multipart 上传 / URL 抓取 / manifest 批量）、contentHash 去重、访问限制如实失败。
- 解析：TXT/MD/HTML Node 原生；PDF/DOCX 走 `server/src/researchpy.ts` → research-py `/tasks/parse-document`（Docling）。
- 切分（`knowledge/chunk.ts`：标题路径/句界/重叠/图文相邻）→ 术语词项（`terms.ts` H2/L2/ii/ioi 同义词 + CJK bigram）→ embedding（OpenAI 兼容，能力配置驱动）。
- 检索：词项召回（GIN）+ 向量召回（pgvector）+ RRF + 精排（能力未配置显式跳过）+ 邻接扩展；支持/反证双路（counter 注入反证意图词项）。
- 发布版本：`knowledge_versions` 不可变快照；重解析写工作版本 `${docId}#${version+1}`，已发布引用不失效。
- `/api/admin/knowledge/*` 全部端点（见 api-storage.md 清单）+ 审计（knowledge_import / knowledge_publish）。

偏离与待办：

- **MinIO 未接**：原始文件经 `knowledge/blobstore.ts` 的 `BlobStore` 接口落本地磁盘（`server/data/knowledge-files/`），MinIO 实现留部署阶段补（接口已隔离）。
- **pgvector 已启用（本地 dev）**：compose 切 `pgvector/pgvector:pg17` + 超级用户建扩展 + 补列（旧卷场景；新卷由 init 脚本自动完成）。**embedding/rerank 能力已接通真实端点**（与 Lumen 同源：Qwen3-VL-Embedding-8B 4096 维免密、bge-reranker-v2-m3，配置持久化在 app_settings，可用 `scripts/config-capabilities.ts` 重放）。`pnpm vector:smoke` 以真实端点验证 embedding 写入→向量召回→RRF→精排全链路（未启用/未配置自动 SKIP）。4096 维超出 pgvector ANN 索引上限（2000），当前走精确扫描——知识库数千 chunk 内毫秒级；换 ≤2000 维模型时补建 hnsw。迁移守卫 DDL 同步 4096 维，无扩展环境不阻断启动。
- **规则卡层与案例层已落地（2026-10-08）**：`rule_cards`（一概念一卡，LLM/模板草拟 → 「待人工补全」占位阻止发布 → 人工补全 → 发布 vN，已发布不可改；published 进检索并保留席位）与 `case_windows`（可见上下文与未来结果分列，检索只返回 visibleContext；`knowledge:smoke` 39 项覆盖）。Admin 页有对应面板。
- **MinIO 已接（2026-10-08）**：`minioBlobstore.ts`（SigV4 最小实现，无 SDK 依赖）按 MINIO_* 环境启用，缺省落本地磁盘；compose 含 minio + 建桶 init 服务。

## 目标

定义 Brooks 知识库的导入、解析、规则卡、混合检索、引用与权限机制：让 Agent 能检索并精确定位引用 Brooks 官方资料与用户有使用权的材料，支持/反证双路检索，引用可溯源到文档版本、页码与图号，且全流程不伪造页码、不绕过访问限制、不发生案例泄漏。

## 已确定决策

- 三类资料层分库管理：
  1. **原始资料层**：官方术语表、公开教学材料、用户上传的有使用权书籍与图表；保留版本、章节、页码、图号、原始片段。
  2. **规则卡层**：一个概念一张卡——定义、成立条件、上下文、失效条件、易混淆概念、反例、关联 `ruleId`、出处；LLM 可草拟，**管理员审核后才发布**；资料正文更新不自动修改线上规则代码。
  3. **案例层**：真实 OHLC 窗口、人工结构标注、当时可见的多周期上下文与解释；**决策时可见内容与未来收益/结果标签分开存储**，防止案例检索把未来结果泄漏给模型。
- 三种导入通道：超管文件上传、单 URL 导入、资料清单批量导入（manifest）。**商业书籍/会员资料仅通过用户上传有使用权的文件导入；URL 导入不绕过任何访问限制**。
- 解析：PDF/DOCX 走 `research-py` 固定端点 `/tasks/parse-document`（Docling）；TXT/MD/HTML 走 Node 原生解析，不入 Docling 通道。保留页码/图号/图文相邻关系；**图片中估算的价格只用于知识理解，不得进入交易数据**；扫描件走 Docling OCR 路径并标注解析质量。
- 检索流水线：`术语归一 + 同义词表（覆盖 H2/L2/ii/ioi 等短词的精确词项）→ 权限/版本过滤 → 向量召回（pgvector）+ 词项召回 → RRF 融合 → 可配置精排（admin 配置的 rerank 能力，未配置则跳过）→ 邻接上下文扩展 → 引用快照冻结`。支持/反证双路检索。
- 工程起始值：原问题 + 最多 2 个改写变体、候选约 30–50 条、精排后约 6–10 条；这些是**起始值**，最终参数由标注查询集评测选择，不得当成最佳实践常数。相似度分数不当事实正确率。
- 引用与冻结：每条引用保存 `documentVersion/chunkId/pageNo/figureId/sourceType/contentHash`；发布回答时把实际使用的片段冻结进 `evidence_items`，之后资料更新不影响已发布回答。
- 三态显式返回：来源不足（insufficient_evidence）、解析失败（failed 及原因）、权限不足（无使用权/未发布）分别成状态，不允许伪造页码或出处。
- 只有已发布（published）的文档版本进入检索；未发布、解析中、失败的文档不可见。

## 数据与接口

- 表 `knowledge_documents`：来源类型（file/url/manifest）、状态机（uploaded→parsing→parsed→chunked→indexed→published / failed）、版本、来源等级（official/official_derivative/community）、访问方式（public/purchase/member）。
- 表 `knowledge_chunks`：`docVersionId`、`pageNo`、`figureId`、`contentHash`、`terms[]`、embedding（vector 维度可配，默认 1536）；`terms` 数组与 PG GIN 索引支撑应用侧词项召回。
- 表 `knowledge_versions`：发布快照，不可变；Agent 版本绑定 `knowledgeVersion` 与检索策略（见 `docs/specs/admin-security.md`）。
- 表 `knowledge_manifest_entries`：批量导入清单条目（对齐 `docs/references/knowledge-source-manifest.json` 的字段语义）。
- 解析产物与原始文件存 MinIO，元数据落 PG。
- API `/api/admin/knowledge/*`：`POST /documents`（上传）、`POST /documents/import-url`、`POST /documents/import-manifest`、`GET /documents`、`GET /documents/:id/preview`、`POST /documents/:id/reparse`、`POST /documents/:id/publish`、`GET /search-debug?query=`（各阶段打点）、`GET /chunks/:id`（引用定位原文）。
- 知识后端：`KnowledgeStore` 接口（upsertChunks/searchHybrid/fetchCitation），首版 pgvector 实现。

## 流程

1. 导入：三种通道之一进入 → 原始文件/抓取内容存 MinIO，文档记录落库（状态 uploaded）。
2. 解析（pg-boss 任务）：PDF/DOCX 调 Docling 端点，TXT/MD/HTML 原生解析 → blocks（text/figure/table，含 pageNo、figureId、bbox）→ 预览态（parsed），图示缺失或 OCR 质量差时标注解析不完整。
3. 切分：按章节/概念/图示组织 chunk，保留页码图号与图文相邻关联（chunked）。
4. 索引：术语切词（写入 `terms[]`）+ embedding（admin 配置的 embedding 能力）写入 pgvector（indexed）。
5. 审核发布：管理员预览、核对出处后发布，生成不可变 `knowledgeVersion`（published）。
6. 检索：按上述流水线召回，支持/反证双路；每条被用引用冻结进 `evidence_items`，随 run 结果发布。
7. 规则卡：LLM 草拟 → 管理员审核 → 发布；规则卡关联 `ruleId` 仅作解释用途，引擎规则代码的变更走 `docs/specs/brooks-engine.md` 的注册表流程。

## 边界与失败处理

- 来源不足：检索结果低于质量标准 → 明确返回证据不足，不编造引用。
- 解析失败：Docling/原生解析失败 → 文档状态 failed 并记录原因，可 reparse 重试。
- 权限不足：无使用权或会员内容 → 只允许用户上传有使用权的文件；URL 导入遇访问限制如实失败，不绕过。
- 中文分词与 H2/L2/ii/ioi 等短词：向量召回不足以覆盖，必须依赖术语归一、同义词表与应用侧词项召回。
- 案例层检索：只返回决策时可见内容字段，未来结果标签不参与召回与展示。
- 重复资料：`contentHash` 去重，重复导入给出明确状态。
- 数据库或 MinIO 不可用 → 停止新增导入与发布，界面显示实际可用状态。

## Lumen 复用映射

首版以 PostgreSQL + pgvector 独立实现，接口形态对齐 Lumen 适配器，**去掉身份服务耦合与 Milvus 耦合**：

| Lumen 模块 | 复用内容 | 本项目适配差异 |
| --- | --- | --- |
| `lumen/rag/src/parsing/client.ts` | 解析客户端、OCR/图片选项、失败降级 | 改为调用 research-py 固定端点（Docling）；保留页码/图号 |
| `lumen/rag/src/chunking/` | 结构化切分、图片关联、位置元数据 | 按 Brooks 概念、例图、解释段组织 |
| `lumen/rag/src/retrieval/pipeline-v2.ts` | 多路召回、RRF、精排 | 向量召回用 pgvector；词项召回改为应用侧 `terms[]` + PG GIN 索引；增加术语词表与支持/反证双路 |
| `lumen/service/src/knowledge-bases/backends/` | 知识库后端接口形态 | 实现 `KnowledgeStore` 接口，默认 pgvector 单后端，不同时维护两套索引 |
| `lumen/service/src/chat/query-rewrite.ts` 等 | 查询改写、失败回原文 | 换成金融意图规划（见 `docs/specs/agent-orchestration.md`） |
| `lumen/service/src/chat/rag-store.ts` | 引用片段快照、指纹去重 | 冻结进 `evidence_items` 并绑定 run |

中文分词在应用侧处理；pgvector 提供向量检索，不等于 BM25。

## 验收用例

- [ ] 导入一份 PDF 与一份 MD 后，`GET /api/admin/knowledge/search-debug?query=H2 是什么` 返回含页码的引用，各阶段（召回/融合/精排）打点可见。
- [ ] 「H2」「ii」「ioi」等短词查询能被同义词表与词项召回命中，不只靠向量相似度。
- [ ] URL 导入失败、重复资料（contentHash）、扫描件 OCR、未发布文档不参与检索，均有明确状态。
- [ ] 引用字段齐全（documentVersion/chunkId/pageNo/figureId/sourceType/contentHash）；发布回答后更新资料，原回答的引用快照不变。
- [ ] 规则卡经 LLM 草拟后必须管理员审核发布；资料正文更新后线上规则代码不变。
- [ ] 案例检索结果不含未来结果标签字段。
- [ ] 来源不足 / 解析失败 / 权限不足三态分别返回且可区分；全库检索不到时直接说明证据不足，无伪造页码。
- [ ] manifest 批量导入的条目字段与 `docs/references/knowledge-source-manifest.json` 语义一致。

## 参考来源

- Brooks 术语表：https://www.brookstradingcourse.com/price-action-trading-terms-glossary/
- Brooks 缩写表：https://www.brookstradingcourse.com/brooks-price-action-abbreviations/
- Brooks 书籍与图表下载：https://www.brookstradingcourse.com/price-action-trading-books/
- Brooks 课程目录：https://www.brookstradingcourse.com/trade-price-action/
- Brooks 交易手册及公开章节：https://www.brookstradingcourse.com/how-to-trade-price-action-manual/
- Ask Al 问答：https://www.brookstradingcourse.com/blog/ask-al/
- 图形百科样例：https://www.brookstradingcourse.com/price-action/brooks-encyclopedia-chart-patterns-sampler/
- `docs/references/brooks-sources.md`（来源等级、访问方式与导入方式清单）
- `docs/references/knowledge-source-manifest.json`（批量导入清单格式）
- `docs/specs/api-storage.md`（知识实体与 `/api/admin/knowledge/*` 契约）
- `docs/specs/admin-security.md`（知识绑定、发布与权限）
- `docs/specs/brooks-engine.md`（ruleId 与规则注册表）
