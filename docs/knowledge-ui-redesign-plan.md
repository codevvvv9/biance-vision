# 知识库管理端重设计与 PDF 解析修复方案

> 版本 v2 · 2026-10-21 · 状态：已评审待实施（v2 按三轮审查修订：删除语义两段式重构、access 已拍板方案甲并前置 W1、fileUrl 鉴权与预览隔离、阶段 0 环境项已完成校准；状态标记规范见 unified-roadmap）
> 总控路线：`docs/unified-roadmap.md`（W0-W3 阶段映射；本文档 §2-§5 对应 W1-B 与 W2）
> 参考系统：lumen（`~/wushao-dev/lumen/frontend/packages/product/src/modules/knowledge/`）
> 触发事件：用户上传《How to Trade Price Action Manual》（Brooks 免费手册，108 页）解析失败

---

## 0. 阅读指引与红线

### 0.1 阅读指引

- **执行者先读**：§1（根因，决定 §2 的必要性）→ §2（P0 解析修复，先于一切 UI 工作）→ §3/§4（UI 与架构）→ §5（分阶段任务）→ §6（验收清单，逐条勾选）。
- **只想了解结论的人**：读 §1.1 根因表和 §5 阶段总览即可。
- 本文所有「实测」数据来自 2026-10-21 对本地与线上（bv-prod，43.129.182.5）的真实诊断，证据可复现（复现命令见 §1.2）。

### 0.2 红线（违反任何一条即评审不通过）

1. **检索内核不动**：`server/src/knowledge/retrieval.ts` 的三层召回、RRF 融合、版本过滤逻辑本方案零改动。
2. **不可变版本语义不破坏**：`knowledge_versions` 及已发布版本的 `docVersionIds` 集合语义不变；新增「回滚」= 发布一个旧集合的新版本，绝不就地改历史版本。
3. **删除必须级联**：删文档必须同事务清理 chunks、blob 对象、manifest 关联，且从「当前版本集合」移除其 docVersionId；不允许孤儿数据。
4. **权限模型不变**：所有 `/api/admin/knowledge/*` 写操作维持 `requireSuperadmin`；用户侧只新增只读消费能力。
5. **research-py 固定任务端点纪律**：只新增固定路径的任务端点，绝不引入任意代码执行入口。
6. **状态机只加不改**：现有 `uploaded/parsing/parsed/chunked/indexed/published/failed` 语义保留，新增字段/事件向下兼容（旧文档在新 UI 必须正常展示）。
7. **access 字段必须显式决策**：要么参与检索过滤，要么在上传界面明示「发布后对所有用户可见」；不允许维持「看起来有权限控制实际没有」的状态（§4.6）。
8. **引用快照兼容**：`fetchCitation` 返回结构只能新增字段不能删改，研究结果卡与聊天侧的既有渲染不许被破坏。

---

## 1. 现状诊断

### 1.1 「这种 PDF 无法解析」的三层根因（实测）

| 层 | 环境 | 现象（用户可见） | 根因 | 实测证据（2026-10-21） |
|---|---|---|---|---|
| 1 | 本地 | 上传 PDF → 解析中 → **失败**，错误信息「Docling 解析失败：docling is not installed in this environment」 | 本地 `biance-vision-research-py:latest` 是旧轻量镜像（无 Docling）；v0.9.2 只修了发版镜像，本地从未重建 | `curl 127.0.0.1:8100/health` → `{"docling":false,...}` |
| 2 | 线上 | 上传 PDF → 解析中卡住 → **失败**，错误信息「research-py 不可达：Timeout…」 | 整本书**同步单请求**解析：108 页冷启动超过 280 秒仍未完成，而 Node 侧客户端超时只有 120 秒（`server/src/researchpy.ts:65`）先断开 | 线上直打 `/tasks/parse-document`：`curl_exit=28`（280s 超时无响应）；容器内存从 389MB 飙至 **1.15GiB**，重启才释放 |
| 3 | 架构 | 无论本地线上，大 PDF（整本书）天生失败；失败原因只有一句超时文案，无从判断「慢/挂/缺依赖」 | 同步调用 + 固定 120s 超时 + 无分批、无进度、无模型预热、无错误分类（`research-py/app/main.py:34-38` 同步端点；`pipeline.ts:53-58` 直接透传） | 本次 108 页书触发；页数更多的完整版书籍（300+ 页）必然更糟 |

**附：这本书本身没有任何问题**（排除「特殊 PDF」嫌疑）：
- 2.2MB / 108 页 / 未加密 / PDF 1.5 / Word 2013 原生生成的**数字版**（非扫描）；
- `pdftotext` 全书提取 14.3 万非空白字符，文本干净（含完整章节文本）；
- 68 个图片对象（K 线截图）——图多会推高 Docling 内存与耗时，但不是失败原因。

