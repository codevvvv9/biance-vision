---
name: brooks-market-engine
description: 维护行情数据契约与 Brooks 结构引擎时使用。当任务涉及 market_candles/快照/补洞采集、shared/src/ 下结构规则（内外包、摆动、腿、状态机、H/L 计数、setup/触发/失效）、因果性与回放校验、或行情 API（/api/market/*）的改动时，应使用本技能。
---

# Brooks 行情与结构引擎维护

## 职责

- 行情数据链路：Binance 现货与 USDⓈ-M 永续的 K 线/资金费率/持仓量采集、幂等入库、补洞、快照（snapshotId/asOf）、数据质量指标。
- Brooks 结构引擎（`shared/src/`，纯 TS 零依赖）：单根特征 → 结构（摆动/腿/趋势震荡）→ setup/触发/失效事件。
- 因果性与回放：前缀一致性、逐根一致性、未收盘拒绝。

## 维护时必须遵守的纪律

- **因果性优先**：任何结构事件必须携带 `knownAt`；摆动点可在图上画回 pivot，但模型与回放必须到 `knownAt` 才能使用。禁止再出现读取未来数据的状态机（历史缺陷：`regime.ts` 的 `despeckle()` 读 `types[i+1]`，已修复，不得回退）。
- **收盘约束在引擎入口统一执行**：存在未收盘 K 线或 `closeTime > asOf` 的输入直接抛错，由调用方过滤；不允许各调用点各自用本机时钟猜收盘。
- **setup / 触发 / 失效 / provisional 分离**：四者是不同事件，不得合并成一个「信号」；provisional 状态在 UI 用虚线等显式标注。
- **已发布证据追加不覆盖**：修订以新事件或新版本表达，不改写旧记录。
- **多空证据并存**：组合判断允许多空证据同时存在，不强迫每段行情都产出交易信号。
- **经验数值不是预测胜率**：Brooks 的 H2≈60%、80% 规则族是其在美股股指期货的经验统计，引擎不得将其写入判定逻辑或当成本品种预测概率输出；本地统计模块验证前概率输出为空。
- **规则来源分级标记**：每条规则带 `ruleId/ruleVersion/sourceRefs/parameters/engineeringAssumptions`；官方定义、工程阈值、本地统计结论分别标记，工程阈值不得冒充 Brooks 原文规则。
- **行情契约**：OHLCV 用精确 decimal；现货与永续同名交易对分别存储；指数 K 线的占位成交量字段由 provider 归一化置 `null`，不得当成交量使用；缺口登记而非静默补平盘；补洞以 `ingest_state` 游标驱动。
- **价格类型是数据维度**：`priceType: trade|mark|index` 进契约与表结构，不在代码里 if-else 分叉。

## 正式 spec

- `docs/specs/market-data.md` — K 线契约、采集、补洞、快照、数据质量
- `docs/specs/brooks-engine.md` — 规则来源分级、三层状态机、knownAt、因果性验证

## 常用校验命令

- `pnpm typecheck` — 全仓类型检查（改动 `shared/` 后必跑）
- `pnpm brooks:selftest` — 合成 K 线 9 组场景断言（`scripts/brooks-selftest.ts`）
- `pnpm brooks:causality` — 因果性校验（前缀/逐根一致性、未收盘拒绝；阶段二落地后可用）
