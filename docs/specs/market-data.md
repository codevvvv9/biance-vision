# 行情数据规格：契约、采集、快照与质量

> 状态：implemented

## 目标

为全部下游模块（结构引擎、预测、研究流水线、UI）提供唯一、因果、可回放的行情数据基础：统一的 K 线契约、幂等采集与补洞、收盘约束、冻结快照与数据质量度量。端点字段细则见 docs/references/binance-products-and-apis.md。

## 已确定决策

- 行情覆盖两类市场：`spot`（现货）与 `usdm_perp`（USDT 永续）；永续含三种价格类型 `trade` / `mark` / `index`，另采资金费率与持仓量 OI。
- **现货与永续的同名交易对（如 BTCUSDT）是不同序列，分别存储、分别查询**，绝不混用。
- **指数 K 线的占位成交量字段不得当作成交量**：provider 归一化层将其置 `null`。
- OHLCV 使用精确 decimal（字符串形式存储与传输）；内部时间统一 UTC 毫秒，界面按用户时区展示。
- 收盘约束：引擎入口拒绝未收盘 K 线；REST 以 `closeTime` 结合交易所时间判断，WS 以 `k.x` 为收盘标记。
- 落库以 REST 轮询已收盘序列为准；WS 仅作低延迟提醒触发增量拉取与前端展示，不作为落库来源。
- 采集由 worker 常驻执行，与网页是否打开无关。
- 幂等写入：按 `(venue, marketType, priceType, symbol, interval, openTime)` 复合主键 upsert；重复、乱序、修订按 `revision` 处理。
- 缺口登记而非静默补平盘；补洞由 `ingest_state` 游标驱动。
- 每轮分析冻结 `snapshotId` / `asOf`：各周期只取 `closeTime ≤ asOf` 的已收盘 K 线；实时价格单独携带 `priceAsOf` 标注，不混入闭合 K 线信号。
- 限流退避以官方文档为准，实现时复核权重（尤其 fapi 与 `/futures/data/*`）。

## 数据与接口

### K 线契约（`shared/src/market.ts` 的 `CandleRow`）

| 字段 | 说明 |
| --- | --- |
| `venue` / `marketType` / `priceType` | binance；spot \| usdm_perp；trade \| mark \| index |
| `symbol` / `interval` | 交易对与周期（1m/5m/15m/30m/1h/4h/1d/1w 等） |
| `openTime` / `closeTime` | UTC 毫秒；closeTime 是收盘判断依据 |
| `open` / `high` / `low` / `close` / `volume` | 精确 decimal 字符串；index 价格类型 volume 为 null |
| `isClosed` | 是否已收盘 |
| `eventTime` / `receivedAt` | 事件时间与入库时间 |
| `source` / `revision` | 来源（rest/ws/backfill）与数据修订版本 |

### 表（`server/src/models.ts`）

- `market_candles`：复合主键 venue+market_type+price_type+symbol+interval+open_time；decimal OHLCV；is_closed；source；revision。
- `market_snapshots`：快照记录（snapshotId、symbol、marketType、asOf、各周期最后已收盘 openTime 集合、规则/数据版本）。
- `ingest_state`：每个序列的最后连续收盘点 / 补洞游标。
- `structure_events`：结构引擎输出（见 docs/specs/brooks-engine.md）。

### API（`/api/market/*`，共享 zod schema 约束）

- `GET /symbols?marketType=`
- `GET /candles?marketType&priceType&symbol&interval&from&to&asOf`
- `GET /snapshot?symbol&marketType&asOf`
- `GET /funding?symbol`、`GET /open-interest?symbol`
- `GET /quality`（缺口/延迟/修订统计）

### 提供者

- `server/src/market/providers/types.ts` 定义 `MarketDataProvider`；`binance-spot.ts`（包装现有 `server/src/binance.ts`）与 `binance-usdm.ts`（fapi）注册进 `providers/registry.ts`。

## 流程

1. **增量采集**：worker 周期任务对每个启用序列 REST 拉取最新已收盘 K 线 → 合法性校验 → 幂等 upsert → 推进 `ingest_state` 游标。WS 收盘提醒（`k.x=true`）触发立即增量拉取。
2. **补洞**：`backfill.ts` 按 `ingest_state` 游标 REST 回补；断网/限流后按游标恢复，不产生重复行（唯一键保证）。
3. **校验**：OHLC 合法性（high ≥ max(o,c)、low ≤ min(o,c)、volume ≥ 0）、时间连续性；缺口写入登记，不补平盘。
4. **快照**：`createSnapshot({symbol, marketType, asOf})` → 各周期 `closeTime ≤ asOf` 的最后已收盘 openTime 集合，落 `market_snapshots`；实时价格另标 `priceAsOf`。
5. **质量**：`quality.ts` 统计缺口/延迟/修订，供 `/api/market/quality` 与监控。

## 边界与失败处理

- 未收盘 K 线不进入引擎与预测；`asOf` 之后的任何数据对当次研究不可见。
- 缺口：登记并展示，不用平盘填充；缺口期间的结构结论须标注证据不完整。
- REST/WS 不一致：以 REST 已收盘序列为准；WS 数据不落库。
- 限流：指数退避；fapi 各端点权重以实现时官方文档复核值为准。
- 交易所返回修订数据：按 `revision` upsert 覆盖，结构缓存按「最后收盘时间 + 数据修订版本 + 规则版本 + 参数 hash」失效。
- 资金费率、OI 属于独立数据，不得从 OHLC 推断；缺失时对应情景分析标注不可用。

## 验收用例

- [ ] `/api/market/candles` 对 spot 与 usdm_perp 的同名交易对分别返回各自数据，互不混淆。
- [ ] index 价格类型的 K 线 volume 为 null，且无任何下游把它当成交量使用。
- [ ] 引擎入口传入含未收盘尾根的数据必须抛错（与 docs/specs/brooks-engine.md 联合验收）。
- [ ] 断网恢复后补洞游标续跑，`market_candles` 无重复行（唯一键验证）、缺口被回填并消除登记。
- [ ] 重复推送/乱序到达的 K 线不产生重复或错乱；修订数据按 revision 正确覆盖。
- [ ] `createSnapshot` 返回的各周期 openTime 均满足 `closeTime ≤ asOf`；实时价格携带独立 `priceAsOf`。
- [ ] 网页全程未打开时，worker 采集不中断（库内可见连续增量）。
- [ ] `/api/market/quality` 返回缺口/延迟/修订统计，与库内登记一致。

## 参考来源

- docs/references/binance-products-and-apis.md（端点、字段契约、限流说明、核验日期）
- docs/specs/brooks-engine.md、docs/specs/api-storage.md、docs/specs/architecture.md
- docs/brooks-agent-architecture.md（§4 行情与时间一致性调研）
- server/src/binance.ts（现有 REST/WS 客户端）