### 1.2 复现命令（执行者验证用）

```bash
# 本地根因：health 里 docling 必须为 true
curl -s http://127.0.0.1:8100/health

# 构造这本书的 payload（路径含中文注意引号）
python3 -c "
import base64, json
pdf = '/Users/shaolin/wushao-dev/03、阿布交易书籍（非常齐全，根据大佬路线，先看视频，再看书）/How to trade price action manual.pdf'
data = base64.b64encode(open(pdf,'rb').read()).decode()
json.dump({'docId':'diag','fileName':'How to trade price action manual.pdf','contentBase64':data}, open('/tmp/bv-pdf-payload.json','w'))"

# 线上直打解析端点（观察超时与内存）
scp /tmp/bv-pdf-payload.json bv-prod:/tmp/
ssh bv-prod 'curl -s --max-time 280 -X POST http://127.0.0.1:8100/tasks/parse-document \
  -H "content-type: application/json" --data @/tmp/bv-pdf-payload.json | head -c 300; \
  docker stats --no-stream | grep research'
```

### 1.3 管理 UI 缺口清单（现状盘点，行号为当前代码）

**坏死的（功能声称有但实际不可用）**

| # | 缺口 | 位置 |
|---|---|---|
| G1 | 「从默认清单导入」按钮提交 `{ entries: [] }`，后端要求 ≥1 条，**点了必报 400**；manifest 条目状态（pending/skipped/failed/lastError）无任何 UI | `web/src/admin/knowledge/ImportZone.tsx:99` vs `server/src/knowledge/routes.ts:189` |
| G2 | **文档删除完全缺失**：无 DELETE 端点、无 `deleteDocument` 存储函数；错传文件永久留库，blob/chunks/版本引用无法清理 | `routes.ts`（全表无 DELETE） |
| G3 | 上传时 `sourceTier/access` 被硬编码（文件=community/public，URL=official/public），后端 3×3 组合只能直调 API | `ImportZone.tsx:28-29,78` |

**断链的（后端有能力、前端无入口）**

| # | 缺口 | 位置 |
|---|---|---|
| G4 | 案例 unpublish：`setCasePublished(id,false)` 已实现，无路由无按钮 | `ruleCards.ts:343` vs `routes.ts:504` |
| G5 | 版本历史/回滚：`knowledge_versions` 不可变设计天然支持，只有「当前版本」端点，无历史列表 | `routes.ts:342` |
| G6 | worker 死亡时文档停留 uploaded，页面轮询只盯 parsing，不提示队列不可用 | `jobs.ts:15-17` |

**交互欠账（对照 lumen 标准）**

| # | 缺口 | 现状 |
|---|---|---|
| G7 | 失败无下钻：只有「失败」徽章+红边，原因要开抽屉看 JSON；无轮次、无阶段耗时 | `DocGrid.tsx` |
| G8 | 向量化进度不可见；中间态一闪而过；轮询为 3s 全量傻轮询 | `AdminKnowledgePage.tsx:36-41` |
| G9 | 无任何批量操作（发布/重解析/删除） | — |
| G10 | 用户侧黑盒：引用只能看冻结文本，不能跳原文（`/file` 是超管专属 `routes.ts:277`）；聊天引用是服务端拼的纯文本 | `conversation.ts:643` |

**业务逻辑漏洞**：`access`（public/purchase/member）只是合规标记，**不参与检索过滤**（`retrieval.ts` 只按 docVersionIds 过滤）——purchase/member 资料发布后检索结果对所有用户可见（红线 7 要求显式决策）。

### 1.4 lumen 可迁移的六大交互模式（映射关系）

| lumen 模式 | 关键实现（lumen 侧文件） | 映射到本项目的落点 |
|---|---|---|
| M1 服务端权威状态机 + 差异轮询 | `KnowledgePage.tsx:87-97`（2s 轻量状态→翻转才全刷；列表 5s 只刷统计；操作后 1.5s 补刷；终态自停） | §3.3 流程 2 |
| M2 失败即可下钻（解析日志轮次+阶段事件流） | `ParseLogDrawer.tsx`（enqueued→started→六个具名 stage→retry→failed/completed，带耗时/错误码/时间戳） | §3.3 流程 3 + §4.3 事件表 |
| M3 上传队列对话框（入队校验/串行/放弃=回滚） | `KnowledgeUploadDialog.tsx`（523 行：格式/大小/重复三道校验、逐文件进度、abort+服务端 rollback） | §3.3 流程 1 |
| M4 三层预览分离（原文/分段/日志三个抽屉） | `FilePreviewDrawer/ChunkDrawer/ParseLogDrawer` | §3.4 组件 |
| M5 危险操作精确确认 + 批量部分失败汇报 | 删除解析中文件明示「将取消解析任务并强制删除」；批量结果 removed/failed/skipped 分开计数 | §3.3 流程 4/6 |
| M6 引用定位可信降级（contentHash 指纹） | `sourcePreviewLocations.ts`（坐标陈旧宁可不高亮并提示，textMatch 重定位改述文案） | §3.3 流程 7（P2） |

