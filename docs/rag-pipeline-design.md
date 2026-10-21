# RAG 解析管线详细设计（多格式解析 / 识别 / 后处理 / chunk 拆分）

> 版本 v2 · 2026-10-21 · 状态：已评审待实施（v2 按三轮审查修订：加权切分表述修正、向量复用键扩展、异步任务取消/attemptId/并发补齐、W1 格式范围收缩、staging 存实际产物、验收增强；权限底座前置见 unified-roadmap W1-A）
> 上游文档：`docs/knowledge-ui-redesign-plan.md`（管理端重设计，其 §2 的解析链路部分由本文档承接并深化）
> 总控路线：`docs/unified-roadmap.md`（W0-W3 阶段映射与状态标记规范）
> 调研基准：lumen（`~/wushao-dev/lumen/rag/`，工程实现参考）、RAGFlow（模板思想）、MinerU / ragflow-plus（离线重型解析参考）

---

## 0. 阅读指引与红线

### 0.1 阅读指引

- **执行者**：§2 现状缺口（先修什么）→ §3 引擎矩阵 → §4 九步管线（核心）→ §5 chunk 设计 → §7 分期任务，逐条勾选 §7 验收。
- **本文档范围**：解析→切分→索引 的 ingest 侧全链路。检索侧（三层召回/RRF/精排）除 §5.4 声明的一处输入构造增强外**零改动**。管理 UI 见上游文档。
- 与上游文档的阶段关系：上游「阶段 1 解析链路 P0」= 本文 §7 的 R1+R2；上游验收 T1 对本文档同样有效。

### 0.2 红线（违反任何一条评审不通过）

继承上游 8 条红线（检索内核不动 / 不可变版本 / 删除级联 / 权限模型 / research-py 固定端点 / 状态机只加不改 / access 显式决策 / 引用快照兼容），另加：

- **R-A**：`retrieval.ts` 的召回、融合、精排逻辑不改；chunk 新增元数据（headingPath/charSpan/parentId）只作为召回后可用的展示与提示信息，不改变打分公式（§5.4 例外：embedding 输入文本构造允许增强，因为它改变的是召回质量而非检索逻辑结构）。
- **R-B**：`ParsedBlock` / `KnowledgeChunk` 契约只增字段不改不删（shared/contract 同步）；旧文档在新管线下的 reparse 必须产出兼容结构。
- **R-C**：离线导入通道（§3.7）产物必须经过与在线通道完全相同的清洗与质量门，不允许绕过直接入库。
- **R-D**：所有新依赖（RapidOCR 等）只进 research-py 容器，Node 侧零新增重依赖；OCR 引擎必须懒加载（不解析扫描件时不占内存）。
- **R-E**：分批解析的任何一批失败重试 1 次后仍失败 → 整文档 failed（错误码 `parse_batch_failed`），不允许部分批次静默丢弃（书籍缺章节比失败更糟）。

---

## 1. 调研结论与设计依据（为什么这样设计）

### 1.1 lumen（工程参考，最接近本项目约束的已验证实现）

lumen 的 RAG 服务（Fastify + pg-boss worker）核心模式与本项目可迁移关系：

| lumen 模式 | 关键实现 | 本文档落点 |
|---|---|---|
| 解析全部委托独立服务，rag 进程只做编排 | `rag/src/parsing/client.ts` → file-parser-api | 本项目 Docling 已隔离在 research-py，同构；Node 侧不做第二套解析器（lumen 注释原话：进程内第二套解码器必然与上游发散） | 
| 六阶段事件流水线 | `file_parse_log` 表：`enqueued/started/stage/retry/failed/completed` × `download/parse/chunking/embedding/indexing` | 上游方案 §2.1 已引入同款事件表；本文 §4 对齐阶段枚举 |
| staging 快照：解析+切分产物落表，重试从快照恢复只补向量化 | `parse-and-index.ts` L801-1037，每 embedding 批 checkpoint | §6.1 |
| 确定性 chunk id（UUIDv5）→ 同字节重解析零漂移 | `shared/deterministic_id.ts` | §5.5 |
| 清洗后处理节点化（噪声行/残片并入前段/图片过滤/引擎指纹） | `chunking/post/*.ts` 12 节点 | §4.5 |
| 「降级必须持久留痕，只进日志的降级=不可见的损坏」 | `files.meta_fields` 的 `lumen_parse_degraded` 等 | §6.3 |
| 空内容防御：HTTP 200 但全空 → 按失败处理 | `client.ts` 空载荷抛 422 | §4.7 质量门的 empty_text |
| 表格 chunk 行坐标契约 + 表头重挂 | `naive_table.ts` | §5.2 |
| 标题面包屑注入 chunk 元数据与 embedding 提示 | `structured_layout.ts` sectionBreadcrumb | §5.1 / §5.4 |

