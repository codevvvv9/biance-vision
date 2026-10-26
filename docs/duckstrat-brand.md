# DuckStrat 品牌与首屏交互

状态：verified（本地实现、浏览器与镜像验收，2026-10-26）。线上版本以发布 tag 与部署检查为准。

## 身份与边界

品牌统一为 **DuckStrat**，主域名 `https://duckstrat.com`，管理入口 `https://admin.duckstrat.com`。
定位为「价格行为与策略研究工作台 / Price action & strategy research workspace」，
承诺为「先避风险，再做判断。 / Navigate risk. Make informed decisions.」。
Duck 寓意灵活闪避风险与认知陷阱，Strat 寓意以证据制定策略；等待确认也是有效结论。
这不代表能消除市场风险；现有研究定位、收益边界、数据来源与地区访问规则继续适用。

公开常量与原创鸭子轮廓集中在 `packages/brand/identity.js`，无框架和环境依赖。
`mark.svg`、官网公开标识及终端公开标识使用同一生成字符串；品牌门禁验证副本一致。
官网 / 登录 / 终端 / 管理端 / 地区限制页 / 账号交付 / 续费 / 默认 AI 身份均使用新名称。
MDX、清单与当前评测问题同步；历史研究、审计、观测基线不改写。
包名、镜像名、数据库、Cookie 与存储键保留兼容性。

## 首屏行为

桌面左文右动画，窄屏文案与按钮在前、动画在后，真实产品演示紧随其下。
原创 SVG 鸭子沿路径绕过「市场噪声 / 过度自信 / 证据不足」，最终展示成立条件、反对证据和失效条件。
叙事约 7 秒，仅自动播放一次。鼠标靠近标签、触控点击、键盘激活提供局部闪避与解释；
暂停和重播按钮独立可用，不移动 CTA、不劫持滚动。

Motion values 驱动位移，弹簧处理反馈，只有阶段变化写入 React state。
LazyMotion 按需加载动画特性；失败不启动叙事，保留服务端输出的静态结尾。
首屏离开视口、文档隐藏或手动暂停时停止推进，回来后从暂停位置继续。
减少动态效果模式显示静态结尾并关闭运动控制，风险说明仍能操作；无 JS 仍可阅读并使用导航。
场景预留尺寸，所有资源本地提供，无行情、研究或第三方动画请求，也不放宽 CSP。

参考与许可：

- [Motion](https://github.com/motiondivision/motion)：MIT；使用开源能力，不引入 Motion+ 资源。
- [Motion values](https://motion.dev/docs/react-motion-value)、[LazyMotion](https://motion.dev/docs/react-lazy-motion)、[可访问性](https://motion.dev/docs/react-accessibility)：性能、渐进增强与减少动态效果的实施参考。
- [Interactive Repulsive Effect](https://github.com/iondrimba/interactive-repulsive-effect)：仅借鉴距离感应的交互思路；本项目原创实现 SVG 场景，未复制其代码、材质或图像。

## 域名与镜像

Cloudflare 保持现有 DNS only 接入；官网、用户 API 与管理 API 的隔离不变。
旧用户 / 管理域名与 `www` 长期 301，保留路径和查询参数。
请求同源校验按协议与 Host 判断，不为迁移放宽跨域白名单；Cookie 不新增跨子域共享。

官网 build 输出 `.next/build-identity.json`，包含构建 origin 与品牌；Docker 和下载包都携带该文件。
启动前 `origin-guard.mjs` 对照运行时 origin 与当前品牌，不一致则拒绝启动。
更改品牌或域名必须重建官网，不能只修改运行环境。
完整仓库门禁扫描所有公开代码与内容；官网 Docker 的最小上下文显式使用 `BRAND_CHECK_WEBSITE_ONLY=1`，
仅扫描已复制的官网与共享品牌资源，完整检查仍由 CI 在制镜前执行。
服务端镜像携带框架无关品牌模块，未向官网镜像引入账号、数据库或密钥目录。

## 验收记录

- `GATE_SKIP_DB=1 WEBSITE_ORIGIN=https://duckstrat.com pnpm release:gate` 通过：全仓类型、来源与安全 99 项、因果性 456 项、结构 36 项、计算 42 项、管理入口 35 项、官网契约、管理端浏览器 40 项、生产构建。未将跳过的 DB 套件记为通过。
- 独立测试库真实 HTTP 登录回归 47 项、双入口隔离 28 项全部通过；不使用业务库或生产账号。
- 官网浏览器：25 项通过；原有 SSR 套餐用例使用独立目录 fixture 单独通过。涵盖全部 36 个公开路由、SEO、动效控制、可选 chunk 下载失败、真实触控、键盘、隐藏文档、离开视口、减少动态效果、无 JS、同源终端衔接与管理端交付。
- 官网页面与交互单元测试 20 项通过；中英文词典 key 和 admin 词典缺项均为 0。
- 两个生产 Docker 镜像均构建成功；官网镜像实际启动返回 200，错误 origin 被拒；服务端镜像内品牌模块可正常导入。
- VPS / Oracle Caddy 模板一致，并通过 Caddy 配置验证（验证时用一次性测试哈希替代部署占位符）。
- 响应宽度覆盖 390 / 768 / 1440 / 1920，无横向溢出；手工核对桌面、手机、登录和分享图。

移动端性能使用同一 Chrome、390×844、4 倍 CPU 限速、150ms 延迟、200000B/s 下载，每版三个全新 context：

| 指标 | 旧首页 | DuckStrat 首页 |
| --- | --- | --- |
| LCP 三次（ms） | 908 / 844 / 792 | 720 / 632 / 692 |
| LCP 中位数（ms） | 844 | 692 |
| CLS | 0 / 0 / 0 | 0 / 0 / 0 |

这是受控本地比较，不作为线上真实用户性能承诺。
视觉证据：[桌面](references/duckstrat/desktop.png)、[手机](references/duckstrat/mobile.png)、[分享图](references/duckstrat/opengraph.png)。

## 发布与回滚

遵循 PR → CI → 合并 → tag → 镜像 → 部署流程。部署前确认当前无活跃用户/研究，记录原镜像 digest；
应用、管理 API 和官网使用同一版本，复验公开路由、品牌、重定向、登录、SSE 和 WebSocket。
保留上一版本镜像与配置，用原 digest 回退；品牌发布不需要数据迁移或重命名会话键。