---

## 2. P0：PDF 解析链路修复（先于一切 UI 工作）

> 结论：不做本节，UI 再好也无法导入整本书——这是知识库的主用途。
>
> **❗2026-10-21 起本节已由 `docs/rag-pipeline-design.md` 承接并大幅深化**（多格式引擎矩阵、九步解析管线、chunk 拆分增强、清洗/质量门、离线导入通道、确定性幂等、内存预算）。本节保留作为概述与索引：§2.1 异步任务化 → 详设 §4.3；§2.2 分批/预热 → 详设 §4.3/§6.4；§2.4 错误码 → 详设 §6.5；§2.3 内存前提 → 详设 §6.4。两文档的验收合并执行（本节 T1 + 详设 §7 R1 验收）。另：详设新发现两个缺口——Docling 标题层级被 Python 侧丢弃（章节结构 headingPath 全空）与超长表格不切分，均列入 R1 必修。

### 2.1 research-py 异步任务化（核心改造）

**现状**：`POST /tasks/parse-document` 同步阻塞，Node 侧 120s 超时放弃，Python 侧继续白跑并占内存。

**目标**：拆成提交/查询两个固定端点，天然支持进度上报，同时为 §3.3 流程 3（失败下钻）提供事件数据。

```
POST /tasks/parse-document-async   → { taskId }                     （立即返回）
GET  /tasks/parse-status/{taskId}  → { status, stage, pageNo, totalPages, events[], error? }
```

- `events[]` 结构对齐 lumen M2：`{ seq, stage, message?, atMs, durationMs? }`。
- **stage 枚举**（写入 §4.3 事件表，同款枚举贯穿前后端）：
  `enqueued → model_loading → fetching → parsing(page i/N) → chunking → embedding → completed | failed`
- 任务状态机：`pending → running → completed | failed`；进程内 dict 存任务（重启即失，与现状一致——文档级状态仍在 Node 侧 DB，Python 任务只是执行器）。
- 保留旧同步端点不动（训练/翻译不受影响；旧调用方平滑迁移后可标记 deprecated）。
- Node 侧 `researchpy.ts` 新增 `parseDocumentAsync/parseStatus`；`pipeline.ts` 改为「提交 → 轮询（间隔 3s，单任务总预算 15min）→ 超时置 failed 并带明确错误码」。

### 2.2 分批解析 + 模型预热

- **分批**：Python 侧对 PDF 按 20 页/批顺序转换，每批完成即上报 `parsing(page i/N)` 事件并释放该批对象；单批内部异常重试 1 次。108 页 ≈ 6 批，单批 CPU 耗时约 20-40s，全程约 3-6 分钟（2 核），在 15min 预算内。
- **模型预热**：容器启动后后台线程加载 Docling layout/tableformer 模型（warmup 一次 dummy 转换），`/health` 增加 `doclingWarmed: bool`；避免用户首次上传时把模型加载时间算进解析。
- **模型预置**：`research-py/Dockerfile`（WITH_DOCLING=1 分支）构建期下载模型到镜像（`DOCLING_ARTIFACTS_PATH` 指向预置目录），运行期**禁止联网下载**（离线环境也稳定；镜像体积增大 1-2GB，GHCR 可承受，磁盘前提见 §2.4）。

### 2.3 内存与部署前提

- 实测单书解析峰值 **1.15GiB**（含模型驻留约 600-700MB + 转换峰值）。分批后峰值可压到 ~800MB-1GiB，但模型驻留不可避免。
- **前提 A**：VPS 升级到 2核4G（入门型 ¥90/月，升级操作已另行确认可行，IP 不变）后才允许上线「整本书」解析；2G 时期单文档限制 ≤30 页。
- **前提 B**：VPS 磁盘先执行 `docker image prune -a`（当前 91%，16.2GB 可回收），否则带模型的新镜像拉不下来。
- research-py 容器在 compose 增加 `mem_limit: 1.5g`（防止单次解析把整机拖垮；超限被杀时任务置 failed=oom，文档可重试）。

### 2.4 错误分类透出（error code 表）

| code | 触发 | 用户可见文案（草拟） | 建议动作 |
|---|---|---|---|
| `docling_missing` | 容器无 Docling | 解析服务未安装解析组件（镜像缺失） | 管理员重建镜像 |
| `timeout` | 任务总预算 15min 超时 | 解析超时（页数过多或服务器繁忙） | 减小文件 / 稍后重试 |
| `oom` | 容器内存超限被杀 | 解析内存不足 | 升级配置或拆分文件 |
| `empty_text` | 解析结果文本为空（扫描版无 OCR） | 该 PDF 无文本层（疑似扫描版），暂不支持 OCR | 更换数字版文件 |
| `unsupported` / `too_large` / `fetch_failed` | 现有分支 | 按语义 | — |

