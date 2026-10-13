# 币安产品与 API 端点参考

> 核验日期：2026-09-30。各端点权重、限流阈值与字段细节**以官方文档为准，实现时复核权重**。
> 现有实现入口：`server/src/binance.ts`（现货 REST 多主机轮换 + 单连接多路复用 WS + 指数退避重连）。

## 1. 现货（Spot）

REST 基地址：`https://data-api.binance.vision`（公开行情专用，优先）、`https://api.binance.com`（回退）。

| 端点 | 用途 | 关键字段契约 |
|---|---|---|
| `GET /api/v3/klines` | 历史 K 线（symbol/interval/startTime/endTime/limit） | 返回「数组的数组」，下标含义见 §3；数值均为十进制字符串 |
| `GET /api/v3/ticker/24hr` | 24h 行情统计（全市场或单 symbol） | 短字段 `c`（最新价）/`P`（涨跌幅%）/`h`/`l`/`q`（成交额）等字符串数值；用于市场宽度与自选列表 |

WS 地址：`wss://data-stream.binance.com/ws`、`wss://stream.binance.com:9443/ws`。

| 流 | 用途 | 关键字段契约 |
|---|---|---|
| `<symbol>@kline_<interval>` | 单交易对 K 线推送 | 事件内 `k.x === true` 表示该根**已收盘**；未收盘 tick 只进图表展示，不进引擎与落库序列 |
| `!miniTicker@arr` | 全市场 mini ticker 推送 | 裸数组（无 `e` 字段），逐 symbol 刷新缓存 |

纪律：WS 推送仅作低延迟提醒（触发增量拉取）与前端展示；**落库以 REST 轮询已收盘序列为准**。采集由 worker 常驻执行，与网页是否打开无关。

## 2. USDⓈ-M 永续（fapi）

REST 基地址：`https://fapi.binance.com`。

| 端点 | 用途 | 关键字段契约 |
|---|---|---|
| `GET /fapi/v1/klines` | 合约**成交价** K 线（priceType=trade） | 数组下标同 §3 |
| `GET /fapi/v1/markPriceKlines` | **标记价格** K 线（priceType=mark） | 数组下标同 §3；成交量字段为占位值，归一化置 null |
| `GET /fapi/v1/indexPriceKlines` | **指数价格** K 线（priceType=index） | 数组下标同 §3；**成交量字段为占位值（0），归一化层必须置 null，不得当成交量使用** |
| `GET /fapi/v1/fundingRate` | 历史资金费率 | `symbol` / `fundingRate` / `fundingTime`；用于资金费率情景（近期 funding × 方向 × 时长） |
| `GET /futures/data/openInterestHist` | 持仓量 OI 历史 | `symbol` / `sumOpenInterest` / `sumOpenInterestValue` / `timestamp`（period 粒度参数） |
| `GET /fapi/v1/premiumIndex` | 当前标记价/指数价/资金费率快照 | `markPrice` / `indexPrice` / `lastFundingRate` / `nextFundingTime` |

WS 地址：`wss://fstream.binance.com/ws`（`<symbol>@kline_<interval>` 等同名流，`k.x` 收盘标记语义相同）。

说明：

- 三类价格（trade/mark/index）作为 `priceType` 维度分别入库，互不替代；现货与永续同名交易对（如 BTCUSDT）分别存储，用 `marketType` 区分。
- `/fapi/v1/indexPriceConstituents`（指数成分）本项目**不使用**：指数构成不作研究输入，避免引入未验证假设。

## 3. K 线数组下标契约（klines 系端点通用）

REST klines 返回的每根 K 线是定长数组，下标含义：

| 下标 | 含义 |
|---|---|
| 0 | openTime（开盘时间，毫秒） |
| 1 | open |
| 2 | high |
| 3 | low |
| 4 | close |
| 5 | volume（成交量；mark/index K 线为占位值） |
| 6 | closeTime（收盘时间，毫秒；含收盘时刻） |
| 7 | quoteAssetVolume（成交额） |
| 8 | numberOfTrades（成交笔数） |
| 9 | takerBuyBaseVolume（主动买入成交量） |
| 10 | takerBuyQuoteVolume（主动买入成交额） |
| 11 | ignore（忽略） |

纪律：全部数值以十进制字符串传输，落库用精确 decimal；引擎与快照只使用 `closeTime <= asOf` 的已收盘 K 线，引擎入口拒绝未收盘数据（见 `docs/specs/market-data.md`）。

## 4. 限流与退避

- 现货与 fapi 的请求权重**分别计数**，各端点权重与封禁规则以官方文档为准，实现时复核权重。
- 现有实现：REST 多主机轮换 + 8s 超时；WS 断线指数退避（1s 起、封顶 15s）并轮换主机。
- worker 侧补洞按 `ingest_state` 游标进行，配合限流退避，不并发扫全历史。

## 5. Event Contracts（事件合约）

- 官方说明：[币安事件合约说明](https://www.binance.com/en/support/faq/detail/172247f1c4b8401ab106fb63900f3825)（核验日期 2026-09-30）。
- 官方期限四种：**10 分钟 / 30 分钟 / 1 小时 / 1 天**。**1w（一周）不是币安已有事件合约产品**，属本工具的研究预测模式，界面与文档必须显著区分，不得混称。
- 该产品**仅在币安 App 提供，官方不开放 API**。因此：
  - 报价（执行价 strikePrice、到期时间 expiryAt、投入金额 stake、**含本金的总返还** totalPayout、执行参考价）由用户从 App 手动录入；
  - 到期结算以用户确认的真实订单为准，分钟级已收盘行情只给出「研究估算」，两者分别统计；
  - 不实现任何自动报价抓取。
- 产品规则（赔付结构、平价退款等）以官方说明页面与 App 内公示为准；规则变动时更新本文并复核 `docs/specs/event-contracts.md`。
