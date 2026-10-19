# 新对话工作台 UI 验收记录

日期：2026-10-16。分支：`codex/dev-agent-workbench`。状态：implemented。

## 范围与结果

- `pnpm typecheck`：通过。
- `pnpm build`：通过；产物分别包含 ResearchPage、WorkbenchPage 和按需 WorkbenchChart，未把两套页面同时挂载。
- Chrome 无头浏览器，桌面 1440×960 / 1280×900，手机 390×844：已检查欢迎、会话、输入、右侧引用/图表与移动抽屉。
- 本地真实 API 的未登录页：只请求 `/api/auth/me`，未请求私人会话、持仓、报价或行情。
- 其余登录与研究交互采用浏览器 API fixtures，拦截 `/api/**`，不写真实账号、持仓、报价或研究；结果不等同于模型/worker/数据库端到端验收。

| 用例 | 结果 |
| --- | --- |
| 无 ui、legacy、未知值默认旧版；dev 独立外壳 | 通过 |
| 新版发送仅建一个会话、仅发一条消息、一次 SSE 跟踪 | 通过 |
| step_started/completed 与 run_published 发布后展示结果 | 通过 |
| 切换界面保留 conversation/run，往返不重新发送、不订阅已完成 run | 通过 |
| 引用编号与冻结片段对应；展开、高亮、页码与反证显示 | 通过 |
| 结构点击请求选中 run 的 candles；切历史 run 不显示上一 run 的证据 | 通过 |
| 三场景草稿隔离；teaching/spot、perp/usdm_perp、event/usdm_perp 映射 | 通过 |
| 切场景清理持仓/报价引用；历史结果不随场景变化 | 通过 |
| 登录→开通说明→返回登录→登录成功，恢复模式、草稿、标的、期限 | 通过；修复了登录成功被兜底路由跳回首页的竞争 |
| 发送失败显示错误并恢复草稿；证据失败显式显示 | 通过 |
| 研究执行时锁定场景；取消请求后通过终态轮询释放 | 通过 |
| 持仓工具选择、确认卡 PATCH confirm、退出后清理私人内容 | 通过 |
| 手机会话/资料层，Tab 焦点约束、Escape 关闭与焦点返回 | 通过 |
| 桌面资料栏键盘调整宽度、图表不溢出容器；场景 Home/End 键 | 通过 |

研究失败重试使用原 run 的产品、交易对与期限；不假设原 run 详情中没有提供的持仓/报价字段，也不借用当前输入区关联。真实运行失败、网络故障下完整 SSE 游标重放、长时间运行与行情连续更新仍需真实环境验收。

## 重复执行

启动本项目 web 开发服务（默认 `http://127.0.0.1:17834`）。脚本使用已有 Playwright 安装，不新增生产依赖；若当前 Node 环境可解析 `playwright`，可直接执行：

```sh
node scripts/qa/workbench-ui.mjs
node scripts/qa/workbench-auth.mjs
```

否则通过 `PLAYWRIGHT_MODULE` 指定已安装 Playwright 的 `index.mjs` 绝对路径。可选环境变量：`CHROME_EXECUTABLE`（浏览器路径）、`WORKBENCH_URL`（本地页面 URL）、`WORKBENCH_QA_OUTPUT`（截图目录，默认系统临时目录下 `bv-workbench-qa`）。macOS 默认优先使用已安装的 Google Chrome，其他环境使用 Playwright 的浏览器。

脚本必须针对本地开发/验收页面运行。所有登录与业务 API 均由脚本提供受控响应；正常产品代码不包含 fixture 数据。

## 待真实环境核对

- 已有真实账号登录后发起完整研究，确认模型、检索、校验和发布。
- 实际资料页码/图号与结构时间的业务正确性；概率、费用、EV、快照及结算的数据正确性。
- 真正断网后的 SSE 游标重连、多分钟任务取消/失败重试、长会话持续滚动。

本轮未提交发布或调整后端 Agent 编排，UI spec 保持 implemented。