- Python 侧响应携带 `errorCode`；Node 侧 `pipeline.ts` 落库时同时写 `error`（人话）与 `errorCode`；前端按 code 映射文案+建议动作。
- **补充防线**：`parseStep` 对 Docling 路径补「文本块为 0」检查（现在只有 native 路径有空检查 `pipeline.ts:72`，Docling 空结果会流到「切分结果为空」这个误导性错误）→ 报 `empty_text`。
- **OCR 决策**：本期**不启用** Docling OCR（Brooks 资料均为数字版；OCR 引擎额外占 500MB+ 内存与更长耗时）。`empty_text` 明确告知用户换数字版。若未来需要，另立方案。

### 2.5 本地环境修复（一次性）

```bash
cd /Users/shaolin/wushao-dev/biance-vision
docker build -f research-py/Dockerfile --build-arg WITH_DOCLING=1 -t biance-vision-research-py:latest research-py/ 2>/dev/null || \
  (查看 research-py/Dockerfile 确认构建参数名后执行)
docker compose up -d research-py
curl -s http://127.0.0.1:8100/health   # 期望 docling:true
```

> 注意：以 `research-py/Dockerfile` 实际 ARG 名为准（发版工作流 `.github/workflows/release.yml` 里有现成构建命令可抄）。

---

## 3. 管理 UI 重设计（参考 lumen）

### 3.1 设计原则（从 lumen 提炼，评审 UI 方案时逐条对照）

1. 服务端权威状态机：前端从不发明乐观状态，命令后以服务端状态为准。
2. 失败即可下钻：失败不是终点文案，是日志入口。
3. 浏览跳页面、查看用抽屉、确认用模态（层级克制）。
4. 差异轮询：能用轻量接口检测翻转就不全量刷新；终态自动停。
5. 危险操作把副作用说清楚（精确确认文案），批量操作汇报部分失败。
6. 空/错状态区分且都带下一步动作（空库→引导上传；无匹配→提示换词；队列不可用→提示启动 worker）。

### 3.2 信息架构

维持「单页三 Tab」（原始资料 / 规则卡 / 案例窗）——不引入 lumen 的多知识库模型（单一 Brooks 知识域，多库+权限是过度设计）。原始资料 Tab 从「卡片栅格」改为**表格为主 + 详情抽屉**（lumen 同款；文件量增长后表格效率高于卡片）：

```
┌──────────────────────────────────────────────────────────────┐
│ 知识库   [原始资料] [规则卡] [案例窗]        [+ 上传] [批量导入▾]│
├──────────────────────────────────────────────────────────────┤
│ 搜索框(250ms防抖)  状态筛选▾  来源等级▾  访问级别▾   共 N 个文档 │
│ □ 全选 │ 文件名 │ 大小 │ 来源/访问 │ 状态(含进度) │ 上传时间 │ ⋯ │
│ □ …    │ …(类型角标+文件名，成功态可点击开抽屉)                  │
│ □ …    │ …   解析中·第 42/108 页 ▓▓▓▓░░  [日志]               │
│ □ …    │ …   失败(超时)  ←徽章可点，开解析日志  [重试]          │
├──────────────────────────────────────────────────────────────┤
│ 选中 N 项：[发布] [重新解析] [删除]        已发布版本: v12 ▾   │
└──────────────────────────────────────────────────────────────┘
  抽屉1 原文预览（PDF iframe / MD/TXT 文本；DOCX 下载降级）
  抽屉2 分块预览（分页20/页；向量状态；解析元数据）
  抽屉3 解析日志（按轮次；阶段事件时间线）← 新增
  弹窗1 上传队列（见流程1）           弹窗2 版本历史（见流程5）
```

### 3.3 七个核心交互流程（规格）

**流程 1 · 上传队列对话框**（重构 `ImportZone.tsx` → `UploadDialog.tsx`）
- 入队三道校验（各自报错、带文件名）：格式（pdf/docx/doc/txt/md/html）、大小 ≤50MB、`name+size` 重复（另调后端预检 contentHash）。
- 队列区逐文件行：类型角标+文件名+大小+状态（queued/uploading %/success/error）+ 单文件移除；串行上传；上传中项自动滚动进入视野。
- 元数据区：`sourceTier`（official/book/community）与 `access`（public/purchase/member）两个下拉（修 G3），旁注文案「访问级别当前不参与检索过滤，发布后所有用户可在引用中看到」直至 §4.6 决策落地。
- 底部三钮：取消（= 回滚：abort 进行中 + 调 DELETE 清已传文档）/ 开始上传（有排队项才可用）/ 完成（有成功且无失败无进行中才可用）。
- URL 导入与 manifest 导入从本对话框第二个 Tab 进入（manifest 见流程 6）。