### 1.2 RAGFlow（模板思想参考）

- 12 种 chunk 模板本质是三类策略组合：**结构锚点切分**（章节/条文/页）、**语义单元保持**（QA 对/表格行/整篇）、**token 窗口+overlap 兜底**。本项目单一 Brooks 书籍域 → 不做模板选择器，做一个高质量「书籍型」策略（标题路径+句界+表格/图独立）+ token 兜底，即现有 chunk.ts 的增强版。
- 分块后 LLM 增强（每块 auto-keyword + auto-question，问题字段参与索引）：实用且便宜（一次调用处理一批 chunk），本项目实现为 capabilities 开关、**默认关闭**、评测对比后决定（§5.6）。
- 检索默认全文 0.7 / 向量 0.3 的偏置印证了本项目词项层（Brooks 术语表）的价值——术语域越强，词项召回越重要（本项目已有，不动）。
- 资源门槛（4C16G+ES）不可搬；其「纯文本 PDF 走 naive 解析器跳过 OCR」的分流思想 → §4.1 预检路由。

### 1.3 MinerU / ragflow-plus（离线重型解析参考）

- MinerU basic 档（旧 pipeline）纯 CPU 可跑（~2GB 内存、0.8GB 模型）；输出契约 `markdown + content_list(page_idx+bbox+阅读顺序+图片按页命名)` 是最值得借鉴的溯源契约。
- ragflow-plus（16GB+GPU 门槛）证明了「MinerU 以 SDK 进程内集成、解析与存储解耦」可行，但其资源要求与 AGPL 许可证决定**不引入**，只借鉴架构。
- **资源受限正解：重型解析（扫描书/超大文件）在本地 Mac 离线做，VPS 只做在线轻解析与检索** → §3.7 离线导入通道。

---

## 2. 现状与缺口

### 2.1 现状链路（截至 2026-10-21）

```
上传(routes.ts) → ingest.ts(校验/去重/blob/建档 uploaded) → pg-boss 队列
  → worker processDocument(pipeline.ts):
      parseStep   → PDF/DOCX: research-py /tasks/parse-document(Docling 同步,120s 超时)
                   → TXT/MD/HTML: Node parseNative
      chunkBlocks(chunk.ts: 标题路径栈/句界/1200字/150重叠/图表独立)
      replaceChunks(写 knowledge_chunks + terms[] GIN)
      indexStep(embeddings.ts → pgvector 4096 维)
  → indexed → 管理员发布(publishDocument → knowledge_versions 不可变)
检索: retrieval.ts 三层(词项+规则卡/案例+向量) → RRF → 可选精排
```

### 2.2 缺口清单（本次发现 + 上游文档已确认项）

| # | 缺口 | 位置 | 影响 |
|---|---|---|---|
| **A（新发现）** | **Docling 标题层级被丢弃**：`research-py/app/parsing.py` 遍历 `doc.texts/tables/pictures` 只输出 `text/figure/table` 三种 kind，而 `chunk.ts` 的标题路径栈等 `heading+level` 块 | `parsing.py:91-97` vs `chunk.ts:11-17,104-110` | **书籍章节结构 headingPath 全空**：章节感知切分失效、检索面包屑缺失、embedding 失去标题上下文。Docling item 自带 `label`（title/section_header/paragraph/list_item…），映射被丢掉了 |
| **B（新发现）** | **超长表格不切分**：table 块直接成 chunk 不经 splitSentences | `chunk.ts:112-123` | 大表=超长 chunk，embedding 截断失真、引用定位粗 |
| C | 同步单请求 + 120s 超时 + 无分批/预热/进度 | `researchpy.ts:65`、`main.py:34-38` | 整本书必超时（上游文档已诊断：108 页 280s+ 未完成、内存 1.15GiB） |
| D | 格式白名单只 `.pdf/.docx` | `parsing.py:29` | Docling 2.131 开箱支持 PPTX/XLSX/HTML/图片，能力闲置 |
| E | 无预检：加密/扫描版/0 字节都要等解析后才知道 | — | 扫描版走到「切分为空」误导性失败 |
| F | 无清洗：引擎指纹行/纯页码行/页眉页脚重复行/段落残片全部入库 | — | 检索噪声 |
| G | 表格无表头重挂、figure 块 caption 可能为空串入库 | `chunk.ts:112-127` | 表格块脱离表头不可读 |
| H | 向量化输入=裸块文本，无标题路径提示 | `pipeline.ts:92` | 同名概念跨章节区分度低 |
| I | chunk 无字符区间（charSpan），用户侧无法做原文内高亮 | `chunk.ts` KnowledgeChunk | 引用只能到页码不能到段落 |

