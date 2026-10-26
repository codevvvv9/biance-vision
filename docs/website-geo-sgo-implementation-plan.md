# Biance Vision 官网 GEO/SGO 首版实施方案

> 状态：已随 v0.18.2 部署上线（2026-10-26 线上核验 SEO 输出正确）；站长平台验证 / AI 引用观测 / 真实用户验收待执行；域名迁移 duckstrat.com 进行中（见 §7）
>
> 日期：2026-10-23
>
> 用户于 2026-10-24 明确授权实施。本文保留设计约定，实际工程落点与验证边界见文末及本地 QA；方案完成不代表公开索引或商业转化已获验证。

## 1. 目标、范围与交付物

提高官网在 AI 搜索中的可发现性、引用准确性，以及对意向客户的承接能力，形成：

**用户提出研究问题 → AI 搜索发现公开内容 → 阅读方法或案例 → 查看演示 → 联系开通 → 登录完成首次研究。**

本方案将 GEO/SGO 统一作为“生成式搜索可见性”建设。英文优先选题和审核，核心内容同步提供中文；本次覆盖首版实现与首次验证，不制定持续运营季度计划。

保留既定 Next.js 官网、独立 React 终端和 W3 排期。不增加统计服务、数据库、CMS、第三方统计脚本、在线支付或匿名研究接口。Google 官方明确，AI 搜索沿用 SEO 基础，没有额外的专用技术门槛。[官方说明](https://developers.google.com/search/docs/appearance/ai-features)

本轮同步维护以下三份文档：

- 新建 `docs/website-geo-sgo-implementation-plan.md`，记录内容、抓取、语言入口和验证约定。
- 更新 `docs/website-nextjs-architecture-plan.md`，同步新增页面及语言入口变更。
- 更新 `docs/README.md`，记录工程已实现与上线 / 效果验收待执行的区别。

上述文档已同步；发布、站长平台和用户试用仍需真实环境证据，不能用本地技术检查代填。

## 2. 内容体系与页面实现

### 首版页面范围

复用首页、方法页、演示入口、联系页及指南列表，增加以下内容：

| 内容 | 首版交付 | 作用 |
|---|---|---|
| 产品身份 | 双语 `/about` | 明确产品、团队署名、支持范围、研究与交易的区别 |
| 研究方法 | 完善双语 `/methodology` | 解释快照、结构、支持证据、反对证据、校验和失效条件 |
| 独立案例 | 三个双语演示详情页 | 为趋势回调、区间突破、等待确认提供可直接引用的网址 |
| 入门指南 | 原定四篇双语文章 | 首次使用、读懂结果、价格行为上下文、事件报价填写 |
| 深入指南 | 新增四篇双语文章 | H2 二次进场、收盘数据与实时价格、永续研究复查、研究工具选择清单 |

演示详情固定使用 `/[locale]/demo/trend-pullback`、`range-breakout`、`wait-for-confirmation`。演示入口负责概览与选择，详情页提供完整解释，避免同一正文重复铺到多个网址。

四篇新增指南固定使用：

- `second-entry-h2`
- `closed-candles-and-live-price`
- `reviewing-perpetual-research`
- `research-tool-checklist`

研究工具选择清单比较使用需求、证据能力和操作方式，不编造竞争产品测试或“行业第一”。

### 内容组织与审核

内容随仓库维护，采用构建期 MDX 与类型化内容清单，不从终端数据库或私有知识库动态生成。

清单统一记录文章标识、语言、标题、摘要、所属主题、作者署名、审核日期、实质修改日期、参考来源、对应翻译、相关演示和发布状态。双语页面通过同一文章标识关联，不能仅靠文件名猜测。

文章按以下逻辑组织，允许根据主题省略不适用部分：

**直接解释 → 成立条件与上下文 → 图例或操作步骤 → 反例与限制 → 来源 → 下一步。**

- 使用原创 SVG 图例和产品演示，关键解释同时输出为 HTML。
- 标注实际编辑或审核团队，不虚构专家身份、资质、合作关系或用户评价。
- 英文先完成事实审核，中文同步核对术语、数值和产品边界；核心页面两种语言均通过审核后发布。
- 内容描述以当期可用功能为准，不把 planned spec 写成已交付能力。
- 教学案例保持“教学演示，非实时研究”，本期不新增真实历史报告发布系统。
- 引用公开一手资料，不公开私有会话、知识库切片或受限课程内容。
- 修改日期只随实质更新变化，不通过自动刷新日期制造新鲜度。

优先投入原创解释和案例，不批量生产币种、周期组合页面。Google 官方同样强调具有独特观点和实际经验的内容。[内容指南](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)

### 每个落地页都能完成转化

指南、方法和案例页都可独立作为首次访问入口：

- 正文附近提供关联演示，避免要求用户先返回首页。
- 阅读结束提供“申请开通 / Request access”。
- 始终可找到“已有账号登录 / Log in”。
- 联系入口指向对应语言联系页，沿用人工开通说明。
- 使用目录、来源锚点和相关推荐辅助阅读，不增加强制弹窗、阅读门槛或自动打开 Telegram。
- 不将私人研究问题写入链接、联系模板或日志。

## 3. 语言入口、抓取与技术边界

### 根路径自动选择语言

以本次决定替换旧方案“`/` 固定 302 到 `/zh`”的约定：

1. `/` 由 Next.js 独立入口处理，按 `Accept-Language` 的质量权重匹配中文或英文；忽略权重为零的项。
2. `zh` 及其地区变体进入 `/zh`，`en` 及其地区变体进入 `/en`。
3. 无支持语言时，查询本地中国大陆 IPv4 名单：命中进入 `/zh`。
4. 非大陆、无法识别、IPv6 未覆盖或定位不可用时，进入 `/en`。

技术约束：

- 使用 HTTP 302；`GET` 和 `HEAD` 行为一致，目标仅允许 `/zh` 或 `/en`。
- 根路径不透传任意查询参数，不设置语言 Cookie，不读取登录会话。
- 根响应使用 `Cache-Control: private, no-store`，后续缓存层也必须绕过。
- Caddy 覆盖写入专用客户端 IP 头，Next 仅信任来自内部上游的该字段；公网不能直连官网进程。
- IP 名单在构建期生成独立快照，沿用现有大陆名单来源，不调用在线定位服务、不导入终端封锁模块、不依赖终端运行文件。
- 正式构建校验名单格式；定位异常降级英文，不能阻止官网访问。

**自动选择仅作用于 `/`。** `/en/...`、`/zh/...` 始终展示指定语言，手动切换保留对应内容，不被 IP 或浏览器设置跳回。未知网址继续返回真实 404。

只有根入口动态执行；内容页继续预生成。默认保留 standalone 部署。未来若改静态导出，需要另行迁移根路径识别逻辑。

双语页面使用自引用 canonical 和互相对应的 `hreflang`；`x-default` 改为同一内容的英文页面，不指向动态根入口。独立语言网址符合 Google 对语言自适应网站的建议。[多语言抓取说明](https://developers.google.com/search/docs/specialty/international/locale-adaptive-pages)

### 搜索与训练抓取策略

- 公开正文及必要资源允许 Googlebot、Bingbot、OAI-SearchBot、PerplexityBot 抓取。
- 单独设置 `GPTBot: Disallow /`。
- 搜索抓取与训练抓取分别配置；拒绝 GPTBot 不代表其他平台都停止训练使用。[OpenAI 官方文档](https://developers.openai.com/api/docs/bots)
- 不根据爬虫身份改变正文，不为机器人提供额外研究数据或绕过鉴权。
- Sitemap 仅包含正式公开页面；工具、登录、API 和管理端继续按原方案控制访问与索引。
- 校验 robots 各组的实际生效规则，避免专用 User-Agent 分组意外覆盖公共规则。

结构化数据复用 `WebSite`、`Article`、`BreadcrumbList`，补充真实发布团队的 `Organization` 信息并统一标识。标记必须与可见内容一致，不填虚假评分、价格或背书。

首版不新增 `llms.txt`、AI 专属正文副本、代理接口或特殊“GEO Schema”。Google 明确表示，其搜索不使用 `llms.txt` 提升可见性。[官方说明](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)

**接口变化仅包括根路径行为及新增公开页面；研究 API、鉴权、SSE、草稿契约保持不变。**

## 4. 效果验证与数据边界

### 三类证据分别记录

| 层次 | 验证方式 | 可以得出的结论 |
|---|---|---|
| 抓取与索引 | Search Console、Bing Webmaster Tools、网址检查 | 页面是否被发现、抓取或索引 |
| AI 可见性 | Bing AI Performance、人工 AI 搜索检查 | 特定平台是否提及、引用及正确理解内容 |
| 获客与使用 | 真实用户试用、用户自愿说明来源 | 链路是否顺畅，是否产生实际意向与首次使用 |

Bing 的引用报告覆盖其支持的 AI 场景，不代表全平台表现，也不能直接换算成访问或成交。[Bing 官方说明](https://blogs.bing.com/webmaster/2026/2/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview/)

不新增事件采集接口或跨站用户标识，不承诺自动关联“AI 引用 → 联系 → 开通 → 付费”。

官网专用访问日志仅保留时间、公开路径、方法、状态码、耗时和响应大小；不保留查询参数、IP、请求头、Cookie 或请求正文。日志用于交付与异常检查，不能当作真实用户数。滚动保留 14 天并设总量上限，不记录终端请求。

### 首版人工检查集

固定 12 个问题：9 个英文、3 个中文，覆盖产品身份、研究方法、工具选择与开通。英文问题包括：

- What is Biance Vision?
- Is Biance Vision affiliated with Binance?
- Does Biance Vision execute trades?
- How should I read supporting and opposing evidence in crypto research?
- What invalidates a price action research conclusion?
- Why might research recommend waiting after a breakout?
- What is an H2 second entry, and what context does it require?
- What should I check when choosing an AI crypto research tool?
- How can I get access to Biance Vision?

中文问题覆盖产品定位、行情时间与证据阅读、联系开通。

在 ChatGPT 搜索、Perplexity、Google AI 搜索和 Bing/Copilot 的可用入口检查，使用独立会话，不主动提示引用本站。记录日期、平台、问题、是否触发搜索、品牌提及、引用网址及误述。

上线前建立基线；上线并出现索引数据后完成首次复核。平台不可用或暂未收录标为“未观测”，不伪造结果，也不以暂未被引用阻止技术上线。

## 5. 实施批次与验收

**第一批：内容设计。** 可在 W3 期间准备文章、术语表、图例、页面原型和检查集；明确实际内容审核负责人。

**第二批：官网集成。** W3 S2–S4 收口后，在原官网实施批次内加入内容清单、详情页、语言入口、元信息、抓取配置和官网日志。公共部署文件继续采用单一变更批次。

**第三批：发布验证。** 完成生产构建、隔离回归、站长平台验证、公开页面检查和真实用户试用；不以流量或引用增长作为工程完成承诺。

新增验收要求：

- [ ] 全部首版内容有完整双语正文、来源、审核记录和有效内链；无 JS 也能阅读。
- [ ] 文章、演示、JSON-LD、canonical、语言对应及 Sitemap 一致，草稿不发布。
- [ ] 覆盖浏览器语言权重、中英文与 IP 冲突、缺失语言、大陆/非大陆、IPv6 未知和名单异常；明确网址不发生语言强跳。
- [ ] 根路径不缓存、不读会话、不设 Cookie；伪造公网客户端 IP 头不能改变可信来源。
- [ ] 搜索爬虫可访问公开内容；GPTBot 被单独拒绝；不存在鉴权绕过。
- [ ] 日志不包含查询参数、IP、请求头或私人内容，日志故障不阻断官网。
- [ ] 从任一指南或案例进入，都能找到相关演示、联系开通及已有账号入口。
- [ ] 沿用 5 名目标用户、至少 4 名无协助完成价值理解、演示至联系路径及测试账号首次研究的验收，至少 3 名使用英文流程。
- [ ] 保留原方案全部路由、404、SEO、安全、容量、登录、草稿、地域策略和 W3 回归要求。
- [ ] 不将引用、联系按钮点击、登录或首次研究记作付费成交。

首版完成标准是：**公开内容值得阅读和引用、抓取与语言行为可验证、意向客户有顺畅后续入口，并且不增加终端运行依赖。** 实际曝光与转化提升留待真实数据验证。


## 6. 2026-10-24 实施落点

- `website/content/{en,zh}/*.mdx` 与 `content/manifest.json`：13 个内容标识，26 份正文；加上首页、演示概览、指南列表、联系页共 34 个双语 URL。清单的 published 表示可进入构建，不表示已部署。
- `scripts/check-content.ts` 在生产构建前校验来源、日期、目录、显式翻译关系、相关案例与 CIDR，并仅为 published 内容生成正文加载表及日志公开路径白名单。
- `PublicationPage` 提供可见署名、实质修改/来源核对日期、目录、原始来源与下一步入口；产品身份页声明独立项目及与 Binance 无关联。核对性质明确为 AI 辅助的技术内容核对，不声称独立金融审核；最终人工编辑确认仍为发布前事项。
- 搜索爬虫组、GPTBot、稳定 Organization/WebSite ID、Article、面包屑、Sitemap 与双语对应已落实；不增加 llms.txt、特殊 AI 正文或匿名研究调用。
- 日志独立 volume，14 天清理、总计 20 MiB，只有公开白名单路径及六个约定字段。分块响应大小不可知时记 null，HEAD 记 0，不读取正文测量。无日志写入能力时官网继续响应。
- 12 题与 48 行四平台观测表已交付；未观测项保持未观测。站长平台校验可使用公开 meta 构建参数，尚无实际账户验证或收录证据。

完整命令、截图、日志边界及待验证事项见 [GEO/SGO 本地 QA](references/website-geo-sgo-qa-2026-10-24.md)。§5 综合验收保持未勾选，工程局部检查结果单独记录。原完整发布门槛的研究 smoke 失败尚未解决，本轮未部署。

## 7. 2026-10-26 部署核验与域名迁移

- 官网实况（推翻 §6 末行「本轮未部署」的旧状态）：`biance-vision-website:0.18.2` 已在线，`WEBSITE_ORIGIN=https://btcpilot.duckdns.org`；公网实测根路径 302 语言自适应、`/en` 的 `<html lang>`、canonical/hreflang（en/zh-CN/x-default）、`sitemap.xml`、`robots.txt` 全部按设计输出。
- 域名迁移至正式域名 `duckstrat.com`（Cloudflare Registrar，灰云仅 DNS 直连 VPS）：`WEBSITE_ORIGIN`/Caddy 同步切换，旧 duckdns 双域名 301 永久重定向以传递索引权重；站长平台（Search Console / Bing Webmaster）待用新域名接入。
- 首页 `<title>` 由纯品牌标语调整为「品牌 — 品类词」组合（AI crypto market research terminal），内页维持「页面标题 | Biance Vision」模板不变。