**流程 2 · 差异轮询**（替换 `AdminKnowledgePage.tsx:36-41` 的 3s 全量轮询）
- 存在 `uploaded/parsing/parsed/chunked/indexed` 文档时：每 2s 调新增轻量端点 `GET /api/admin/knowledge/documents/statuses?ids=…`（只回 id/status/pageNo/totalPages/errorCode）；
- 检测到任一状态翻转才全量 `load()` 一次；全部终态自动停；轮询失败静默待下轮；
- 任何操作（上传/重解析/发布）后 1.5s 补刷一次（覆盖 pending→parsing 亚秒窗口）；
- `statuses` 端点发现 `uploaded` 停留 >60s 且 worker 心跳缺失 → 列表顶部黄条「解析队列不可用：worker 未运行」（修 G6，worker 心跳见 §4.3）。

**流程 3 · 失败下钻**（新增 `ParseLogDrawer.tsx`）
- 入口：表格中失败徽章/「日志」按钮直接打开（失败原因 hover 即见 error 摘要）；
- 内容按轮次组织（每次 reparse 新轮次）：头部「第 N 次解析 · 结果 · 开始时间 · 总耗时」，下方阶段事件时间线（§2.1 stage 枚举：enqueued→model_loading→parsing(page i/N)→chunking→embedding→completed/failed），每事件带耗时与错误码；failed 事件红色；
- 数据源：`GET /api/admin/knowledge/documents/:id/events`（§4.3 事件表）。旧文档（改造前产生）无事件 → 显示「该文档在事件记录启用前导入，无历史日志」。

**流程 4 · 删除（单个/批量）**（修 G2）
- 单删：确认模态「删除后无法恢复，该文档的分块、向量与原始文件将一并移除，当前发布版本将立即更新为不含该文档」；
- 批量删：解析中的文档额外明示「所选 N 个文档正在解析中，将取消任务并强制删除」（M5 原则）；
- 结果汇报部分失败：「成功 N · 失败 M（原因列表）」；
- 服务端级联见 §4.3；删除后自动 `load()`。

**流程 5 · 版本历史与回滚**（修 G5）
- 入口：底栏「已发布版本 vN ▾」→ 弹窗列出全部 `knowledge_versions`（版本号/时间/包含文档数/触发人）；
- 当前版本标记「生效中」；任一历史版本行「切回此版本」→ 确认文案「将以旧集合发布新版本 vN+1，不修改历史记录」（红线 2 的语义）；
- 实现：新增 `POST /api/admin/knowledge/versions/:id/restore`。

**流程 6 · manifest 批量导入**（修 G1）
- 独立弹窗：展示 `knowledge_manifest_entries` 全部条目（文件名/URL/状态/lastError），支持「从默认清单重新同步」（读 `docs/references/knowledge-source-manifest.json` 入库）与单条重试；
- 导入按钮改为对勾选条目提交（后端端点不变，前端修 entries 传参即修 400 坏死）。

**流程 7 · 用户侧引用可跳原文（P2，独立于管理端；v2：安全强化）**
- `GET /api/research/runs/:id/evidence` 增加 `fileUrl` 与 `contentHash`；**fileUrl 指向鉴权读取端点**（会话签名/一次性令牌，按当前 access 判权——purchase/member 按方案甲对普通用户返回约定不可用状态，非裸静态路径）；
- 前端复用 `PreviewDrawer` 的 PDF iframe 逻辑做只读版，**iframe 加 `sandbox` 与 CSP 限制**（现有管理端预览 iframe 无 sandbox，不宜直接扩展给用户端）；引用定位带 `contentHash`，与当前文档指纹不一致时不高亮并提示「文档已更新，定位可能失效」（M6）；
- **HTML 原文与 `tableHtml` 预览经净化后渲染**（服务端白名单或 DOMPurify），隔离注入面；
- 聊天侧引用从纯文本升级为可点击角标属另一工单，本方案只预留契约。

### 3.4 组件清单

| 组件 | 动作 | 说明 |
|---|---|---|
| `UploadDialog.tsx` | 重构（替代 ImportZone） | 流程 1；含 URL/manifest Tab |
| `DocumentTable.tsx` | 新增（替代 DocGrid 的文档栅格） | 表格+多选+筛选+批量栏；状态列含进度与失败入口 |
| `ParseLogDrawer.tsx` | 新增 | 流程 3 |
| `VersionHistoryDialog.tsx` | 新增 | 流程 5 |
| `ManifestDialog.tsx` | 新增 | 流程 6 |
| `PreviewDrawer.tsx` | 保留增强 | 增加第三个页签「解析日志」（复用 ParseLogDrawer 内容） |
| `SearchDebugPanel.tsx` | 保留 | 现状已是好设计，不动 |
| `RuleCardsPanel/CasesPanel` | 小改 | Cases 补「下架」按钮（修 G4）；其余不动 |
| `hooks/useDocPolling.ts`、`hooks/useUploadQueue.ts` | 新增 | 流程 1/2 的可复用逻辑 |

