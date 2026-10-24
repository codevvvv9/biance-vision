# 管理端组件化迁移与验收

独立部分已实现；**W4 管理首页整合 pending，整个重构尚未标记 verified，也未发布生产版本**。

## 交付边界与审核结论

采用 React/Vite 内的 Ant Design 组件体系，不迁移框架。管理端登录采用本次已选定的克制视觉：复用品牌资源和色彩，取消星空、流光与磁吸动效。主站登录不改动。

本次审核的七项建议均纳入实现：

1. 基础壳层形成独立提交，可单独交付 patch；不等待 W4。每一批仍须通过自身 CI、门禁和上线前检查，不能把“完成第三步”直接当成发布授权或验收结论。
2. 每批交付前 fetch 并同步 origin/main；长于一周时至少每周同步一次、重跑回归。只消费已提交代码，不搬运其他会话的工作区文件。
3. 两个 Vite 构建检查 Rollup 实际模块图，违规直接失败；CI 常驻执行，并测试 pnpm、普通 node_modules 和 Windows 路径。用户构建拒绝 Ant Design 和管理端功能代码；管理构建拒绝用户 Provider、AiContext、Header 与完整用户样式入口。
4. deploy/vps/Caddyfile 与 deploy/oracle/Caddyfile 的管理域代理落仓为 3201；用户域仍为 3200。没有纳入 W4 未提交的官网部署修改。
5. ConfigProvider 同时配置 zh_CN/en_US 组件 locale 和中英文应用词典。英文词典沿用仓库 en-US。
6. 五个领域页面已经迁出兼容边界；兼容样式只保留冻结的管理首页。过渡期间不做旧首页的审美微调。
7. 通过 npm 注册表核验并精确锁定 antd 6.6.7、@ant-design/icons 6.3.4。React 18.3.1 与现有 React Router 版本保留。安装不追随未经验证的新版本。

独立工作树中操作，未修改主工作区的 W4 文件。W4 是否完成以其提交合并为准，不能以工作区已有新面板判断已完成。

## 已实现的模块边界

- 装配层：主题、认证边界、数据路由、功能注册、全局 AI 设置弹层。路由、菜单、标题和选中状态由注册表及 React Router 匹配派生；basename 读取 Vite BASE_URL。
- AdminShell：只消费展示参数和动作回调；不导入页面或请求业务接口。
- 领域模块：知识库、研究/旧版 AI 会话、Agent 能力/版本、提示词/文案/输入配置、评测/数据集/模型。API 函数、数据生命周期和视图分工，不建立万能 CRUD 或事件总线。
- 管理端 UI：CSS Modules、通用反馈、URL 查询标签、未保存表单保护、统一 Portal。Ant Design 消息和确认框使用 App 上下文。
- AI 设置与用户端 AiContext 解耦。保存通过明确回调更新装配层 revision，再经 Outlet 参数刷新相关 AI 展示。
- 用户端仅将原有色彩变量原样抽到 tokens.css，base.css 继续消费它。管理端只导入这些共享 Token，使用自己的文档 reset、内容排版和布局，不导入用户端样式集合。
- 轮询等待上次请求完成后再排下一次；卸载清理定时器，旧响应按序号和组件生命周期丢弃。退出、切换账号、401 卸载业务子树。

## 页面与接口保真清单

