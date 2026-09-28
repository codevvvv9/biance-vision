# Al Brooks 价格行为 · 理论实践手册（量化版）

> 本手册是 `/brooks` 价格行为复盘页的理论底稿：梳理 Al Brooks 的技能体系，并把书中规则
> 逐条映射为本仓库 `web/src/brooks/` 引擎中的确定性代码。所有量化阈值均标注出处，
> 供复盘时对照「信号为什么触发」。

---

## 1. 人物与体系

**Al Brooks（阿尔·布鲁克斯）**：眼科医生转行的日内交易员，深耕价格行为（Price Action）
三十余年，被誉为现代价格行为分析的代表人物。其体系的核心主张：

- **不依赖任何指标**（唯一的"指标"是 20 周期 EMA，且只作参考基准而非信号源）；
- 一切信息都在 **K 线本身与K线序列** 中——每根K线是多空力量博弈的结果；
- 市场只有两种状态：**趋势** 与 **交易区间**，并在两者间循环（spike → channel → range → breakout）；
- 交易的本质是 **概率**：用"交易者方程"（胜率×盈亏比 > 败率）过滤，而不是预测。

国内最知名的是他的三部曲：

| 中文书名 | 原名 | 侧重 |
|---|---|---|
| 价格行为交易：逐根K线分析 | Trading Price Action: Trading Ranges to Trends（第1卷） | 单根K线读法、信号棒/入场棒 |
| 高级趋势技术分析 | Trading Price Action: Trends（第2卷） | 趋势腿、回调、spike & channel、趋势线 |
| 高级反转技术分析 | Trading Price Action: Reversals（第3卷） | 主要趋势反转 MTR、双顶底、楔形、衰竭 |

**第一手权威来源**：
- 官方词汇表（本手册绝大多数定义的出处）：
  https://www.brookstradingcourse.com/price-action-trading-terms-glossary
- Wiley 官方书内词汇表 PDF：https://onlinelibrary.wiley.com/doi/pdf/10.1002/9781119203117.gloss
- 社区论坛（定义讨论 / 经验统计溯源）：https://www.brookspriceaction.com

---

## 2. 技能树（从读单根K线到交易决策）

```
L1 读K线        趋势棒 / doji / 尾巴 / 收盘位置 / 内包 i / 外包 O / ii·oo·ioi / 缺口
L2 结构         摆动高低点(微观↔主要) → HH/HL/LH/LL → 腿 Leg → 两腿回调 → 测量移动 AB=CD
L3 市场状态     趋势(spike|channel) vs 交易区间(含 TTR/barbwire) · Always In 方向
L4 信号         H1~H4 / L1~L4 · 楔形三推 · 双顶底 · ii 突破 · 趋势线突破 TLB · MTR · 区间突破
L5 概率过滤     80% 规则族 · 二次进场先验 ≈60% · 交易者方程（本工具暂不做，见 §6）
```

---

## 3. 规则 → 量化标准映射表（本引擎实现）

### 3.1 单根K线特征（`web/src/brooks/bars.ts`）

| 概念 | Brooks 定义（词汇表） | 本引擎量化 | 信号含义 |
|---|---|---|---|
| 趋势棒 trend bar | 开盘近一端、收盘近另一端 | `bodyRatio = |c-o|/(h-l) ≥ 0.55` | 方向动能 |
| Doji | 开收盘接近，微型交易区间 | `bodyRatio ≤ 0.30` | 观望/均衡 |
| 内包线 inside bar | 高低点被前棒完全包含 | `h ≤ h[prev] && l ≥ l[prev]`（含等于） | 突破模式、观望 |
| 外包线 outside bar | 高低点吞没前棒 | `h ≥ h[prev] && l ≤ l[prev]` | 二次突破（H2/L2）前兆 |
| ii / iii | 连续 2/3 根内包 | `inside[i] && inside[i-1]` … | 日内最可靠突破形态之一 |
| oo | 连续外包 | `outside[i] && outside[i-1]` | ii 的突破棒变体 |
| ioi | 内-外-内 | 三棒序列判定 | 突破模式 |
| 无尾棒 shaved bar | 一端无尾巴 | 尾 ≤ 2% 全幅 | 极端动能 |