---

## 4. 代码架构改造

### 4.1 前端（`web/src/admin/knowledge/`）

- 新目录结构：`components/`（§3.4 组件）+ `hooks/`（轮询/上传队列）+ `api.ts`（集中 fetch，带 AbortController + 请求序号防竞态——lumen 工程细节）。
- 所有列表/筛选状态同步进 URL（`?status=&q=&page=`），刷新可保持（lumen 同款）。
- i18n：新文案中英双语走既有九命名空间（`check:i18n` 必须过）。

### 4.2 后端 API 变更表（`server/src/knowledge/routes.ts`）

| 端点 | 动作 | 说明 |
|---|---|---|
| `DELETE /api/admin/knowledge/documents/:id` | 新增 | 级联删除；`?force=1` 取消进行中任务再删 |
| `GET …/documents/statuses?ids=` | 新增 | 轻量状态批量端点（流程 2） |
| `GET …/documents/:id/events` | 新增 | 解析事件流（流程 3） |
| `POST …/documents/batch-publish`、`batch-reparse`、`batch-delete` | 新增 | 批量操作，返回 `{succeeded[], failed[]}` |
| `GET …/versions` | 新增 | 版本历史列表 |
| `POST …/versions/:id/restore` | 新增 | 旧集合发布新版本（红线 2） |
| `POST …/cases/:id/unpublish` | 新增 | 接通既有 `setCasePublished(false)`（修 G4） |
| `POST …/documents/import-manifest` | 修 | 前端修 entries 传参；后端不变 |
| `POST …/documents`（上传） | 小改 | 接收 sourceTier/access 参数（修 G3）+ 上传预检（重复 contentHash 提前报） |
| `GET /api/research/runs/:id/evidence` | 小改（P2） | 增加 fileUrl/contentHash（红线 8：只增字段） |

### 4.3 数据库与存储（`server/src/models.ts` + `store.ts`；v2：删除语义两段式重构）

- **删除改为两段式（v2 替换原硬删除设计）**：
  - **默认操作=「移出当前发布集合 + 归档标记」**：生成不含该文档的新版本（与回滚同骨架，红线 2），文档行标记 `archived`（chunks/blob **保留**，管理页可查归档清单）——保住历史版本的可恢复性与冻结引用的追溯面；
  - **彻底清除=独立流程**（归档 N 天后由清理任务执行，或管理员显式触发）：**DB 删除标记 + 异步清理任务**（PostgreSQL 事务不能保证 MinIO 删除原子性——不做事务内假设）；清理任务**幂等可重跑、逐项成功标记，部分失败不误报完成**（清理状态表）；
  - **彻底清除后的保留规则（v2）**：冻结证据快照**自包含**（保留必要的标题/版本/指纹/文本，不依赖已删文档行回查）；原文入口显示「已清除」并返回约定不可用状态码；**历史版本恢复由服务端校验**（含已归档/已清除文档的版本拒绝恢复，不只 UI 禁用）；元数据保留范围=审计与证据追溯所需最小集。
- **新表 `knowledge_parse_events`**：`(id, docId, attemptId, runNo, seq, stage, message, errorCode?, durationMs?, createdAt)`，索引 `(docId, attemptId, seq)`；worker 在 §2.1 每个 stage 转换时插入；保留策略：每文档保留最近 5 个轮次（attemptId 语义见 rag-pipeline-design §4.3）。
- **worker 心跳**：复用 pg-boss 或新表 `knowledge_worker_heartbeat`（一行一 worker，每 30s 更新）；statuses 端点聚合判断「队列不可用」。
- 迁移文件：新增 drizzle 迁移（0000+ 序列续号），只加表不改建。

### 4.4 research-py（`research-py/app/`）

- 新增 `parsing_async.py`：任务注册表 + 分批转换 + 进度事件回调；`main.py` 注册两个新端点（§2.1）；`/health` 增加 `doclingWarmed`。
- Dockerfile：WITH_DOCLING=1 分支构建期预置模型 + 设置 `DOCLING_ARTIFACTS_PATH`。
- schemas.py 新增 `ParseAsyncRequest/ParseStatusResponse`（与 shared 契约同步）。

### 4.5 shared 契约（`shared/src/contract/knowledge.ts`）

- 新增：文档状态轻量投影类型、stage 枚举、errorCode 枚举、事件/版本历史/批量结果类型；只增不改（红线 6/8）。

