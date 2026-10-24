# 官网 GEO/SGO 首版本地实施与验证

日期：2026-10-24。状态：工程实现与官网范围本地验收完成；未部署，未声称已收录或被 AI 引用。

## 交付内容

- 13 个内容标识、26 份英文/中文 MDX：原有四篇指南、四篇深入指南、三个独立案例、产品身份页、研究方法页。连同首页、演示概览、指南列表及联系页，合计 34 个双语公开 URL。
- `website/content/manifest.json` 显式关联翻译、作者、来源、目录、核对日期、实质修改日期与发布状态。`published` 只表示构建可公开集合，不表示已经上线；`draft` 不进入路由、Sitemap、正文加载表或日志白名单。
- MDX 仅编译仓库内可信文件；不接受远程或用户输入 MDX，不访问私有知识库。修改日期固定，不随请求或发版刷新。
- 内容署名为项目维护者，明确 AI 辅助编写与来源/实现核对的性质，不冒充具名专家或独立金融审查。本轮逐篇核对英文概念、中文术语、时间边界与产品实现；发布前仍需项目维护者最终编辑确认。
- 演示概览提供摘要与三个完整案例的普通链接，详情页承担完整解释。文章有目录、来源、相关案例、联系开通和已有账号登录，不改变登录或研究 API。
- Organization/WebSite 使用同一 origin 下稳定 ID，Article 与可见署名、修改日期、引用和双语关系一致，面包屑包含指南/演示中间层。
- 专用搜索爬虫组重复所有工具/API/管理路径限制，GPTBot 独立拒绝。此策略不是鉴权或普遍的训练使用保证。
- 根入口延续浏览器语言优先、可信大陆 IPv4 兜底、最终英文；新增构建期 CIDR 严格校验，运行时名单异常则完整降级。

## 日志与运行边界

原生 Node diagnostics_channel 观察官网响应，不新增 API、数据库或统计脚本。仅记录构建白名单内公开 HTML/robots/sitemap 的 GET/HEAD；静态资源、终端、登录、管理、API 和任意未知路径不记入文件。

每条记录只有 `time/path/method/status/durationMs/size`。`size` 为声明的响应体字节数，分块或无法确定时为 `null`，HEAD 为 0；不读取正文以测量体积，不将未知大小伪装成 0。查询参数、IP、请求头、Cookie、请求体均不落盘。

日志写入独立 `website-logs` Docker volume，不经 Next/Caddy 静态服务暴露。文件 0600、目录初建 0700；滚动 14 天，每小时及每次写入清理；单文件 1 MiB、总计 20 MiB、最多 256 条待写，拥塞丢弃日志，不延迟响应。日志不可写时仅输出一次无路径/无请求内容的通用提示。无法据此推算真实用户、联系提交或付费成交。

生产入口改为 `node --import ./website/runtime/access-log.mjs website/server.js`。镜像保留 standalone 与只读公开联系目录；不挂载账号、AI 配置或整个 server/data。

## 验证记录

以下为实际执行结果；不将未执行的检查记为通过。

- 内容构建检查：13 组双语、34 页，全部正文/目录/来源/翻译/相关案例与 CIDR 格式有效。
- 官网单元检查：16 组通过，包括真实 Node 22 HTTP 日志、脱敏、14 天清理、大小/队列上限及不可写目录故障。
- 官网生产构建与独立 TypeScript：通过；server TypeScript 也通过。
- MDX 依赖安装后发现 pnpm 的隐式类型提升可让 React Router 6 误取 React 19 类型。已在根 packageExtensions 为 Router/Router DOM 增加可选 `@types/react` peer，由终端 workspace 显式解析 React 18 类型；修正后 web 与 website 类型检查分别通过，不改两者运行时 React 主版本。
- 全仓 `pnpm typecheck` 仍因既有 `scripts/chat-policy-check.ts:87/89/91` 把已改为异步的 `getChatUsageToday()` 与数字直接比较而失败。本轮未改该聊天策略脚本及其 PG 迁移，不掩盖此发布阻塞。官网类型检查通过不能代替全仓通过。
- 浏览器：原有官网 6 组与 GEO 5 组覆盖服务端 HTML、元数据、所有正文、真实 404、robots 分组、无差别正文、语言、草稿/联系原交互、移动端与无 JS。
- standalone 镜像 `biance-vision-website:local-geo-review` 构建 / 非 root 启动通过；配合临时 Caddy 实测 GET/HEAD、大陆兜底、浏览器语言优先、IPv6/非大陆、伪造头覆盖、名单损坏回退及管理路径 404，全部通过。独立容器日志检查无合成敏感字段。
- 容量抽样（首轮镜像）：Linux Docker 镜像 299,318,392 字节（约 285 MiB）；少量访问后内存 42.87 MiB / 512 MiB。此为本地功能检查的瞬时读数，不代表生产峰值或并发容量。原部署前容量 / prune / 双地域拨测要求不变。
- 本轮兼容检查：`login:regression` 全量 33 项、`admin:gate-check` 35 项、`knowledge:access-check` 全部断言通过；最后一项使用现有脚本的测试文档及清理逻辑。
- 截图：[英文 H2 桌面](website-qa/geo-h2-desktop.png)、[中文产品说明移动端](website-qa/geo-about-mobile.png)。

