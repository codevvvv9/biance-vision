# 官网、人工开通与终端入口本地验收记录

> 后续状态更新：本表保留首轮执行结果。GEO 集成后的全仓检查发现旧聊天策略脚本的异步比较类型错误，当前发布状态以 [GEO/SGO QA](website-geo-sgo-qa-2026-10-24.md) 为准，不能沿用本表的全仓通过结论。

日期：2026-10-24。状态：`implemented`，**未部署；完整发布门槛未通过**。

## 域名结论

保留既有用户域名与独立管理域名。官网 `/en`、`/zh`，大盘 `/dashboard`，研究 `/research`，登录 `/login`。Caddy 显式分流 API、工具与资源，默认交给 Next；没有新增用户子域名、DNS 或证书。公开 origin 由构建/运行环境 `WEBSITE_ORIGIN` 注入，不硬编码当前系统地址。完整本地网关为 `deploy/local/Caddyfile`，仅用于验证同源交接。

## 已通过的检查

| 检查 | 结果及边界 |
| --- | --- |
| `pnpm typecheck` | 全仓通过，官网 React 19 与终端 React 18 分开解析 |
| `pnpm build` | shared、server、用户 web、管理 web、Next 官网均通过 |
| `pnpm website:check` | 7 组通过：语言、CIDR、入口草稿、双语内容、登录返回、公开配置验证；含终端独立打包的消费者契约比对 |
| 带用户/管理网关的 `pnpm website:browser-check` | 10 项通过：真实 HTML/404/SEO、安全头、响应式与语言切换、演示与证据、复制失败、无 JS 内容、草稿恢复/冲突/失效/不自动发送、额度耗尽联系入口、管理端联系方式与账号凭据交付。API 为受控响应，不代表真实 AI 验收 |
| `pnpm access:check` | 独立临时数据库与目录，9 组通过：开通、密码哈希、档案绑定、参数/角色/重复拒绝、20 并发只受理 3 次、退额、日限/频率/停用、管理来源校验、续开保留用量、密码重置和跨进程缓存撤销、公开快照版本与敏感字段、Fastify 拦截先于模型处理器 |
| `pnpm login:regression` | 原登录隔离/持久化限速/fail-closed 全量通过；新增直连 user-api 的 login/dashboard/research 200、未知页面/index.html 404、未知 API 未认证 401 |
| `pnpm admin:gate-check` | 全量通过 |
| `pnpm knowledge:access-check` | 全量通过 |
| `pnpm admin:dual-check`、`pnpm db:grants-check` | W3 双入口与数据库分权全量通过 |
| 引擎因果性、自测、产品计算 | 发布门槛内相应检查通过；未改动数值计算及结构规则 |
| Caddy / Compose | 使用 Caddy 容器替换测试 Basic Auth 哈希后 `adapt --validate` 通过；`docker compose config --quiet` 通过 |
| 两个 Docker 构建 | `website/Dockerfile` 和原 app Dockerfile 构建通过；官网 standalone 容器以 node 非 root 用户运行、`GET /en` 为 200 |
| 官网公开快照运行态 | 只读挂载单独测试目录，更新后联系页及 JSON 读取新版、二维码由同一 Telegram URL 生成，损坏快照保留最后有效值；测试未修改真实联系方式 |
| 资源观测 | 本机 Docker 空闲单页后约 35.66 MiB / 512 MiB 限制，官网镜像约 296 MB；仅为本机观测，不能替代 VPS 并发负载、容量和镜像回滚预算验收 |
| 文件与秘密边界 | standalone 文件清单未发现 server/data、用户/会话 JSON 或环境秘密；官网只挂载 website-public 子目录；`git diff --check` 通过 |

本轮浏览器截图已人工检查：

- [英文桌面首页](website-qa/home-desktop.png)
- [中文移动端首页](website-qa/home-mobile.png)

## 未通过与待处理

实际执行完整 `pnpm release:gate`，没有设置 GATE_SKIP_DB：

1. 首次使用本地已有 AI 配置时，`research:smoke` 上游 LLM 超时，随后触发 `budget_exceeded`，门槛停止。
2. 随后使用独立临时 `BV_DATA_DIR` 隔离既有 AI 配置重跑，研究流程多数断言通过，但“八步全部完成”失败。实际步骤序列包含重复的 product_analysis/countercase/synthesis/validate，以及一条 validate:running。具体原因尚未定位，不能用跳过检查或修改期望判为发布成功。
3. 由于门槛首个失败即止，其后的官网/开通检查与构建已**单独运行并通过**；不能因此宣称整套 release gate 全绿。

待完成：研究集成失败定位与重跑、真实模型连通及费用限制验证、真实新账号与 worker 首次研究、实际 Telegram 联系渠道、生产域名 canonical/路由/Cookie/鉴权/SSE/WS/地域拨测、VPS 资源与回滚验证，以及方案约定的五人用户试用。深入 GEO/SGO 文档继续“待审核，尚未实施”，本次仅执行已确认的基础语言与抓取约定。

## 运维约束

- 不执行生产部署、DNS、证书或域名改动。部署批准前先使完整发布门槛通过。
- 管理开通以原 AI 档案体系为基线（最多 8 个档案，每档案最多 20 个绑定用户），新增端点不会悄悄绕过这些既有限制。
- 账号/额度在 PG 事务内写入，AI 档案绑定仍是现有文件式配置，失败有补偿；进程崩溃可能留下无账号的绑定，需要清理，不会生成可登录账号。管理员应在生成后交付并清除凭据；网络中断丢失凭据时可重置密码，不自动重复创建。
- 额度以一次受理入口计数，不代表一次模型内部调用；一个研究任务可能包含多次模型/工具调用，继续受现有 Token、成本和工具预算约束。已受理异步任务/流式响应中途失败仍计次，不能以“结果失败”自动无限退额。
- 搜索 robots 与 noindex 不是保密机制。账号、研究与管理接口依靠会话用途、持久化登录防爆破、来源校验、服务端额度/频率、PG 撤销校验及独立管理入口保护；不承诺完全杜绝自动化抓取。