### 2.3 资源约束（设计前提）

- VPS：2C4G（升级已确认）+ 磁盘清理后 ~20G 可用；research-py 容器 `mem_limit: 1.5g`。
- Docling 模型常驻 ~600-700MB；RapidOCR(onnx) 懒加载峰值 +300-500MB；分批解析峰值 ~800MB-1GiB（实测 1.15GiB 含一次性全量）。
- 本地 Mac（M 系）算力富余：MinerU basic / Docling 完整版 + OCR 均可流畅运行 → 离线通道的重型端。

---

## 3. 引擎矩阵（格式 → 解析路径）

| 格式 | 引擎 | 路径 | 说明 |
|---|---|---|---|
| PDF（数字版） | Docling layout 管线 | 在线 | 现有，无 OCR；文本层比率 ≥ 0.3（§4.1 阈值） |
| PDF（扫描版 ≤30 页） | Docling + RapidOCR | 在线 | 预检路由判定；OCR 仅对无文本层页启用（页级懒启） |
| PDF（扫描版 >30 页） | 离线通道 | 本地 Mac → import-parsed | UI 明确指引（错误码 `scan_large_offline` + 文案「请使用离线导入」） |
| DOCX | Docling | 在线 | 现有 |
| PPTX | Docling | 在线 | **R1 尾部视情况**：仅当全链贯通（前端白名单+Node 路由+Python+验收样例齐备）才放开；slide 序号即 pageNo |
| XLSX | Docling | 在线 | 同 PPTX（全链贯通前提）；表格策略走 §5.2 |
| HTML | Node 原生（现有）/ Docling（复杂版面可选） | 在线 | 维持原生优先，原生结果质量差（质量门报警）时提示改走 Docling |
| 图片 png/jpg/jpeg | Docling + RapidOCR | 在线 | **R2 与 OCR 同期开放**（v2 收缩：W1 无 OCR 时可上传却无有效文本，先不进白名单）；整页书照/图表截图场景 |
| TXT / MD / CSV | Node 原生 | 在线 | CSV 新增轻量解析（按行+表头识别，产出 table 块） |
| DOC（老格式） | — | — | `unsupported` 错误码 + 文案「请另存为 .docx 后上传」（不装 LibreOffice：2C4G 不值得为一个罕见格式 +300MB 常驻） |
| EPUB / 音视频 | — | — | 本期明确不做（Brooks 域无需求），错误码同 unsupported |
| **离线导入**（任意来源） | 本地 Mac：MinerU basic 或 Docling 完整版 | 离线 → `POST /api/admin/knowledge/documents/import-parsed` | §3.7 |

### 3.7 离线导入通道（新增）

**动机**：扫描大部头书（300+ 页图片型）在线 OCR 在 2C4G 上不现实（每页数秒×300 页 >30min 预算）；本地 Mac 跑 MinerU basic（CPU 2GB 内存即可）或 Docling 完整版质量更好、零 VPS 负担。

**契约**：`import-parsed` 请求体 = `{ fileName, sourceTier, access, blocks: ParsedBlock[], parseMeta: { parser: 'mineru-offline' | 'docling-offline', pageCount, … } }`，blocks 走与在线完全一致的「清洗→切分→质量门→索引」后段（红线 R-C）。contentHash 仍按**原始文件字节**计算（导入请求须附原文件 bytes 或 blobKey——实现取「先正常上传原文件（存 blob，状态停在 uploaded）+ 附解析产物」两步合一：一个 multipart 请求同时带文件与 blocks，服务端建档后跳过 parseStep 直接进切分）。

**本地脚本**：`scripts/offline-parse.ts`（Node，调本地 Python 或 MinerU CLI）——输入本地 PDF 路径，产出标准 ParsedBlock JSON 并调用线上 import-parsed 端点（经 admin 会话）。脚本内部用 MinerU `mineru -p input.pdf -o out/` 的 content_list 输出转换：`page_idx→pageNo`、`text_level/heading level→kind=heading+level`、`table→kind=table(export_to_markdown)`、`img→kind=figure+caption`。

---

## 4. 解析管线九步流程（核心）