阈值出处：ByteBard/ict-stradegy 用 0.60/0.30，AxisJu/price-action-skills 用 0.45/0.25，开源共识折中 0.55/0.30。

### 3.2 摆动点与腿（`web/src/brooks/swings.ts`）

| 概念 | Brooks 定义 | 本引擎量化 |
|---|---|---|
| 摆动高点 | 高点左侧、右侧各 ≥1 根更低高点；**根数取决于上下文**（微观 1~2 根，主要 10+ 根） | 分形枢轴：左侧 k 根严格更低 + 右侧 k 根不更高；k 可选 1/2/3/5（页面"摆动尺度"） |
| 摆动低点 | 镜像 | 同上 |
| 确认滞后 | — | 摆动点在右侧第 k 根收盘后才成立（`confirmIndex`），**信号不重绘** |
| HH/LH/HL/LL | 与上一个同向摆动点比较 | 严格比较：等高记为 LH/LL（近似等高由双顶规则另判） |
| 腿 Leg | 相邻摆动点间的单向移动 | zigzag 高低交替；同向相邻取更极端者 |
| 回调深度 | 通道中回调 ≤ 前腿一半 | `retracementOfPrev = 本腿幅度/前腿幅度` |
| 测量移动 AB=CD | 一腿约等于前一腿 | H/L 信号 `ref.target` 用等距投影 |

出处：官方词汇表 swing high 词条 + TradingView《Al Brooks Second Entry》的"N 根确认 + isconfirmed 防重绘"实践。

### 3.3 市场状态（`web/src/brooks/regime.ts`）

| 概念 | Brooks 定义 | 本引擎量化 |
|---|---|---|
| 趋势 | 过去 10~20 根收盘大部分在 EMA20 一侧 | 20 根窗口 ≥70% 在上 = 多头通道，≤30% = 空头通道（AxisJu 用 11/15≈73%） |
| 冲刺 Spike | 强突破、连续趋势棒 | ≥5 根连续同向趋势棒 且累计 ≥1.5×ATR(14) |
| 交易区间 TR | 至少 20 根无法确认方向，突破多失败 | EMA 占比 30%~70% 之间 |
| 紧凑区间 TTR | ≥3 根大部分重叠 | 最近 3 根总覆盖 ≤1.5×最大单根幅度 |
| 铁丝网 Barbwire | 重叠 + doji 的紧凑区间，**不交易区** | TTR 且含 doji |
| Always In | 若必须持仓非多即空的方向 | 同向状态持续 ≥4 根才翻转（冲刺 2 根即可）——对应 Brooks"一天只翻 2~5 次" |

80% 规则族（Brooks 经验统计，先验展示于信号中）：交易区间突破尝试 80% 失败；首次突破仅约 50% 存活；
趋势中 80% 的反转尝试只是回调；MTR 后约 80% 至少演变为区间。

### 3.4 信号（`web/src/brooks/signals.ts`）