| 页面 | view 参数 | 保留的操作与契约 |
| --- | --- | --- |
| 知识库 | documents / rules / cases / search | 文件格式/50MB/队列内判重/hash 预检、串行 XHR 进度、取消及明确返回新建 ID 的回滚、URL 导入、受限清单禁选、部分失败、差异轮询、解析事件、原文/分块/全文、发布/重解析/归档/清除、版本恢复、来源页码/图号、规则卡审核、案例可见上下文、双路检索调试 |
| AI 会话 | research / legacy | 用户→会话→详情分层、完整消息和结构卡字段、运行引用、旧版档案/记忆/系统提示词只读展示；账号与会话快速切换互不串数据 |
| Agent | capabilities / versions | 五类能力配置及连通测试、草稿创建/编辑、发布/回滚、当前版本对照、调试运行；能力接口失败不阻断版本管理 |
| 提示词与文案 | templates / copy / input | 现有模板名与场景、草稿内容编辑、版本发布/回滚/差异、研究文案及输入 JSON 配置；只提交原接口支持的字段 |
| 评测与模型 | runs / datasets / models | 数据集创建、评测确认/运行/报告、模型健康状态、训练参数与研究期限提示；状态使用各自领域的展示映射 |
| 管理首页 | 待 W4 合并 | 当前已提交版本维持兼容；人工开通、凭据交付、权限额度、官网设置须随 W4 整合后逐项验收 |

原文 blob URL 在切换标签时保留，卸载时回收；HTML 原文在 sandbox iframe 中展示。规则卡编辑覆盖全部内容字段，避免模板占位字段无法补全而永远不能发布。完整资料统计从完整接口结果计算，筛选不改变统计基数。

本轮不修改服务端 API、数据库迁移、权限规则、队列或业务计算。文件取消回滚沿用现有契约，只删除本次明确返回的新文档 ID，不删除服务端判重命中的既有文档；网络中断时未知的服务端结果不能声称已验证回滚。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm --filter biance-vision-brooks build
BV_ADMIN_API_TARGET=http://127.0.0.1:3201 pnpm --dir web dev:admin
pnpm --dir web build
pnpm --dir web test:admin
pnpm check:i18n
pnpm admin:gate-check
pnpm login:regression
pnpm release:gate
```

管理端开发及预览的 `/admin/`、深链均由 admin.html 进入。API 目标必须显式配置，转发业务请求前核验 health.entry=admin-api；误指 user-api 时返回 502，禁止回落。

Playwright 使用受控接口，不访问生产数据。覆盖导航、深链、前后退、认证、禁入、locale、未保存确认、表单请求体、部分失败、上传回滚、清单访问规则、原文 URL 生命周期、竞态、轮询停止和五档视口。截图等待加载结束后生成。实际双构建输出 build-modules.json，CI 同时保存浏览器证据。

完整 release:gate 在独立 PostgreSQL 容器（127.0.0.1:5544）执行；只读复制本地 BTC/ETH 行情作为研究测试前置数据，不对开发库运行迁移、角色同步或测试写入。知识库权限脚本补齐人工审核的测试内容，保留受限源 citations，避免依赖外部 LLM 才能进入权限断言。未放宽发布校验或权限断言。

最终批次结果及截图见本目录 qa 记录。受控浏览器和现有服务端集成检查通过，不等于 W4、新环境真实 Docling/worker 全链路或生产切流已经验收。

## 后续合并与发布

- W4 合并后重新同步基线，整合首页业务标签、开通/权限弹层及品牌资源；保留凭据交付与额度行为，再移除首页兼容规则。
- 最终上线前完成真实隔离环境的业务流程验收及 W4 清单。生产仅做登录、导航、只读展示检查。
- 既有 v0.16.2 不覆盖。发布时选择下一可用 patch，记录旧管理镜像 digest、有效 Compose 和本次不可变镜像。
- 只升级通过本批验收的管理端服务。验证失败恢复原管理镜像，不回滚共享数据库或已合并的 W4 功能。


## Integrated W4 completion (2026-10-24)

The integrated release branch completes the previously pending homepage: users/audit/website URL views, independent provisioning and allowance/password dialogs, dirty-state protection, ephemeral credential delivery and canonical W4 brand resource. The last legacy boundary and stylesheet were removed. All 28 admin browser checks and the complete integrated release gate passed locally. R3 knowledge enhancement is configured independently from model-provider capabilities. See docs/releases/v0.17.2-integration.md for current integration and deployment evidence; earlier pending-W4 descriptions above document the earlier delivery boundary.