### 4.6 access 参与检索过滤（v2：已拍板方案甲，实施前置至 W1-A）

**2026-10-21 用户已拍板：方案甲（参与过滤）**——purchase/member 资料对普通用户不可见（superadmin 例外），符合字面语义。

**实施前置至 W1（首次发布受限资料之前生效，v2 调整）**：过滤范围远超「一处 WHERE」——统一权限上下文贯穿词项召回、向量召回、规则卡/案例伪 chunk、邻接扩展、普通对话、研究 worker 证据组装六条路径，受限内容在送入 LLM 前过滤；管理员例外由服务端判定（不信任客户端传入角色）；权限上下文在用户调用链上必填（缺失=拒绝或按普通用户处理）。历史快照语义与派生内容联动规则见 unified-roadmap W1-A。本节原「retrieval 一处 WHERE」的表述作废。

---

## 5. 分阶段实施计划

> 每阶段独立可发版、可验收；阶段间只允许向前依赖。

### 阶段 0 · 环境修复（v2：三项已完成校准）

- [x] VPS `docker image prune -a`（**已完成 2026-10-21**：91%→28%，回收 16.2GB+发版后清理）
- [x] VPS 升级套餐 2C2G → 2C4G/70G（**已完成 2026-10-21 用户操作并核实**：MemTotal 3723MB 符合 4GB 规格、70G 盘与文件系统扩容生效）
- [x] 本地 research-py 镜像 WITH_DOCLING=1 重建（**W0 已实配**：构建参数写进根 docker-compose.yml 的 `build.args`，`docker compose build research-py` 即带 Docling，不再依赖脚本/注释自律；验收含实际小文档解析走通，不只看 health）
- 验收（已完成项按实际记录）：`df -h /` 28%；`free -m` MemTotal 3723MB；本地 health + 小文档解析（W0 执行记录见 unified-roadmap）

### 阶段 1 · 解析链路 P0（2-3 天）
- [ ] research-py 异步任务端点 + 分批 + 事件（§2.1/2.2）
- [ ] Node 侧 pipeline 接异步 + 15min 预算 + errorCode 落库（§2.1/2.4）
- [ ] `knowledge_parse_events` 表 + worker 写入（§4.3）
- [ ] Docling 空结果 `empty_text` 检查（§2.4）
- [ ] Dockerfile 模型预置 + compose mem_limit（§2.2/2.3）
- 验收：**本 Brooks PDF（108 页）在线上从 uploaded 到 indexed 全程成功**，期间 app/postgres 无 OOM，事件表可见逐批进度

### 阶段 2 · UI 坏死修复 P0（2 天）
- [ ] manifest 导入修正 + ManifestDialog（G1）
- [ ] 文档删除端点 + 级联 + 前端确认流（G2）
- [ ] 上传 sourceTier/access 选择（G3）
- [ ] 案例 unpublish（G4）
- 验收：§6 清单 T2-T6

### 阶段 3 · 交互升级 P1（3 天）
- [x] UploadDialog 队列化 + 放弃回滚（流程 1；W2 第三批实现——三道校验+precheck 预检+串行 XHR 进度+取消=abort+purge 回滚；URL/清单同窗 Tab）
- [x] statuses 轻量端点 + 差异轮询 + worker 心跳黄条（流程 2，G6/G8；W2 第二批实现）
- [x] ParseLogDrawer 失败下钻（流程 3，G7；W2 第二批实现）
- [x] 批量操作 + 部分失败汇报（流程 4/6，G9；W2 第一批实现）
- [x] 版本历史与回滚（流程 5，G5；W2 第二批实现）
- [x] ManifestDialog 独立弹窗（流程 6，修 G1；W2 第三批实现——GET/POST manifest-entries 端点+重新同步保留状态+单条重试+勾选导入）
- 验收：§6 清单 T7-T12

### 阶段 4 · 用户侧透明 P2（2 天，可独立排期）
- [x] evidence 加 fileUrl + contentHash；只读原文预览（流程 7；W2 第三批实现——只增 docId/contentHash/fileUrl/docUpdated 四字段+鉴权文件端点（受限 403/清除 404）+iframe sandbox 与服务端 CSP sandbox 双层+docUpdated 不定位提示；投影纯函数双侧断言入 smoke）
- [x] access 过滤决策落地（§4.6 拍板后实施；已前置 W1-A v0.9.7 verified）
- 验收：§6 清单 T13-T14（聊天侧引用角标化属另一工单，契约已预留）

### 与 admin 拆分的关系（v2：并入统一路线）

本方案对应统一路线（`docs/unified-roadmap.md`）的 W1-B/W2，先于 W3 拆分执行；全部新组件自包含于 `web/src/admin/knowledge/`（不新增对主站 Header 等用户组件的依赖），W3-S1 双构建时知识库组件树随 admin-web 整体迁移（同源码双构建，迁移成本≈0）。§4.2 端点天然属于未来的 admin-api 入口，无返工。