```
┌─①预检─┐   ┌─②路由─┐   ┌────③分批解析(异步任务)────┐   ┌④产物归一┐
│格式/加密 │ → │数字版? │ → │ Docling 20页/批+RapidOCR │ → │统一Block │
│0B/文本层│   │扫描版? │   │ 批级事件+重试1次         │   │+heading │
└────────┘   │离线?   │   └──────────────────────────┘   └────┬────┘
             └────────┘                                     ↓
┌─⑧词项+向量化─┐   ┌─⑦质量门─┐   ┌─⑥chunk拆分─┐   ┌─⑤清洗─────┐
│terms[]/embed │ ← │警告留痕  │ ← │ §5 策略    │ ← │噪声/残片/  │
│(标题路径提示) │   │empty防御│   │            │   │页眉页脚/去重│
└──────┬──────┘   └─────────┘   └────────────┘   └───────────┘
       ↓
┌─⑨入库(staging快照→finalization前wipe→正式库)─┐
└────────────────────────────────────────────┘
```

阶段事件枚举（写入 `knowledge_parse_events`，与上游方案 §2.1 统一）：
`enqueued → inspect → parsing(page i/N) → normalizing → cleaning → chunking → quality_gate → embedding(batch i/N) → indexing → completed | failed`

### 4.1 步骤① 预检（新增 `/tasks/inspect` 固定端点）

输入 fileName+contentBase64，输出 `{ pageCount, encrypted, textCharRatio, imagesHint }`，实现用 pypdf（轻量，无需 Docling）：逐页提取文本层字符数，`textCharRatio = 有文本层字符>50 的页数 / 总页数`。Node 侧 ingest 在建档前调用（超时 10s）：

- `encrypted=true` → 直接 failed（`encrypted`，不上 blob 之外的处理）
- `pageCount=0` 或 0 字节 → `empty_file`
- PDF 且 `textCharRatio < 0.3` → 扫描版分支：`pageCount ≤ 30` → 在线 OCR 路由；否则 failed（`scan_large_offline`，错误文案引导离线导入）
- 其余 → 数字版路由

### 4.2 步骤② 引擎路由

按 §3 矩阵，纯映射表实现（`pipeline.ts` 内 `routeEngine(fileName, inspectResult)`），路由结果写入 parseMeta.engine。

### 4.3 步骤③ 分批解析（承接上游异步任务化；v2 补齐取消/隔离/并发）

- research-py：`POST /tasks/parse-document-async` + `GET /tasks/parse-status/{taskId}`（上游方案 §2.1 已定义）；本设计补充：
  - **页级范围参数**：请求带 `pageFrom/pageTo`（Docling `PdfPipelineOptions.page_range`），Node 侧编排 20 页/批顺序调用（或 Python 侧单任务内部分批——**取 Python 内部分批**，任务自带进度，Node 只轮询，减少往返）；
  - **OCR 页级懒启**：`PdfPipelineOptions.ocr_options` 配 RapidOCR 引擎，`force_full_page_ocr=False` + `bitmap_area_threshold` 让 Docling 只对图片型页 OCR（数字页零开销）；OCR 引擎（rapidocr_onnxruntime）在首次遇到 OCR 页时才 import（红线 R-D）；
  - 每批完成即事件上报 `parsing(page i/N)` + 批间 `gc.collect()` 释放；批失败重试 1 次，仍失败 → 任务 failed（`parse_batch_failed`，红线 R-E）；
  - 总预算 15min（Node 侧），Python 任务自身无硬超时（靠 Node 超时置 failed + 容器 mem_limit 兜底）。
- **❗每轮解析独立 `attemptId`（v2）**：文档每次解析（新上传/手动重解析）生成新 attemptId；事件表、staging、Python 任务全部按 attemptId 归属；**数据库最终写入处校验当前 attemptId，迟到结果（旧轮次任务完成回调）拒绝落库**——取消/超时后旧任务即使完成也不污染新一轮。
- **❗取消/TTL 的实际执行机制（v2）**：Node 取消（用户删除/重解析/超时）调 Python 取消端点协作终止；**限定时间内未确认终止则强制回收执行单元**——Python 侧把解析任务放入**可终止的子进程**（任务级 subprocess，主进程监管），杜绝「改状态但转换继续吃 CPU/内存」的白跑。
- **❗自动重试与手动重解析区分（v2）**：自动重试（pg-boss retry / 临时故障）**允许从 staging 恢复兼容**（同 attemptId 续跑）；手动重解析**开启新 attemptId 并使旧轮次全部失效**（旧任务取消、旧 staging 作废）。
- **❗全局解析并发上限（v2）**：pg-boss 独立并发闸（队列级 maxConcurrency=1，解析任务串行、多文档排队）——现有 `singletonKey` 按文档生成，只防同文档重复入队，**不能**承担全局限制；`jobs.ts` 处理器吞异常的行为改为抛出，使 pg-boss 重试语义真实生效（2026-10-21 审查发现）。
- **❗重启恢复（v2）**：staging 保存**实际解析产物**（blocks/chunks 全量）+ `attemptId` + 处理版本（非仅 embeddedUpTo 计数）；进程重启后按 attemptId 判定续 embedding 或作废重来。

