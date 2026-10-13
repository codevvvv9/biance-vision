# Brooks 结构引擎规格

> 状态：implemented

## 目标

定义 Brooks 价格行为结构引擎的规则来源分级、三层状态机、时间语义（knownAt/确认/失效）与因果性纪律。引擎是**确定性代码**：输出结构事件与情景证据，不输出预测概率；概率唯一来自统计模块（docs/specs/prediction.md）。

## 已确定决策

### 规则来源分级

每条规则保存 `ruleId` / `ruleVersion` / `sourceRefs` / `parameters` / `engineeringAssumptions`，并按来源分级标记：

| 级别 | 含义 | 示例 |
| --- | --- | --- |
| 官方定义 | Brooks 官方资料（术语表、书籍）的定义，附出处 | 内包/外包、摆动点、H/L 计数语义 |
| 工程阈值 | 本实现选择的近似参数，**待验证、非普适常数** | 实体占比 0.55/0.30、ATR 倍数、摆动窗口 k |
| 本地统计结论 | 经本品种回放验证后才允许标注的结论 | 经验证前一律为空 |

- Brooks 的 H2≈60%、80% 规则族等是其**美股股指期货**经验统计：可作为资料背景展示，**不得写入判定逻辑，不得作为任何币种/周期的预测胜率输出**。`BrooksSignal.prior` 改名 `empiricalNote` 并明确「非预测胜率」语义；删除任何把经验数值当预测概率的输出路径，概率为空直至本地统计模块验证。

### 三层状态机

`单根特征 → 结构/上下文 → setup / 触发 / 失效`：

1. **单根特征**：趋势棒/doji/内包/外包/ii/oo/ioi/无尾棒等，仅依赖当根与前根。
2. **结构**：摆动点、腿、HH/HL/LH/LL、趋势/震荡（含 spike/channel/TTR/barbwire）、Always In。
3. **setup 生命周期**：`setupAt`（形态成立）→ `triggerAt`（触发，如突破信号棒高点）→ `invalidatedAt`（失效）；`provisional` 表示未确认。三者分离：H2 的出现、突破 H2 高点、随后是否成交是三件不同的事。

### 时间语义

- 所有结构携带 `knownAt`（实际可被知道的时间）。摆动点可在图上画回 pivot 位置，但**模型和回放必须到 knownAt 才能使用**。
- 失效是事件：写入 `invalidatedAt`，不删除、不覆盖原事件；已发布证据**追加不覆盖**。
- 组合判断允许多空证据并存，不强迫每段行情都产生交易信号；保留 `uncertain` 状态。

### 因果性纪律

- 修复 `shared/src/regime.ts` 的 `despeckle()` 未来读取（当前读取 `types[i+1]`）：改为因果状态机——raw 分类保持逐根因果，状态翻转需**连续两根同为新状态**才确认（确认 bar 即 knownAtIndex），孤立毛刺自然丢弃；段与事件携带 `knownAt`，候选状态经 `regimePendingAt` 单独暴露。
- 腿的冻结规则（实现中验证的关键决策）：腿 A→B 的 `knownAtIndex` = **B 之后首个反向摆动点的 confirmIndex**（冻结只发生一次；之后该反向节点自身被更极端同向节点替换也不影响这条腿）。 zigzag 尾部替换只影响最后一条边，该边恒为 provisional。冻结表以摆动点**对象引用**为键：同一根 K 线可同时是摆动高点与低点，按 bar 索引建表会互相覆盖。
- `analyzeBrooks()`（`shared/src/analyze.ts`）入口强制收盘约束：存在 `closed===false` 或 `closeTime > asOf` 的 bar 直接抛错；新增 `options.asOf`。
- 因果性验证（`scripts/causality-check.ts`，`pnpm brooks:causality`）：
  - **前缀一致性**：对每个 t，前缀输入与全量输入在 `knownAt ≤ t` 的已确认事件必须完全一致。
  - **逐根一致性**：流式逐根喂入与整批结果按 knownAt 截断后相等。
  - **未收盘拒绝**：带未收盘尾根调用引擎必须抛错。
  - 固定种子合成数据 + 库内真实 Binance 样本双跑。

## 数据与接口

- 输入：`CandleRow[]`（仅已收盘，见 docs/specs/market-data.md）+ `{ swingK, asOf }`。
- 输出 `analyzeBrooks()`：`BrooksAnalysis { features, swings, legs, regimeAt, alwaysIn, signals, summary }` 追加 `events: StructureEvent[]`。
- `StructureEvent`：`ruleId/ruleVersion`、barIds、`patternTime`/`knownAt`/`triggerTime`/`invalidatedAt`、`provisional`、市场上下文与触发说明。
- 类型调整（`shared/src/types.ts`）：`SwingPoint/Leg/RegimeSegment/BrooksSignal` 增加 `knownAt`；信号生命周期拆分 `setupAt/triggerAt/invalidatedAt/provisional`。
- 规则注册表：`shared/src/rules/registry.ts`；新结构 = 注册新规则模块，参数只能从已注册 schema 取值。
- 结构事件落库 `structure_events`，供研究流水线与回放复用。

