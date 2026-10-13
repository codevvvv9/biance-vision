# Admin 与安全

> 状态：partial

> 实现状态（2026-10-01）：agent_versions 落地（草稿→发布不可变→回滚指针，/api/admin/agents/* 全部端点 + debug-run）；五类能力配置经 /api/admin/agents/capabilities 读写（app_settings，Agent 版本发布后以其 config.capabilities 为准）；密钥引用名（secrets.json）已接；发布/回滚/导入/确认均写审计。待办：密钥管理 UI 打码展示细节、secrets.json 编辑界面。

## 目标

定义 Admin 配置域（能力、知识绑定、版本发布）、密钥管理、授权模型与审计范围，保证：可配置的归配置，涉及判定纪律与核心校验的部分不被配置或提示词绕过。

## 已确定决策

- 能力配置五类：`chat / embedding / rerank / vision / search`，各自包含 `provider / baseUrl / model / 限额 / 追加提示词`；未配置的能力在界面与运行状态中显示「待配置」，不静默跳过（例如 `search` 未配置时 `event_researcher` 返回待配置状态）。
- 知识绑定：Agent 版本绑定 `knowledgeVersion` 与检索策略；发布后的版本与绑定关系不可变。
- 版本流：草稿 → 发布（不可变）→ 回滚；已开始的 run 继续使用启动时记录的 `configVersion`，不受后续发布影响。
- 密钥管理：API Key 等密钥保存在本地 `server/data/secrets.json`（已 gitignore、不入库）；界面打码显示；日志脱敏；配置中只以引用名出现，不存明文。
- 授权模型：沿用 `superadmin / user` 两角色起步，多租户细粒度权限不在本轮范围；知识库访问范围由服务端决定，不把内部 token 或权限决定交给浏览器/模型。
- 规则治理：规则参数只能从已注册 schema 中选择取值；任意提示词不能生成并上线可执行规则；服务端核心校验器不被管理员追加提示词覆盖（见 docs/specs/agent-orchestration.md）。
- Brave Search API Key 配置在 `search` 能力项下，存 `secrets.json`，配置中以引用名出现。
- 审计：配置发布、知识发布、预测确认、数据导入全部写 `audit_records`（沿用现有表）。
- 商业书籍/会员资料仅通过用户上传有使用权的文件导入；URL 导入不绕过访问限制（见 docs/specs/knowledge-rag.md）。

## 数据与接口

- `agent_versions`：声明式配置全文（角色定义、工具白名单、提示模板、预算、检索策略、规则参数引用、能力引用名），状态机 draft → published →（rollback 指向历史 published）。
- `knowledge_versions`：知识发布快照，不可变；Agent 版本按 id 绑定。
- `audit_records`：操作者、动作、对象、时间、摘要（沿用 `server/src/audit.ts` 模式）。
- `server/data/secrets.json`：引用名 → 密钥；文件权限最小化，仅服务端进程可读。

### 能力配置字段

| 能力 | 用途 | 关键配置 |
| --- | --- | --- |
| `chat` | 各角色生成与对话 | provider、baseUrl、model、限额、追加提示词 |
| `embedding` | 知识切分向量化 | provider、model、维度（默认 1536 可配） |
| `rerank` | 检索精排（可跳过） | provider、model；未配置时流水线显式跳过并记录 |
| `vision` | 图示/扫描件理解 | provider、model |
| `search` | 事件研究网页搜索 | Brave Search API Key（存 `secrets.json`，配置中写引用名）、白名单、超时、体积上限 |

- API：`/api/admin/agents/*`（版本列表/草稿 CRUD/发布/回滚/调试运行）、`/api/admin/knowledge/*`（文档/导入/发布/search-debug）、`/api/admin/evaluations/*`（数据集/运行/报告）；端点清单见 docs/specs/api-storage.md。全部需 superadmin。

## 流程

1. 配置能力：Admin 在五类能力下填写 provider/baseUrl/model/限额，密钥部分填引用名并实际写入 `secrets.json`；保存后界面显示连通性测试结果，缺失项标「待配置」。
2. 编辑 Agent 版本：新建草稿 → 选择角色、工具白名单、预算、检索策略、绑定 `knowledgeVersion` 与能力引用 → 调试运行（`debug-run`）→ 发布。
3. 发布：生成不可变版本号；此后新 run 使用该版本；进行中的 run 不受影响。
4. 回滚：将「当前发布」指针切回历史版本；历史版本内容本身不被修改。
5. 审计写入：上述发布/回滚、知识发布、预测确认、数据导入逐条落 `audit_records`。

### 审计范围

| 动作 | 记录内容 |
| --- | --- |
| 配置发布 / 回滚 | 操作者、版本号、前后「当前发布」指针 |
| 知识发布 | 操作者、`knowledgeVersion`、文档清单摘要 |
| 预测确认 | 操作者、`predictionId`、确认结果（`user_confirmed`） |
| 数据导入 | 操作者、来源（file/url/manifest）、文档 id 与状态 |

审计记录只增不改；审计查询沿用现有 Admin 审计页模式。

## 边界与失败处理

- 能力未配置：运行到依赖该能力的步骤时返回「待配置」状态并中止该能力分支，不伪造结果（如 rerank 未配置则检索流水线显式跳过精排并记录）。
- 密钥泄露面：`secrets.json` 不出现在任何 API 响应、日志与导出物中；界面只显示打码后的掩码。
- 越权防护：普通用户访问 `/api/admin/*` 一律拒绝；浏览器端不持有任何内部凭证。
- 提示词注入：管理员追加提示词只作用于对应能力的生成环节，不能修改校验器、预算、权限与工具白名单的生效逻辑；外部网页内容按「证据不是指令」处理。
- 配置错配（如引用了不存在的知识版本）：发布时校验拒绝并指明缺失项。
- `secrets.json` 缺失或不可读：依赖密钥的能力显示「待配置」，服务自身仍启动；不得把文件内容写入错误日志。
- 审计写入失败：对应发布/确认操作整体失败并回报，不允许「配置已生效但无审计」的中间态。

### 预算与提示词边界

- 预算（最大调用数/运行时间/费用）随 `agent_versions` 发布冻结，运行中以服务端计数为准；模型输出与追加提示词均不能提高上限。
- 追加提示词的生效范围仅限对应能力的文本生成；工具白名单、校验器、权限与数值计算路径不经过提示词。

## 验收用例

- [ ] 五类能力各有配置项与「待配置」态；未配置 `search` 时事件研究者明确返回待配置。
- [ ] 密钥只存 `server/data/secrets.json`：数据库、API 响应、日志中检索不到明文。
- [ ] 草稿编辑 → 发布 → 新 run 使用新版本、旧 run 仍用启动时版本 → 回滚后新 run 回到历史版本。
- [ ] 已发布版本不可编辑；规则参数下拉只提供已注册 schema 的取值。
- [ ] 管理员追加提示词无法改变校验器判定（用伪造概率数值用例验证仍被拒绝）。
- [ ] 配置发布、知识发布、预测确认、数据导入均能在 `audit_records` 查到。
- [ ] 普通用户调用任一 `/api/admin/*` 端点返回未授权。

## 参考来源

- 仓库内：`server/src/audit.ts`、`server/src/users.ts`、`server/data/`（现有本地数据目录，secrets.json 同置于此并 gitignore）、`server/src/index.ts`（现有 admin 路由守卫模式）、docs/specs/api-storage.md、docs/specs/knowledge-rag.md、docs/specs/agent-orchestration.md、docs/brooks-agent-architecture.md（§10）。