### 4.4 步骤④ 产物归一（修复缺口 A）

`parsing.py` 的 `_convert_with_docling` 增强 label 映射（Docling `item.label`）：

| Docling label | 输出 kind |
|---|---|
| `title` | `heading` level=1 |
| `section_header`（docling 2.x 有 `level` 属性） | `heading` level=1+item.level |
| `page_header` / `page_footer` | `text` + 标记 `isPageFurniture=true`（供⑤清洗用） |
| `paragraph` / `list_item` / `formula` / `caption` 等 | `text`（caption 若归属 picture 则并入 figure 块 text） |
| `table` | `table`（text=export_to_markdown 输出） |
| `picture` | `figure`（caption_text 或空） |

`PyParseBlock` 契约**新增可选字段** `level?: number`、`label?: string`（红线 R-B 只增）。`toParsedBlocks`（pipeline.ts:36-45）同步透传。

### 4.5 步骤⑤ 清洗（新增 `server/src/knowledge/clean.ts`，节点化纯函数）

按 lumen 后处理节点思想，全部为确定性规则（无 LLM）：

1. **页眉页脚剔除**：`isPageFurniture` 标记块直接剔除；无标记时兜底规则——「跨 ≥3 个不同页重复出现的 <60 字符行」视为页眉/页脚剔除（书页码行、章节名重复行）。
2. **噪声行剔除**：纯页码行（^\d{1,4}$）、引擎指纹（mineru/docling/reportlab/UUID/全零日期）、无实义图片占位行（「图 3-2」型且对应 figure 块已存在）。
3. **残片并入**：<30 有效字符且小写/无标点结尾的 text 块**并入前一块**（不丢弃——内容完整性优先），并入时 remap 后续 headingPath 不变。
4. **同页重叠去重**：同 pageNo + 近似内容（归一化后相等）的重复块只保留首个（Docling 偶发 double-report）。
5. **清洗统计**全部写入 parseMeta：`{ droppedFurniture: n, droppedNoise: n, mergedFragments: n, deduped: n }`（降级留痕原则）。

### 4.6 步骤⑥ chunk 拆分

见 §5（本文档核心设计之一）。

### 4.7 步骤⑦ 质量门（新增 `qualityGate.ts`）

对切分产物计算指标，**不达标不阻塞**、写 `parseMeta.qualityWarnings[]`（UI 显示黄色警告条）：

| 指标 | 阈值（首版，可配） | 警告码 |
|---|---|---|
| 文本块为 0 | 硬门（**阻塞**，failed） | `empty_text`（含「疑似扫描版未启用 OCR」文案） |
| 平均块长 | < 80 字符 | `suspicious_avg_len` |
| 乱码率（不可打印字符占比） | > 5% | `encoding_suspect` |
| 空文本 figure 块占比 | > 60% | `figures_no_caption` |
| heading 块数量（PDF/DOCX） | = 0 | `no_headings`（提示「文档无章节结构或解析未识别」） |

### 4.8 步骤⑧ 词项 + 向量化

- terms[]：现有 `terms.ts` 不变（Brooks 术语表 + CJK bigram 继续从块文本提取）。
- **embedding 输入构造增强**（§5.4 详述）：`headingPath.join(' > ') + '\n' + text`；表格块额外带表头行。
- 批量与 checkpoint：沿用现有批量（32/批）+ §6.1 staging 每批回写。

### 4.9 步骤⑨ 入库

现有 `replaceChunks` + `storeEmbeddings` 骨架不变，增强幂等与 wipe 时序（§6.2）。

---

## 5. chunk 拆分详细设计

### 5.1 基础策略（增强现有 chunk.ts，修复缺口 A 后生效）

保留：标题路径栈（heading 维护 `headingPath`）、句界切分（中英文句号/分号/换行）、1200/150 参数、figure/table 独立成块、首块页码。

增强：

- **加权长度**：`len(text)` 改为 `cjkCount×1 + asciiCount×0.5`（中文按字符信息密度更高加权）——`maxWeightedChars=1200` 默认值不变：**纯中文块的实际上限即 1200 个汉字；纯 ASCII 块约 2400 字符**（v2 修正：此前「中文块切到 ~800 字」为换算错误）。
- **块多页记录**：`pageNo` 单值改为 `pageNos: number[]`（跨页块记录涉及页，引用与 UI 展示「第 42-43 页」）；`pageNo` 保留为首页兼容字段（红线 R-B）。

