# 统一执行路线（知识库重构 + 双系统拆分）

> 版本 v1 · 2026-10-21 定稿（经三轮方案评审）· 本文是**总控文档**：定顺序、去重已完成项、合并验收基准。
> 三份详设文档为本路线的实施依据：`docs/rag-pipeline-design.md`（v2，解析管线）、`docs/knowledge-ui-redesign-plan.md`（v2，知识库 UI）、`docs/admin-isolation-plan.md`（§3 v2，双系统拆分）。

## 0. 决策定案（用户已拍板，2026-10-21）

1. **总顺序**：知识库先行（W1 → W2 → W3）——Brooks PDF 导入是最直接价值；拆分迁移期冻结功能开发放最后；知识库 UI 组件自包含（`web/src/admin/knowledge/` 内不新增对主站组件依赖），W3-S1 随 admin-web 整体迁移（同源码双构建，无返工）。
2. **VPS**：已升配 2C4G/70G（2026-10-21 用户操作；核实记录：MemTotal 3723MB 符合 4GB 规格、磁盘 70G/文件系统扩容生效）。
3. **access 语义**：方案甲（参与检索过滤），前置至 W1-A 实施（详见下）。

## 0.1 状态标记规范

每阶段以三项标记推进：**planned**（未实施）/ **implemented**（代码已提交）/ **verified**（验收通过并留有执行记录）。标记以实际提交与验收证据为准更新，不接受预置表述。

## 1. 路线总览

| 阶段 | 范围 | 详设依据 | 状态 |
|---|---|---|---|
| W0 | 已知缺陷修复 + 环境核验 + 文档修订 | 本文档 §2 | implemented（验收见 §4） |
| W1-A | 知识库权限底座（access 甲，六路径统一上下文） | 本文档 §3；UI 方案 §4.6 v2 | **verified**（v0.9.7，PR#14：22 项双侧用例+线上验收） |
| W1-B | 解析管线 R1+R2（九步/异步/OCR/headingPath fallback） | rag-pipeline §4-§7 v2 | **implemented**（v0.10.2~v0.12.2，PR#16-#33：Brooks 108 页 indexed 306s/192 chunks；OCR 链路+预检路由+headingPath 启发式已上线；headingPath 对自由格式书籍受限、parseMeta 持久化待 W2） |
| W2 | 知识库交互（两段式删除/队列上传/差异轮询/日志下钻/批量/版本回滚/用户侧原文） | UI 方案 §3-§5 v2 | **implemented（第一批 v0.14.0：两段式删除/批量/来源访问选择器/案例下架/七端点；第二批：差异轮询+worker 心跳黄条/ParseLogDrawer/版本历史回滚——事件存 parseMeta.events 单轮覆盖（§4.3 独立事件表按证据作废）；第三批：UploadDialog 队列化（三道校验+precheck 预检+串行进度+取消回滚）/ManifestDialog（条目状态/重新同步/单条重试/勾选导入，修 G1）/用户侧原文（evidence 增 fileUrl/contentHash/docUpdated 只增字段+鉴权文件端点+CSP sandbox 双层防线+只读预览弹窗，流程 7 落地；smoke 12 项双侧断言入 gate） |
| W3 | 双系统拆分：S1 双构建 → S2 存储配置收敛 → S3 切流 → S4 分权 | admin-isolation §3 v2 | **S1 implemented**（v0.15.0 PR#44：shared-ui 下沉+双构建 dist/dist-admin+单入口双产品托管+admin 域名根 302；用户产物零 admin chunk； **S2 implemented**（users/sessions 切 PG fail-closed+会话用途标记拒跨用途+存量会话失效重登+限速入 PG 重启不丢+迁移分离 migrate 容器+AI 配置共享卷+版本号契约；回归 25 项钉住；❗限速保存必须 await，fire-and-forget 并发 upsert 会丢锁定）→ **S3 implemented**（adminApi.ts 独立入口+user-api 管理注册全移+双容器 3200/3201+入口=进程登录分离；❗clientIp 双进程必须共享实现、loginGuard 读必须直查 PG——内存缓存互不可见漏判锁定）→ S4 分权 |

W1-A 先于 W1-B 的发布节点：**首次发布受限资料（purchase/member）之前权限过滤必须生效**。R2（扫描版/离线通道）、R3（LLM 增强，默认关、评测后拍板）按 rag-pipeline §7 排 W1 之后。

## 2. W0 · 已知缺陷修复 + 环境核验（本阶段已完成的工作记录）

**四项缺陷（2026-10-21 二/三轮审查）**：
1. AI 保存/清空补迁 `/api/admin/ai/config`（commit `b855035`）
2. 登录入口拒绝与密码错误同构（`b855035` failLogin 统一出口）+ **验证前预检**（本 PR：`loginPrecheck` 在 scrypt 之前按用户名拒错误入口，server 端不执行密码校验；断言=单元 E 组 roleOf 桩 + HTTP 层 R4b 日志证据「密码校验未执行」）
3. 知识库轮询覆盖 `uploaded/parsing/parsed/chunked`（`b855035`）
4. 自测失败退出移至全部组之后（`b855035`；本 PR 补 E 组后共 35 项）