| 信号 | 规则（本引擎） | 概念出处与先验 |
|---|---|---|
| **H1~H4** | 多头环境（收盘 > EMA20）：回调中出现更低高点后，某根高点上穿前根高点 = Hn；创趋势新高则计数清零；n>4 不发 | 《价格行为交易》回调计数。**H2 = 二次进场，体系内胜率最高（先验 ≈60%）**；参考位：突破价=信号棒高点，止损=本段回调低点，目标=AB=CD 等距 |
| **L1~L4** | 镜像 | 同上 |
| **冲刺↑/↓** | 恰好第 5 根连续同向趋势棒时触发一次 | 《高级趋势技术分析》spike and channel；逆冲刺首单 80% 失败 |
| **楔顶/楔底** | 三个摆动高点严格递升（底镜像），跨度 6~40 根，推间必有摆动回调；第三推幅度 < 0.9×第一推 = 动能衰减（high 强度） | 《高级反转技术分析》"任意三推都当楔形交易"；目标 = 楔形全幅回到起点 |
| **双顶/双底** | 相邻两摆动点差 ≤0.3×ATR、间隔 3~60 根、中间回落(反弹) ≥0.5×ATR | "第二高点测试前高失败（1 tick 更高也算）"；目标 = 高度自颈线下投/上投 |
| **ii↑/ii↓** | ii 形态后 5 根内收盘上破/下破形态极值，先到先得 | ii = 日内最可靠突破形态之一 |
| **外包↑/↓** | 外包线后一根收盘创其新高/新低 | 外包线后常跟 H2/L2 |
| **破线↓/↑ TLB** | 连接最近两个已确认摆动点（斜率合法、80 根内有效）的趋势线被收盘穿越；要求此前 40 根内确有趋势 | 趋势减弱的**第一个**信号；约 50% 恢复趋势、50% 走向反转——只作警戒 |
| **MTR** | TLB 后 20 根内：收盘击穿趋势线起点摆动点，或（出现回测后）强反转趋势棒收破 EMA | 《高级反转技术分析》：趋势线突破+测试+反转信号三步齐备才是主要趋势反转；成立后约 80% 至少变区间 |
| **区间破↑/↓** | ≥10 根交易区间后，趋势棒收盘突破区间极值（40 根窗口内首个方向） | 80% 失败先验，只作研究关注；目标 = 区间高度等距 |

工程要点：所有信号在收盘K线上产生（REST 会剔除未收盘的最后一根，WS tick 只进图表不进分析）；
摆动点类信号落在 `confirmIndex`（诚实展示 k 根滞后）；趋势线状态机在破位窗口内冻结，
防止反向摆动点抢先换线吞掉 MTR 序列。

---

## 4. 概率先验速查（Brooks 经验统计口径）

| 先验 | 数值 | 用法 |
|---|---|---|
| 区间突破尝试失败率 | ≈80% | 区间信号只做研究，等突破测试二次进场 |
| 首次突破存活率 | ≈50% | 突破后回测不破 = 低风险二买 |
| H2/L2 二次进场胜率 | ≈60% | 趋势中顺势回调计数 |
| 趋势中反转尝试失败 | ≈80% | 首次反转信号大概率只是回调（两腿） |
| TLB 后走向 | 50/50 | 趋势线破位必须等测试+反转确认 |
| MTR 后演变 | ≈80% 至少变区间 | 反转的最低预期是反向两腿 |

> 注意：这些是 Brooks 在美股股指期货上的经验统计，不同品种/周期需自行重估——这也是本工具
> 把"先验"作为独立字段展示而非写进判定逻辑的原因。

---

## 5. 开源实现参考（调研结论）