### 5.2 表格策略（修复缺口 B）

- table 块 markdown 解析出行数组；**>20 数据行的表按行组二切**，每块携带：表头行（第一块的表头重复挂到后续每块开头）+ 行范围元数据 `tableRows: [start, end]`；
- 表格块的 `text` = 带表头的 markdown 子表；`tableHtml` 字段（契约新增可选）存原始 HTML（Docling TableFormer 可输出），供 UI 富渲染；
- 空表（0 行）丢弃并计数。

### 5.3 父子块（sub-chunk 检索，RAGFlow 借鉴）

- 子块 = §5.1 产出的检索粒度块；**父块 = 同一 headingPath 下的连续子块合并、加权长度 ≤4000**，入库时父块作为独立行 `kind='parent'`（不参与检索召回，仅上下文供给），子块带 `parentChunkId`；
- 检索侧消费（不改 retrieval.ts 的前提下）：现有「邻接上下文扩展」（retrieval.ts L382-409）升级为——命中子块时若有 parentChunkId 则取父块文本作为上下文供给，否则退回现有邻接逻辑。此改动在 retrieval 的**组装阶段**（召回后），不动召回/融合/精排（红线 R-A 合规：R-A 禁止改打分，组装供上下文属于既有邻接扩展的同类增强）。实施放 R1 末或 R2 初，评测对比决定保留与否。

### 5.4 chunk 元数据与 embedding 提示（契约新增字段全为可选）

| 字段 | 类型 | 用途 |
|---|---|---|
| `headingPath` | string[] | 入库（现有内存计算未持久化 → knowledge_chunks 加列）；检索面包屑；embedding 提示 |
| `pageNos` | number[] | 多页引用 |
| `charSpan` | [start, end] | 块文本在**归一后全文**中的字符区间（清洗后全文快照存 parseMeta.fullTextHash 或文档级暂不存全文——首版仅对 TXT/MD 存全文，PDF 用 pageNo+bbox 定位）；用户侧原文高亮（上游方案流程 7 的 contentHash 定位配合） |
| `parentChunkId` | string? | §5.3 |
| `tableRows` / `tableHtml` | 见 §5.2 | 表格 UI 渲染与行定位 |
| `contentHash` | 现有 | 变为 `sha256(headingPath.join('/') + '\n' + text + '\n' + span)` → **确定性 id**（§5.5） |

embedding 输入（`buildEmbeddingInput(chunk)`）：`headingPath.join(' > ') + '\n' + text`（表格块再前置表头行）。位置：pipeline.ts indexStep 调 embedder 前变换，embeddings.ts 不感知。

### 5.5 确定性指纹与向量复用（v2 扩展：三类指纹分别定义）

**三类指纹必须分别定义，不可混用**：

| 指纹 | 定义 | 用途 |
|---|---|---|
| 文件指纹 | `sha256(原始文件字节)`（现有 contentHash 语义） | 上传去重、blob 身份 |
| chunk 内容指纹 | `sha256(headingPath.join('/') + '\n' + text + '\n' + charSpan)` | 同字节重解析的块对齐 |
| **向量缓存键** | `sha256(embedding 实际输入文本 + 模型标识 + 维度 + 输入模板版本)` | **向量复用判定** |

- **向量复用条件（v2 修正）**：仅有 chunk 内容指纹相同**不够**——embedding 输入文本、模型、维度或输入模板（§5.4 的 headingPath 提示格式）任一变化，旧向量即不可复用。复用判定一律用向量缓存键。
- **已发布版本保留旧哈希语义**（v2 红线）：哈希规则升级只作用于新工作版本；已发布版本按入库时的规则校验，重解析不改写历史——引用快照兼容（上游红线 8）。
- chunk 主键沿用现有生成逻辑（入库序号）不变；R1 首版实现「diff 跳过已嵌块」（向量缓存键命中即保留既有 embedding），不做增量发布。

### 5.6 可选 LLM 增强（auto-keyword / auto-question，默认关闭）

- capabilities 新增 `knowledge.enhance: { enabled: false, questionsPerChunk: 2, keywordsPerChunk: 4 }`；
- 开启时：indexStep 前对每批（≤16 块一次调用）请求聊天 LLM（现有能力配置）产出关键词+假设问题，**写入该块 terms[]**（词项召回直接受益）；问题文本另存 `parseMeta.enhancedQuestions` 供评测审查；
- prompt 模板走现有提示词治理（admin prompts 页）；
- 费用预估：全库 200 块 ≈ 13 次调用 ≈ 数分钱；**必须先跑 §7 验收的 A/B 评测（开/关各跑一轮 67 条评测）再决定默认值**。

