# Brooks 官方资料与来源清单

> 核验日期：2026-09-30；2026-10-08 与 manifest 重新同步（补齐 Wiley 词汇表与社区论坛条目）。
> 本文是 `docs/references/knowledge-source-manifest.json` 的人类可读说明：
> Admin 批量导入以 manifest 为准，本文改动需同步 manifest，反之亦然。

## 1. 来源等级与访问方式约定

- 来源等级三档：**官方一手**（brookstradingcourse.com 官方发布）、**官方衍生**（出版社/授权方发布，如 Wiley）、**社区**（brookspriceaction.com 论坛，二手讨论，仅作溯源参考）。
- 访问方式三档：**公开**（无需登录即可阅读）、**需购买**（商业书籍本体）、**会员**（课程视频、完整图形百科等登录/付费墙后内容）。
- 导入方式只有两种：`url_fetch`（单 URL 抓取公开页面）与 `user_upload`（用户上传文件）。**URL 导入不绕过访问限制**：付费墙/登录后内容一律不抓取；商业书籍与会员资料仅通过用户上传有使用权的文件导入。

## 2. 官方入口清单

| 资料 | URL | 资料类型 | 主题 | 访问方式 | 来源等级 | 核验日期 | 使用范围 |
|---|---|---|---|---|---|---|---|
| Brooks 价格行为术语表 | <https://www.brookstradingcourse.com/price-action-trading-terms-glossary/> | 官方词汇表（网页） | 术语定义、H/L 计数、EMA20 用法 | 公开 | 官方一手 | 2026-09-30 | 可 URL 导入（manifest: `brooks-glossary`）；术语归一与同义词表的主要依据 |
| Brooks 价格行为缩写表 | <https://www.brookstradingcourse.com/brooks-price-action-abbreviations/> | 官方缩写表（网页） | H2/L2、ii/ioi、MTR 等缩写 | 公开 | 官方一手 | 2026-09-30 | 可 URL 导入（manifest: `brooks-abbreviations`）；短词精确词项的来源 |
| 书籍与图表下载页 | <https://www.brookstradingcourse.com/price-action-trading-books/> | 书籍入口与公开图表（网页） | 书籍购买入口、官方免费样章与图表下载 | 页面公开（书籍本体需购买） | 官方一手 | 2026-09-30 | 页面与官方免费样章可 URL 导入（manifest: `brooks-books-page`）；书籍文件仅用户上传 |
| 课程目录 | <https://www.brookstradingcourse.com/trade-price-action/> | 课程目录（网页） | 视频课程结构与主题 | 目录公开（课程视频会员） | 官方一手 | 2026-09-30 | 仅目录页可 URL 导入（manifest: `brooks-course-catalog`）；课程内容不抓取 |
| 交易手册及公开章节 | <https://www.brookstradingcourse.com/how-to-trade-price-action-manual/> | 官方手册公开章节（网页） | How to Trade Price Action 手册公开部分 | 部分公开（完整手册需购买） | 官方一手 | 2026-09-30 | 公开章节可 URL 导入（manifest: `brooks-trading-manual`）；完整手册仅用户上传 |
| Ask Al 问答 | <https://www.brookstradingcourse.com/blog/ask-al/> | 问答专栏（博客） | Al Brooks 公开答疑 | 公开 | 官方一手 | 2026-09-30 | 可 URL 导入（manifest: `brooks-ask-al`） |
| 图形百科样例 | <https://www.brookstradingcourse.com/price-action/brooks-encyclopedia-chart-patterns-sampler/> | 图形百科样例（网页） | Encyclopedia of Chart Patterns 公开样例 | 样例公开（完整百科会员） | 官方一手 | 2026-09-30 | 样例页可 URL 导入（manifest: `brooks-encyclopedia-sampler`）；完整百科不抓取 |
| Wiley 书内词汇表 PDF | <https://onlinelibrary.wiley.com/doi/pdf/10.1002/9781119203117.gloss> | 出版社官方词汇表（PDF） | 书内 glossary，术语权威出处之一 | 公开 PDF | 官方衍生 | 2026-09-30 | 可 URL 导入（manifest: `wiley-glossary-pdf`）；若链接失效或转为受限，改用户上传 |
| Brooks 社区论坛 | <https://www.brookspriceaction.com> | 社区论坛 | 定义讨论、经验统计溯源 | 公开阅读（发帖需注册） | 社区 | 2026-09-30 | manifest: `brooks-community-forum`（`enabled: false`）；默认不入库，仅作调研溯源参考，确需引用时单条 URL 导入并人工审核 |