| 仓库/脚本 | 借鉴点 |
|---|---|
| [AxisJu/price-action-skills](https://github.com/AxisJu/price-action-skills) (Python) | EMA20+15棒市场循环分类；H/L 状态机；楔形 3 摆动+40 棒跨度 |
| [ByteBard/ict-stradegy](https://github.com/ByteBard/ict-stradegy) (Python) | candle 分类阈值 0.60/0.30；双底 10% 容差；MTR 10 根窗口；registry 分层 |
| [TradingView: Al Brooks Second Entry](https://www.tradingview.com/script/YUixSlPL-Al-Brooks-Second-Entry/) (Pine) | N 根确认 swing + isconfirmed 防重绘；H2 信号棒强度过滤（收顶 30%） |
| [TradingView: PA Intraday Setups](https://www.tradingview.com/script/bOU4RciY-PA-Intraday-Setups/) (Pine v6) | 趋势分类阈值 0.40、窗口 15/20 根 |
| [TradingView: Brooks Price Action Scalper](https://www.tradingview.com/script/clk3xB1L-Brooks-Price-Action-Scalper/) (Pine) | always-in 双行仲裁 + UNCLEAR（弃权态）设计 |
| [kayasolomon/market-structure-engine](https://github.com/kayasolomon/market-structure-engine) (TS) | 不重绘摆动结构的 TS 参考实现 |
| [oficcejo/2pa-agent-rust](https://github.com/oficcejo/2pa-agent-rust) (Rust) | "LLM 提议 + 确定性程序守门"架构、0.2×ATR 止损缓冲 |

已知坑（本引擎的对策）：
1. **重绘**：fractal 摆动天然滞后 k 根 → 只在收盘后确认，UI 明示 confirmIndex；
2. **k 值敏感**：k=1 噪音多、k≥5 信号滞后 → 页面提供 1/2/3/5 尺度切换，Brooks 本人强调市场分形、
   换尺度读同一份K线本就是训练；
3. **Brooks 反对机械定义**：任何单参数实现都是近似 → 多尺度 + 概率先验独立展示，不冒充"正确答案"。

---

## 6. AI 联动（结构引擎 × AI 助手）

引擎已抽为共享包 `shared/`（`biance-vision-brooks`，pnpm workspace）：web 复盘页与服务端 AI
共用同一份结构识别代码，三条链路：

1. **🤖 AI 解读按钮**（/brooks 页）：把当前结构摘要（状态/Always In/摆动序列/最近8条信号）
   一键注入 AI 助手会话，按 Brooks 框架解读，并要求区分高先验信号与"大概率只是回调"的信号；
2. **AI 工具 `brooks_structure`**（function calling）：模型可自主调用，参数
   `{symbol, interval, limit≤500, swing_k}`，返回结构化摘要 + 术语速查，自然语言问
   "BTC 现在什么结构"即可触发；
3. **斜杠命令 `/brooks BTC 1h`**（别名 `/pa`）：本地直执行不消耗对话次数，结果落入会话可继续追问。

术语学习：复盘页摘要标签带「!」悬停解释（`web/src/brooks/terms.tsx` 词条字典），
信号种类悬停显示术语定义，图例弹窗含完整规则速查。

## 7. 本工具实现边界与迭代方向

**已实现**：单根K线特征、多尺度摆动点、腿/AB=CD、趋势/震荡/冲刺/铁丝网状态机、Always In、
H1~H4/L1~L4、楔形、双顶底、ii/外包突破、TLB、MTR、区间突破、图上全量标注 + 规则出处信号面板、
AI 三链路联动（上述）、术语「!」提醒。

**暂未实现（按 Brooks 体系优先级排序的 roadmap）**：
1. **微通道（micro channel）**：连续不回调的微型趋势线及其突破——紧贴趋势棒序列的更精细结构；
2. **突破测试（breakout test）后的二次进场标注**：已有 TLB/MTR 的 test 内部状态，尚未独立成信号；
3. **交易者方程过滤层**：胜率×盈亏比 > 败率的量化放行（需要信号分级与品种自校准）；
4. **多周期共振**：高一级别结构对低级别信号的门控（Brooks 的 5 分/1 时/日线三屏法）；
5. **信号统计回测**：按"信号棒后 1 根开盘成交"口径统计各形态在本品种的真实胜率，替换经验先验。

**复现/自测**：`pnpm brooks:selftest`（合成K线验证 9 组场景，36 项断言全通过）。

**引擎 API**（共享包 `biance-vision-brooks`，源码 `shared/src/`，改后 `pnpm --filter biance-vision-brooks run build`，
根目录 dev/build 已自动带上）：
`analyzeBrooks(candles: BrooksCandle[], { swingK: 1|2|3|5 })` →
`BrooksAnalysis { features, swings, legs, regimeAt, alwaysIn, signals, summary }`，
纯函数零依赖，千根K线毫秒级。