---

## 6. 稳定性设计

### 6.1 staging 快照（lumen 模式；v2：存实际产物与处理版本）

新表 `knowledge_doc_staging`：`(docId PK, attemptId, blocks jsonb, chunks jsonb, processVersion, embeddedUpTo int, createdAt, updatedAt)`。

- **保存实际产物**（blocks/chunks 全量）+ `attemptId` + 处理版本（管线逻辑版本号，升级后旧 staging 作废重跑）——不能只有 `embeddedUpTo` 计数（无法判断续跑的正确性与所属轮次）；
- 清洗+切分完成后全量落 staging；此后任何**自动重试**（同 attemptId 的 pg-boss retry）从 staging 恢复：跳过解析/切分，只补 embedding，每批完成 `embeddedUpTo` checkpoint；
- **手动重解析**与新上传清空 staging 完全重头（新 attemptId，旧轮次作废——§4.3）；
- 文档到达 indexed 时删除 staging 行。

### 6.2 finalization 时序

- 正式入库前先 `wipe`：删除该文档工作版本的全部旧 chunks（现有 replaceChunks 已是全删全插语义，保持）；R1 引入 diff 后 wipe 语义变为「删除 contentHash 不在新集合中的旧块」；
- embedding 批量失败重试 1 次；失败则文档 failed（`embedding_failed`），已嵌部分留在 staging 等重试。

### 6.3 降级留痕汇总（parseMeta.qualityWarnings / parseMeta.degraded）

| 降级 | 标记 |
|---|---|
| OCR 页被跳过（引擎未装/懒加载失败） | `ocr_skipped_pages: n` + failed 或降级继续（数字页为主时继续） |
| 表格导出失败退纯文本 | `table_export_fallback: n` |
| heading 未识别 | `no_headings`（质量门） |
| 离线导入产物质量门警告 | 同质量门码，parseMeta.parser 带 `-offline` 后缀 |

原则（lumen 原话）：**只进日志的降级 = 不可见的损坏**——全部进 parseMeta 并在 UI 呈现（上游方案流程 3 的解析日志抽屉）。

### 6.4 内存与并发预算（2C4G）

| 场景 | 预估峰值 | 控制手段 |
|---|---|---|
| Docling 常驻（模型驻留+预热） | ~700MB | 启动 warmup（上游 §2.2） |
| 数字版 PDF 分批解析 | +300-400MB | 20 页/批 + 批间释放 |
| 扫描版 ≤30 页 OCR | +500-800MB | 页级懒启 + 30 页上限 |
| embedding 调用 | 忽略（外部 API） | — |
| research-py 硬顶 | 1.5GB | compose `mem_limit`（超限=任务 failed `oom`，文档可重试） |
| 并发 | 解析任务 worker 侧串行（现有 pg-boss singletonKey 保留） | 单文档不并发；多文档排队 |

### 6.5 错误码总表（Node 侧落库 `errorCode`，UI 映射文案）

`unsupported`（含 DOC/EPUB 等明确不做的）/ `too_large`（>50MB）/ `encrypted` / `empty_file` / `empty_text` / `scan_large_offline` / `docling_missing` / `service_down` / `timeout` / `parse_batch_failed` / `oom` / `chunk_empty`（清洗后为空的极端兜底）/ `embedding_failed` / `quality_blocked`（预留）

---

## 7. 分期实施与验收

### R1 核心链路（2-3 天，对应上游阶段 1；权限底座 W1-A 为其前置——见 unified-roadmap）

- [ ] research-py：label→heading 映射（缺口 A）+ `_SUPPORTED_EXTENSIONS` 放开 pptx/xlsx（全链贯通前提）+ PyParseBlock 新字段
- [ ] research-py：`/tasks/inspect`（pypdf）+ 异步任务端点 + 内部分批（20 页/批）+ 可终止子进程 + 取消端点 + attemptId（§4.3，合并实施）
- [ ] Node：pipeline 预检路由 + ingest 调 inspect + clean.ts 五节点 + qualityGate
- [ ] Node：jobs.ts 吞异常改抛出 + pg-boss 全局并发闸（解析串行）+ attemptId 落库校验（迟到结果拒绝）
- [ ] chunk.ts：加权长度 / pageNos / 表格二切+表头重挂（缺口 B）/ charSpan / 三类指纹分别定义（§5.5）
- [ ] store：knowledge_chunks 加列（headingPath/pageNos/parentId/tableRows/tableHtml）；staging 表（实际产物+attemptId+processVersion）；DB 迁移
- [ ] embedding 输入构造（headingPath 提示）+ 向量缓存键复用判定
- [ ] compose mem_limit + 本地/发版镜像重建