### 与正式 spec 的同步（v2 新增）

W2 实施时同步 `docs/specs/ui.md`（交互变更）与 `docs/specs/knowledge-rag.md`（API 契约/删除语义/事件表），以实际提交的代码为准更新。

---

## 6. 验收清单（逐条勾选）

**T1 解析（阶段 1 核心，硬性）**
- [ ] 《How to trade price action manual.pdf》线上完整走通 uploaded→indexed→published；chunkCount > 200；embedded > 200；pageCount = 108
- [ ] 解析过程事件表可见 `parsing(page 20/108)` 等逐批进度；总耗时 < 15min
- [ ] 解析期间 postgres/app 容器无重启；research-py 内存峰值 ≤ 1.5G（mem_limit 内）
- [ ] 同一文件在本地环境同样走通（health docling:true）
- [ ] 人为 kill research-py：文档置 failed 且 errorCode=service_down，重试可恢复

**T2-T6 阶段 2**
- [ ] manifest 弹窗能展示全部条目状态；对勾选条目导入成功；不再出现 400 坏死
- [ ] 删除一篇已发布文档：chunks（所有版本）、blob 对象、manifest 关联 SQL 查询零残留；当前 knowledge_versions 自动更新为不含它的新版本；研究结果里旧引用仍可渲染（不可变版本语义未破坏）
- [ ] 上传可选 sourceTier×access 全组合
- [ ] 案例可下架；下架后 as-of 检索按发布历史正确排除
- [ ] 删除解析中文档需确认「强制删除」文案且实际取消任务

**T7-T12 阶段 3**
- [ ] 上传 3 个文件中途点取消：已传文档被回滚，列表无半传残留
- [ ] 存在解析中文档时网络面板只见 statuses 轻量请求（2s 一次）；全部终态后轮询停止
- [ ] 停掉 worker：列表 60s 内出现「解析队列不可用」黄条
- [ ] 失败文档点击徽章打开日志抽屉：能看到轮次、stage 时间线、错误码
- [ ] 批量发布 3 个文档（1 个失败）：汇报「成功 2 · 失败 1（原因）」
- [ ] 版本历史可见全部版本；切回 v11 实际生成 v12（集合=v11），v12 原记录未变
- [ ] 筛选/搜索/页码刷新后保持（URL 同步）
- [ ] `pnpm check:i18n` 通过；新旧文档在表格中均正常渲染

**T13-T14 阶段 4**
- [ ] 普通用户打开研究结果证据，可点击查看 public 文档 PDF 原文对应页
- [ ] 重解析某文档后，旧引用定位提示「文档已更新」而非错误高亮（contentHash 防御）
- [ ] purchase/member 资料按 §4.6 拍板结果行为一致（过滤或明示），有双侧用例

**全局回归**
- [ ] `pnpm typecheck && pnpm knowledge:smoke && pnpm vector:smoke` 全绿
- [ ] 既有 67 条评测不回退（`research evals`）
- [ ] 阶段 1 上线后连续导入 3 本不同 PDF 无一 failed

---

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 2C4G 未升级就发阶段 1 | 阶段 1 发版前置检查：`free -m` total ≥ 3.5G 才允许启用整书解析，否则 Node 侧按页数阈值拒绝（≤30 页） |
| 带模型的新镜像过大（+1-2GB）导致 VPS 磁盘再紧张 | 阶段 0 先 prune；发版后监控磁盘；GHCR 分层缓存让后续版本增量小 |
| 异步任务在 Python 重启后丢失 | 文档状态仍由 Node 侧 DB 持有；任务丢失=文档停留 parsing→超时置 failed 可重试（与现状语义一致） |
| 删除级联遗漏导致孤儿 | 验收 T2 的 SQL 断言（chunks/blob/manifest/版本引用四查）+ `scripts/knowledge-smoke.ts` 补删除用例 |
| 差异轮询引入新端点被滥用 | statuses 端点限 superadmin、单次 ids ≤ 100、响应 < 2KB |
| 旧文档无事件数据 | ParseLogDrawer 明示「事件记录启用前导入，无日志」降级文案 |

---

## 附：本次诊断时间线（供追溯）

1. 检查 PDF 本体：108 页/2.2MB/未加密/Word 2013 数字版；pdftotext 提取 14.3 万字符 → 排除文件问题。
2. 本地 `health` → `docling:false` → 本地镜像无 Docling（根因一）。
3. 构造该书 payload 直打线上 `/tasks/parse-document`：280s 无响应（curl_exit=28），容器内存 389MB→1.15GiB（根因二+三）。
4. 重启线上 research-py 恢复（health docling:true，内存回落）。诊断后环境已还原干净。