## 上线前基线与后续观测

固定问题位于 `website/evaluation/prompts.json`：英文 9 题、中文 3 题。已准备 [48 行上线前观测表](website-qa/geo-baseline-2026-10-24.csv)，分别对应 ChatGPT Search、Perplexity、Google AI Search、Bing/Copilot。**这些平台独立会话本轮均未观测**，未触发搜索、品牌提及和引用字段为空，不能解释为“没有引用”。当前环境没有四个平台的独立已登录会话，也未提供站长平台验证凭据。

2026-10-24 额外进行三条普通公开搜索抽样：`"Biance Vision" crypto research`、`site:btcpilot.duckdns.org "Biance"`、`"Biance Vision" H2 research`。本轮返回中未观察到可归属于该产品的内容页，主要为同名或拼写近似结果；这只是有限搜索抽样，不证明没有索引，更不是上述四个平台的独立会话基线。域名仅作为当前部署现状的检查样本，不写死为代码域名。

下一步由有平台访问权限的维护者在新会话中逐题检查，不向平台提示“引用本站”；记录 UTC 日期、入口/模型版本、是否搜索、品牌提及、实际引用 URL、误述与可复核证据。证据不得包含账号、密码或私人问题。无法进入或未确认索引时保留“未观测”并填写原因。

上线并看到索引后，生成第二份表：

```sh
pnpm --dir website exec tsx scripts/prepare-observations.ts post-index /absolute/new-observation.csv
```

此脚本仅生成空白观测表，采用独占创建，不能覆盖原观测记录，不调用任何平台或 AI 模型。

## 站长平台与真实用户验收

1. 以真实 `WEBSITE_ORIGIN` 构建，保持原同域路径、独立管理域名。
2. 维护者在 Search Console 和 Bing Webmaster Tools 添加既有公开站点。可继续使用现有 DNS 验证；如选 HTML meta 验证，配置公开的 `GOOGLE_SITE_VERIFICATION` / `BING_SITE_VERIFICATION` 构建参数后重建。不要将站长账户凭据或 OAuth token 填入这里。
3. 检查实际 HTML 的验证标签、canonical、hreflang、JSON-LD 与 Sitemap origin 一致，再在站长平台提交 `/sitemap.xml`；用 URL 检查确认抓取/索引。Bing AI Performance 与人工引用观测分别记录。
4. 邀请 5 名目标用户（至少 3 名英文流程），至少 4 名无协助解释价值、完成演示到联系路径，并用测试账号完成首次研究；实际结果与阻滞点另记，未执行前不打勾。
5. 原完整 `pnpm release:gate` 在前一轮研究 smoke 存在重复阶段状态的失败，详见 [官网首版验收](website-implementation-qa-2026-10-24.md)。本轮未修改研究流水线，也未将该门槛标绿。工程局部通过不表示已满足正式发布条件。

## 一手资料核对

- [Google：AI 搜索技术要求](https://developers.google.com/search/docs/appearance/ai-features)
- [OpenAI：搜索与训练爬虫](https://developers.openai.com/api/docs/bots)
- [Perplexity：抓取代理](https://docs.perplexity.ai/docs/resources/perplexity-crawlers)
- [Next：构建期 MDX](https://nextjs.org/docs/app/guides/mdx)
- [Brooks：公开价格行为术语](https://www.brookstradingcourse.com/price-action-trading-terms-glossary/)
- [Binance：K 线流字段](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)
- [Binance：永续市场数据](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)
- [Bing：AI Performance 适用范围](https://blogs.bing.com/webmaster/2026/2/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview/)

收口：已停止本轮启动的本地预览与两个临时测试容器，保留源码、截图、观测表及本地镜像；未操作线上部署。