**R1 验收**：
- [ ] Brooks 108 页手册：全链路 indexed；**headingPath 非空且与目录章节一致（抽 5 章核对）**；表格页产出的表格块均带表头且 ≤20 行
- [ ] **页内容覆盖抽查（v2）**：首/中/尾章各抽 1 节，其文本在对应 chunk 中可检索命中（防中间批次静默丢失）
- [ ] **批次边界断言（v2）**：20 页批次交界处（第 20/21、40/41…页）块序连续无遗漏/重复
- [ ] **失败恢复演练（v2）**：解析中 kill research-py → 文档 failed（service_down）→ 重试成功且 staging 续跑路径正确
- [ ] 同文件 reparse：新 attemptId 且三类指纹集合一致（幂等）；第二次解析不重嵌向量缓存键命中的块（日志可证）
- [ ] 中文样张（混合中英）：块加权长度达标（无 >1200 加权长度的纯中文块）
- [ ] 质量门：人为喂无文本层 PDF → `empty_text` 且文案准确
- [ ] **按角色检索评测（v2）**：67 条评测 × superadmin/普通用户两种权限上下文各跑一轮（配合 W1-A access 过滤）
- [ ] `pnpm knowledge:smoke` / `vector:smoke` / typecheck 全绿

### R2 扫描版与离线通道（1-2 天）

- [ ] RapidOCR 依赖（requirements-docling.txt）+ 页级懒启 + 预检路由接通
- [ ] `import-parsed` 端点（multipart：原文件+blocks；建档→清洗→切分→质量门→索引）
- [ ] `scripts/offline-parse.ts`（本地 MinerU content_list → ParsedBlock 转换 + 上传）
- [ ] 管理端 UI：扫描版失败文案引导 + 离线导入入口（上游方案阶段 2 顺带）

**R2 验收**：
- [ ] ≤30 页扫描样张：在线 OCR 全链路成功，OCR 页事件可见
- [ ] >30 页扫描书：failed(`scan_large_offline`) 文案含离线指引
- [ ] 本地脚本导入一本离线解析产物：质量门与在线同规、parseMeta.parser=mineru-offline
- [ ] research-py 无 OCR 任务时内存回到常驻水位（懒加载验证）

### R3 LLM 增强（1-2 天，可选，评测驱动）

- [ ] capabilities 开关 + 批量 prompt + terms 写入 + 提示词模板治理
- [ ] A/B 评测：67 条评测 开/关 各一轮，报告 hit/MRR 差异
- [ ] 依据报告决定默认值（需用户拍板）

**R3 验收**：评测报告产出；开启侧无管线阻塞（增强失败不阻塞索引，`enhance_failed` 留痕）。

### 全局回归（每期发版前）

- [ ] 67 条既有评测不回退；`p0-db-acceptance`/`p1-check` 全绿
- [ ] 线上灰度：先单文档（手册重解析）验证，再放开存量重灌

---

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 2C4G 未升级先发 R1 | 发版前置检查 free total ≥3.5G；否则分批上限降为 10 页 |
| heading 映射对某些 PDF 误判（正文被识别为标题） | 质量门 `no_headings`/块长统计可见；reparse 可回退（解析产物独立于发布版本，已发布引用不受影响——不可变版本兜底） |
| 清洗误伤正文（页眉规则误删） | 清洗统计进 parseMeta；预览抽屉可见块级结果；规则阈值保守（≥3 页重复才判页眉） |
| RapidOCR 与 docling 2.131 兼容性 | R2 单独验证（镜像内单测一页）；不兼容则换 tesseract 备选或离线通道兜底 |
| staging 表膨胀 | indexed 即删；failed 保留 7 天由清理任务回收 |
| diff 替换引入向量不一致 | R1 首版保持「全删全插」语义，diff 仅跳过重嵌（向量按 contentHash 复用，不混合新旧向量空间） |

---

## 附：与上游文档的条款映射

| 上游（knowledge-ui-redesign-plan.md） | 本文档 |
|---|---|
| §2.1 异步任务化 | §4.3（合并实施） |
| §2.2 分批+预热 | §4.3 / §6.4 |
| §2.4 错误码 | §6.5（扩表） |
| §2.3 内存前提 | §6.4 |
| 验收 T1 | §7 R1 验收（headingPath 为新增硬项） |