## 规则清单与必须定义的边界

| 结构 | 实现方式 | 必须定义的边界 |
| --- | --- | --- |
| 内包/外包线（i/O/ii/oo/ioi） | 比较相邻 high/low | 相等时如何归类、连续 ii/ioi、零波幅 |
| 摆动高低点 | 左右窗口确认 / 在线摆动状态机（k 可选 1/2/3/5） | pivotTime 与 knownAt 分离；同根同时高低点的处理 |
| 腿（Leg） | 已确认交替摆动的状态机 | 未完成腿是 provisional；延伸不能覆盖旧决策证据 |
| 趋势/震荡（spike/channel/TR/TTR/barbwire）、Always In | 重叠、实体、HH/HL、LH/LL、突破跟随、可选 EMA20 | 全部只读当时可用前缀；保留 uncertain；EMA20 仅为可选上下文，另设仅 OHLC 实验模式 |
| H1–H4 / L1–L4 | 回调内的连续计数状态机 | 计数重置条件、上下文（趋势环境）、setup/触发/失效分离；n>4 不发 |
| 楔形（三推） | 三个递升/递降摆动 + 动能衰减判断 | 跨度窗口、推间回调要求、衰减阈值、与通道的互斥解释 |
| 双顶/双底 | 相邻同向摆动点比较 | 相似价容差（ATR 倍数）、间隔窗口、中间回落幅度、颈线目标 |
| ii 突破 | ii 形态后窗口内收盘突破形态极值 | 突破窗口长度、先到先得、假突破处理 |
| 趋势线突破（TLB） | 最近两个已确认摆动点连线被收盘穿越 | 斜率合法性、有效期窗口、此前确有趋势的前置条件；只作警戒不作反转信号 |
| MTR（主要趋势反转） | TLB + 测试 + 反转信号三步齐备 | 三步各自的确认条件与窗口；不完整序列不得标记 MTR |
| 区间突破 | 交易区间极值被趋势棒收盘突破 | 区间最小长度、突破确认、80% 失败仅作研究背景（不入判定逻辑） |

## 流程

1. 调用方提供已收盘序列与 `asOf`（市场数据层负责过滤，引擎入口再强制校验）。
2. 逐层计算：单根特征 → 摆动/腿/市场状态 → setup 状态机（含 H/L 计数、组合形态）。
3. 输出结构事件与摘要；事件携带 `ruleId/ruleVersion/knownAt/provisional`。
4. 下游（研究流水线、回放、UI）按 knownAt 消费；图上可把摆动点画回 pivot，并标注确认滞后。

## 边界与失败处理

- 未收盘或 `closeTime > asOf` 的输入：入口抛错，不做「尽力分析」。
- 数据缺口：对应区间结构结论标注证据不完整，不跨缺口脑补形态。
- 规则参数只能从已注册 schema 取值；任意提示词不能生成可执行规则。
- 经验统计（H2≈60%、80% 族）不进入判定与概率输出；模型未验证前概率输出为空。
- 结构强弱、证据完整度、未来事件概率三者分开表示，不得统称「置信度」。

## 验收用例

- [ ] `despeckle()` 的未来读取已移除；regime 翻转先 provisional、下一根收盘确认。
- [ ] `pnpm brooks:selftest` 与 `pnpm brooks:causality` 全绿：前缀一致性、逐根一致性、未收盘拒绝三项通过。
- [ ] 每个结构事件带 `ruleId/ruleVersion/knownAt`；摆动类事件 pivotTime 与 knownAt 分离且 knownAt 更晚。
- [ ] 失效事件追加写入 `invalidatedAt`，历史已发布证据不被覆盖。
- [ ] 同一行情允许多空证据并存；无信号区间不强迫产出信号。
- [ ] 全代码库不存在把 H2≈60%/80% 等经验数值当预测概率的输出路径；`BrooksSignal` 无 `prior` 语义残留。
- [ ] 规则清单中每条规则的分级标记（官方定义/工程阈值/本地统计）齐全，工程阈值集中在 `parameters/engineeringAssumptions`。

## 参考来源

- docs/specs/market-data.md、docs/specs/prediction.md、docs/specs/evaluation-deployment.md
- docs/brooks-agent-architecture.md（§5 结构引擎、§11 因果性验证调研）
- docs/brooks-price-action-manual.md（规则 → 量化映射底稿）
- shared/src/regime.ts、shared/src/analyze.ts、shared/src/types.ts、shared/src/signals.ts
- Brooks 官方术语表：https://www.brookstradingcourse.com/price-action-trading-terms-glossary/
- Brooks 缩写表：https://www.brookstradingcourse.com/brooks-price-action-abbreviations/
- Freqtrade 前视偏差检查方法：https://docs.freqtrade.io/en/stable/lookahead-analysis/