## 3. 书籍身份与归档

- Trading Price Action 三部曲以**官方英文标题**为准（Wiley 出版）：**Trading Price Action: Trends**、**Trading Price Action: Trading Ranges**、**Trading Price Action: Reversals**。
- 中文渠道的译名与卷次对应存在混乱（例如把「第 1 卷」写成 "Trading Ranges to Trends" 等说法），本文档**不做中英强行对号**；入库登记、规则卡出处与引用一律使用官方英文标题。
- **Reading Price Charts Bar by Bar**（Wiley，2009）是三部曲之前的独立著作，单独归档，不并入三部曲编号。
- 商业书籍与会员资料**仅通过用户上传有使用权的文件导入**；URL 导入不绕过访问限制。导入时保留页码/图号/原文与资料版本；引用时不许伪造页码。

## 4. 使用纪律

- 每条资料的启用开关与导入方式以 `docs/references/knowledge-source-manifest.json` 为准；manifest 中 8 个公开入口 `enabled: true`（含 Wiley 词汇表 PDF），书籍条目 `enabled: false` 直至用户上传有使用权文件；社区论坛条目 `enabled: false`，默认不入库，确需引用时单条导入并人工审核。
- 检索与引用遵循 `docs/specs/knowledge-rag.md` 的引用快照纪律：每条引用冻结 documentVersion/chunkId/page/figure/contentHash。
- 官方页面内容可能更新：URL 导入每次抓取生成新的文档版本，已发布知识版本不随源站改动而变化（追加新版本，不覆盖）。

## 5. 工程参考实现（不入知识库）

以下来源是 Brooks 价格行为的**社区工程实现参考**（代码/脚本），只用于结构引擎的实现调研，**不作为知识库资料导入**，不进 manifest。调研结论详见 [Brooks 价格行为手册 §5 开源实现参考](../brooks-price-action-manual.md)。

| 来源 | 类型 | 借鉴点 |
|---|---|---|
| [AxisJu/price-action-skills](https://github.com/AxisJu/price-action-skills) | Python | EMA20+15棒市场循环分类；H/L 状态机；楔形 3 摆动+40 棒跨度 |
| [ByteBard/ict-stradegy](https://github.com/ByteBard/ict-stradegy) | Python | candle 分类阈值 0.60/0.30；双底 10% 容差；MTR 10 根窗口；registry 分层 |
| [TradingView: Al Brooks Second Entry](https://www.tradingview.com/script/YUixSlPL-Al-Brooks-Second-Entry/) | Pine | N 根确认 swing + isconfirmed 防重绘；H2 信号棒强度过滤（收顶 30%） |
| [TradingView: PA Intraday Setups](https://www.tradingview.com/script/bOU4RciY-PA-Intraday-Setups/) | Pine v6 | 趋势分类阈值 0.40、窗口 15/20 根 |
| [TradingView: Brooks Price Action Scalper](https://www.tradingview.com/script/clk3xB1L-Brooks-Price-Action-Scalper/) | Pine | always-in 双行仲裁 + UNCLEAR（弃权态）设计 |
| [kayasolomon/market-structure-engine](https://github.com/kayasolomon/market-structure-engine) | TypeScript | 不重绘摆动结构的 TS 参考实现 |
| [oficcejo/2pa-agent-rust](https://github.com/oficcejo/2pa-agent-rust) | Rust | "LLM 提议 + 确定性程序守门"架构、0.2×ATR 止损缓冲 |