**登录回归隔离条款（定稿表述）**：登录回归使用独立临时数据目录、独立测试数据库和自建凭据；退出时清理资源，不读写开发或生产数据（`b855035` 实现达标：BV_DATA_DIR=mkdtemp + 独立库 bv_login_regression DROP/CREATE/退出 DROP + 随机强密码测试超管）。

**环境核验（2026-10-21 记录）**：MemTotal 3723MB / MemAvailable 2645MB；磁盘 vda 70G、文件系统 69G、使用 28%；五容器健康。构建参数 `WITH_DOCLING=1` **实配进根 docker-compose.yml 的 `build.args`**（`docker compose build research-py` 即带 Docling；本地镜像已重建成功，需宿主代理 build-arg 时用 `docker compose build research-py --build-arg http_proxy=http://host.docker.internal:7897 --build-arg https_proxy=...`）。**实际小文档解析验证在生产链路完成**（v0.9.6 线上 research-py Docling 真实解析 PDF 返回完整 blocks）；本地 health `docling:true` 已达，但本地完整解析暂被「Docling 模型运行时从 HF Hub 下载（构建期未预置、缓存不在 research-models 卷内）」阻塞——模型预置 + `DOCLING_ARTIFACTS_PATH` 指向持久卷是 W1-B R1 的既有任务，届时本地一并解决。

## 3. W1-A · 知识库权限底座（详设要点；实施细案在 W0 交付时展开）

- 服务端构造 `KnowledgeAccessContext`（viewerRole 服务端判定，不信任客户端）；**用户调用链上必填，缺失=拒绝或按普通用户处理**。
- 过滤六路径：词项召回、向量召回、规则卡/案例伪 chunk、邻接扩展、普通对话（conversation.ts）、研究 worker 证据组装；**受限内容在送入 LLM 前过滤**。
- **历史快照语义（定稿）**：冻结快照保留，只允许原研究所有者依据冻结时的授权读取；原文按当前权限访问；历史快照不得作为新检索、新研究或自动构造 LLM 上下文时绕过当前权限的来源。
- **派生内容联动**：源资料后来改为受限时，已有派生规则卡/案例同步重新受限（读取时按源文档当前 access 联动判定，不只发布时检查）。
- 验收入可执行 gate（`knowledge:access-check` 或并入既有自测）：真合法放行+伪装拦截双侧用例。

## 4. 验收基准

- **以各阶段实际修订并提交的文档为准**；未实施阶段保持 planned，实施完成后标 implemented，验收通过后标 verified。
- W0 验收：`pnpm admin:gate-check`（35 项）+ `pnpm login:regression`（15 项，含 R4b）+ 完整 `pnpm release:gate`（**发版不允许 `GATE_SKIP_DB=1` 跳过登录回归**）；本地 health `docling:true` + 实际小文档解析走通；线上部署后主站超管登录 401 同构且无「登录成功」日志。
- W1 验收：rag-pipeline §7 R1 v2 清单（含页覆盖/批次边界/失败恢复/两角色评测）+ 权限六路径双侧用例入 gate。
- W2 验收：UI 方案 §6 T2-T14（删除条款按两段式新语义）；`check:i18n` 过；同步 `docs/specs/ui.md` 与 `knowledge-rag.md`。
- W3 验收：admin-isolation §3.5 v2 清单（含回滚演练与会话用途标记）。

## 5. 实施纪律（三轮评审定稿）

1. 每阶段独立 PR + tag 发版；release:gate 全绿 → CI 绿 → 用户不在线窗口部署 → 验收 → `docker image prune -a`。
2. 三份文档 8+5 条红线（检索内核不动/不可变版本/删除级联语义/契约只增/research-py 固定端点/状态机只加不改/引用快照兼容等）全程有效。
3. 实施中若发现具体接口、数据库迁移或资源限制与方案不符，**针对证据调整该点，不反复扩大方案范围**。

## 6. 已完成项校准表（截至 2026-10-21，避免重复实施）

| 项 | 状态 | 备注 |
|---|---|---|
| VPS 磁盘清理（91%→28%） | verified | 2026-10-21 |
| admin 域名隔离 + 主站入口删除 + 审查三缺口修复 | verified | v0.9.3~v0.9.5 |
| 四项登录/AI/轮询/自测缺陷 | implemented（本 PR verified） | b855035 + 本 PR 预检重做 |
| manifest 导入止血（简版） | verified | v0.9.5；W2 升级完整 ManifestDialog |
| 轮询止血（uploaded） | verified | v0.9.5；W2 升级差异轮询+statuses 端点 |
| VPS 升配 2C4G/70G | verified | MemTotal 3723MB / 70G 盘 |
| compose 构建参数 WITH_DOCLING 实配 | implemented（本 PR） | `docker compose build research-py` 即生效 |
| 登录回归测试隔离 | verified | b855035 + 本 PR R4b（共 15 项） |
| W1-A 权限底座 | verified（v0.9.7） | access.ts + 检索层一处双路过滤 + 规则卡 citations 派生联动 + fetchCitation 判权 + 六路径接线；knowledge:access-check 22 项入 gate（真实 LLM 草拟 citations 联动验证） |
