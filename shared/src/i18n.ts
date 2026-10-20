/**
 * 引擎文案词典：signals/regime/swings/analyze 产出的用户可见中英文案集中于此。
 * 零第三方依赖；msg() 支持 {var} 占位符插值，缺 key 回退 zh-CN，再回退 key 本身。
 * 所有引擎函数默认 locale = 'zh-CN'，不传参时输出与词典化前完全一致。
 */

export type SharedLocale = 'zh-CN' | 'en-US'

export const SIGNAL_MESSAGES: Record<string, { 'zh-CN': string; 'en-US': string }> = {
  // ── H1~H4 / L1~L4 回调计数 ──
  'hl.title.h1': { 'zh-CN': 'H1 · 多头第一次进场尝试', 'en-US': 'H1 · first bull entry attempt' },
  'hl.title.h2': { 'zh-CN': 'H2 · 多头二次进场', 'en-US': 'H2 · bull second entry' },
  'hl.title.h3': { 'zh-CN': 'H3 · 多头第三次进场尝试', 'en-US': 'H3 · third bull entry attempt' },
  'hl.title.h4': { 'zh-CN': 'H4 · 多头第四次进场尝试（警惕趋势衰竭）', 'en-US': 'H4 · fourth bull entry attempt (watch for trend exhaustion)' },
  'hl.title.l1': { 'zh-CN': 'L1 · 空头第一次进场尝试', 'en-US': 'L1 · first bear entry attempt' },
  'hl.title.l2': { 'zh-CN': 'L2 · 空头二次进场', 'en-US': 'L2 · bear second entry' },
  'hl.title.l3': { 'zh-CN': 'L3 · 空头第三次进场尝试', 'en-US': 'L3 · third bear entry attempt' },
  'hl.title.l4': { 'zh-CN': 'L4 · 空头第四次进场尝试（警惕趋势衰竭）', 'en-US': 'L4 · fourth bear entry attempt (watch for trend exhaustion)' },
  'hl.note.1': {
    'zh-CN': 'Brooks 经验统计：趋势中首次反转尝试大多只是回调（美股股指期货口径，非本品种验证结论）',
    'en-US': "Brooks' empirical statistics: the first reversal attempt in a trend is usually just a pullback (US stock index futures context, not validated on this instrument)",
  },
  'hl.note.2': {
    'zh-CN': 'H2/L2 是 Brooks 体系中最常用的顺势回调二次进场（其美股股指期货经验统计约 60%，非本品种验证胜率）',
    'en-US': "H2/L2 is the most-used with-trend second entry in the Brooks framework (his US stock index futures estimate ≈60%, not a validated win rate for this instrument)",
  },
  'hl.note.3': {
    'zh-CN': '计数越高动能越弱；趋势惯性强时仍可顺势，但失败率上升（经验描述）',
    'en-US': 'Higher counts mean weaker momentum; with-trend entries can still work in persistent trends, but failure rates rise (qualitative guidance)',
  },
  'hl.note.4': {
    'zh-CN': 'H4/L4 常出现在趋势末期或震荡中，Brooks 建议降低预期（经验描述）',
    'en-US': 'H4/L4 often appear late in trends or inside ranges; Brooks advises lowering expectations (qualitative guidance)',
  },
  'hl.setup.bull': {
    'zh-CN': '多头回调开始（第 {bar} 根高点低于前一根），进入 H/L 计数上下文',
    'en-US': 'Bull pullback begins (bar {bar} makes a lower high than the prior bar); H/L counting context engaged',
  },
  'hl.setup.bear': {
    'zh-CN': '空头回调开始（第 {bar} 根低点高于前一根），进入 L 计数上下文',
    'en-US': 'Bear pullback begins (bar {bar} makes a higher low than the prior bar); L counting context engaged',
  },
  'hl.reason.bull': {
    'zh-CN': '第 {bar} 根K线高点 {price} 上穿前一根高点，为本轮多头回调的第 {count} 次进场尝试；回调低点 {stop}，趋势极值 {extreme}',
    'en-US': 'Bar {bar} high {price} breaks above the prior bar high — bull entry attempt #{count} of this pullback; pullback low {stop}, trend extreme {extreme}',
  },
  'hl.reason.bear': {
    'zh-CN': '第 {bar} 根K线低点 {price} 跌破前一根低点，为本轮空头回调的第 {count} 次进场尝试；回调高点 {stop}，趋势极值 {extreme}',
    'en-US': 'Bar {bar} low {price} breaks below the prior bar low — bear entry attempt #{count} of this pullback; pullback high {stop}, trend extreme {extreme}',
  },
  'hl.concept.bull': {
    'zh-CN': '《价格行为交易》：多头腿中突破前一根K线高点 = H1；失败后的第二次尝试 = H2（二次进场）',
    'en-US': 'Trading Price Action: in a bull leg, breaking the prior bar high = H1; the second attempt after a failure = H2 (second entry)',
  },
  'hl.concept.bear': {
    'zh-CN': '《价格行为交易》：空头腿中跌破前一根K线低点 = L1；失败后的第二次尝试 = L2（二次进场）',
    'en-US': 'Trading Price Action: in a bear leg, breaking the prior bar low = L1; the second attempt after a failure = L2 (second entry)',
  },

  // ── 冲刺 Spike ──
  'spike.label.bull': { 'zh-CN': '冲刺↑', 'en-US': 'Spike↑' },
  'spike.label.bear': { 'zh-CN': '冲刺↓', 'en-US': 'Spike↓' },
  'spike.title.bull': { 'zh-CN': '多头冲刺启动（Spike）', 'en-US': 'Bull spike start (Spike)' },
  'spike.title.bear': { 'zh-CN': '空头冲刺启动（Spike）', 'en-US': 'Bear spike start (Spike)' },
  'spike.reason': {
    'zh-CN': '连续 5 根同向趋势棒（实体占比 ≥55%），累计幅度 {range} ≈ {atrMult}×ATR',
    'en-US': 'Five consecutive same-direction trend bars (body ratio ≥55%), total range {range} ≈ {atrMult}×ATR',
  },
  'spike.concept': {
    'zh-CN': '《高级趋势技术分析》spike and channel：冲刺腿是趋势最强阶段，回调通常止于通道起点',
    'en-US': 'Trading Price Action Trends, spike and channel: the spike is the strongest trend phase; pullbacks usually stop near the channel origin',
  },
  'spike.note': {
    'zh-CN': 'Brooks 经验统计：冲刺后进入通道的概率高；逆冲刺的首次交易大多失败（美股股指期货口径）',
    'en-US': "Brooks' empirical statistics: spikes often continue into channels; first trades against a spike mostly fail (US stock index futures context)",
  },

  // ── 楔形 Wedge ──
  'wedge.label.top': { 'zh-CN': '楔顶', 'en-US': 'Wedge Top' },
  'wedge.label.bottom': { 'zh-CN': '楔底', 'en-US': 'Wedge Bottom' },
  'wedge.title.top': { 'zh-CN': '三推楔形顶（第3推 {price}）', 'en-US': 'Three-push wedge top (3rd push {price})' },
  'wedge.title.bottom': { 'zh-CN': '三推楔形底（第3推 {price}）', 'en-US': 'Three-push wedge bottom (3rd push {price})' },
  'wedge.fading': { 'zh-CN': '· 动能衰减', 'en-US': '· fading momentum' },
  'wedge.reason.top': {
    'zh-CN': '三个摆动高点依次抬升 {h1} → {h2} → {h3}（跨度 {span} 根）；第三推幅度 {push2}',
    'en-US': 'Three swing highs rising {h1} → {h2} → {h3} (span {span} bars); third push size {push2}',
  },
  'wedge.reason.bottom': {
    'zh-CN': '三个摆动低点依次下移 {l1} → {l2} → {l3}（跨度 {span} 根）；第三推幅度 {push2}',
    'en-US': 'Three swing lows falling {l1} → {l2} → {l3} (span {span} bars); third push size {push2}',
  },
  'wedge.reasonFading': {
    'zh-CN': ' 小于第一推 {push1}（动能递减）',
    'en-US': ' below the first push {push1} (fading momentum)',
  },
  'wedge.concept.top': {
    'zh-CN': '《高级反转技术分析》：任意三推形态都当楔形交易；第三推常由微型趋势通道线延伸产生，反转目标为楔形起点',
    'en-US': 'Trading Price Action Reversals: treat any three pushes as a wedge; the third push often comes from a micro trend-channel overshoot, and the reversal targets the wedge origin',
  },
  'wedge.concept.bottom': {
    'zh-CN': '《高级反转技术分析》：下跌三推衰竭后的楔形底，是空头趋势转多的经典反转结构',
    'en-US': 'Trading Price Action Reversals: a wedge bottom after three exhausted pushes down is the classic bear-to-bull reversal structure',
  },
  'wedge.note.top': {
    'zh-CN': 'Brooks 经验统计：楔形反转后常见两腿回调；测量目标 = 楔形全幅回到起点（形态学目标，非胜率）',
    'en-US': "Brooks' empirical statistics: wedge reversals are often followed by two-legged pullbacks; measured target = full retrace to the wedge origin (pattern-based target, not a win rate)",
  },
  'wedge.note.bottom': {
    'zh-CN': 'Brooks 经验统计：楔形底反转后常见两腿上涨；测量目标 = 楔形全幅回到起点（形态学目标，非胜率）',
    'en-US': "Brooks' empirical statistics: wedge-bottom reversals are often followed by two-legged rallies; measured target = full retrace to the wedge origin (pattern-based target, not a win rate)",
  },

  // ── 双顶 / 双底 ──
  'double.label.top': { 'zh-CN': '双顶', 'en-US': 'Double Top' },
  'double.label.bottom': { 'zh-CN': '双底', 'en-US': 'Double Bottom' },
  'double.title.top': { 'zh-CN': '双顶 {price}', 'en-US': 'Double top {price}' },
  'double.title.bottom': { 'zh-CN': '双底 {price}', 'en-US': 'Double bottom {price}' },
  'double.reason.top': {
    'zh-CN': '两个摆动高点近似等高（{p1} / {p2}，差 {diff} ≤ 0.3×ATR），中间回落至 {dip}',
    'en-US': 'Two swing highs at nearly the same level ({p1} / {p2}, diff {diff} ≤ 0.3×ATR), with an intervening dip to {dip}',
  },
  'double.reason.bottom': {
    'zh-CN': '两个摆动低点近似等低（{p1} / {p2}，差 {diff} ≤ 0.3×ATR），中间反弹至 {bump}',
    'en-US': 'Two swing lows at nearly the same level ({p1} / {p2}, diff {diff} ≤ 0.3×ATR), with an intervening bounce to {bump}',
  },
  'double.concept.top': {
    'zh-CN': '《高级反转技术分析》双顶：第二高点测试前高失败（1 tick 更高也算），跌破颈线（中间低点）确认',
    'en-US': 'Trading Price Action Reversals, double top: the second high fails the test of the prior high (1 tick higher still counts); a break of the neck line (intervening low) confirms',
  },
  'double.concept.bottom': {
    'zh-CN': '《高级反转技术分析》双底：第二低点测试前低失败，收破中间高点（颈线）确认反转',
    'en-US': 'Trading Price Action Reversals, double bottom: the second low fails the test of the prior low; a close beyond the intervening high (neck line) confirms the reversal',
  },
  'double.note.top': {
    'zh-CN': '形态学测量目标 = 双顶高度自颈线下投（目标位约定，非胜率）',
    'en-US': 'Pattern-based measured target = double-top height projected down from the neck line (target convention, not a win rate)',
  },
  'double.note.bottom': {
    'zh-CN': '形态学测量目标 = 双底高度自颈线上投（目标位约定，非胜率）',
    'en-US': 'Pattern-based measured target = double-bottom height projected up from the neck line (target convention, not a win rate)',
  },

  // ── ii 突破 + 外包线反转 ──
  'ii.label.up': { 'zh-CN': 'ii↑', 'en-US': 'ii↑' },
  'ii.label.down': { 'zh-CN': 'ii↓', 'en-US': 'ii↓' },
  'ii.title.up': { 'zh-CN': 'ii 形态向上突破', 'en-US': 'ii pattern upside breakout' },
  'ii.title.down': { 'zh-CN': 'ii 形态向下突破', 'en-US': 'ii pattern downside breakout' },
  'ii.reason.up': {
    'zh-CN': '第 {bornBar} 根出现连续内包（ii）后，第 {bar} 根收盘 {close} 上破形态高点 {high}',
    'en-US': 'After consecutive inside bars (ii) at bar {bornBar}, bar {bar} closes at {close} above the pattern high {high}',
  },
  'ii.reason.down': {
    'zh-CN': '第 {bornBar} 根出现连续内包（ii）后，第 {bar} 根收盘 {close} 跌破形态低点 {low}',
    'en-US': 'After consecutive inside bars (ii) at bar {bornBar}, bar {bar} closes at {close} below the pattern low {low}',
  },
  'ii.concept.up': {
    'zh-CN': '《价格行为交易》：ii = 连续两根内包线，突破模式；ii 突破属日内最可靠的突破形态之一',
    'en-US': 'Trading Price Action: ii = two consecutive inside bars, a breakout mode; ii breakouts are among the most reliable intraday breakout patterns',
  },
  'ii.concept.down': {
    'zh-CN': '《价格行为交易》：ii = 连续两根内包线，突破模式；向下突破常引发空头趋势腿',
    'en-US': 'Trading Price Action: ii = two consecutive inside bars, a breakout mode; downside breakouts often start a bear trend leg',
  },
  'ii.note': {
    'zh-CN': 'Brooks 经验描述：ii 突破沿突破方向延续的概率显著高于单根内包线（定性描述，非数值胜率）',
    'en-US': "Brooks' qualitative guidance: ii breakouts continue in the breakout direction far more often than single inside bars (qualitative, not a numeric win rate)",
  },
  'ii.setup': {
    'zh-CN': 'ii 形态登记（第 {barA}、{barB} 根连续内包），等待 5 根内收盘突破 {high} / {low}',
    'en-US': 'ii pattern registered (consecutive inside bars at bars {barA} and {barB}); awaiting a close beyond {high} / {low} within 5 bars',
  },
  'ii.expiry': {
    'zh-CN': 'ii 形态（第 {bornBar} 根登记）5 根内未被收盘突破，形态失效',
    'en-US': 'ii pattern (registered at bar {bornBar}) was not closed out within 5 bars; pattern expired',
  },
  'ob.label.up': { 'zh-CN': '外包↑', 'en-US': 'Outside↑' },
  'ob.label.down': { 'zh-CN': '外包↓', 'en-US': 'Outside↓' },
  'ob.title.up': { 'zh-CN': '外包线多头反转跟随', 'en-US': 'Outside-bar bull reversal follow-through' },
  'ob.title.down': { 'zh-CN': '外包线空头反转跟随', 'en-US': 'Outside-bar bear reversal follow-through' },
  'ob.reason.up': {
    'zh-CN': '第 {bar} 根外包线吞没前一根后，下一根收盘 {close} 站上外包线高点 {high}',
    'en-US': 'After the outside bar at bar {bar} engulfs the prior bar, the next bar closes at {close} above the outside-bar high {high}',
  },
  'ob.reason.down': {
    'zh-CN': '第 {bar} 根外包线吞没前一根后，下一根收盘 {close} 跌破外包线低点 {low}',
    'en-US': 'After the outside bar at bar {bar} engulfs the prior bar, the next bar closes at {close} below the outside-bar low {low}',
  },
  'ob.concept.up': {
    'zh-CN': '《价格行为交易》：外包线（outside bar）之后常出现二次突破（H2/L2），多头跟随确认',
    'en-US': 'Trading Price Action: outside bars are often followed by second breakouts (H2/L2); bull follow-through confirms',
  },
  'ob.concept.down': {
    'zh-CN': '《价格行为交易》：外包线（outside bar）之后常出现二次突破（H2/L2），空头跟随确认',
    'en-US': 'Trading Price Action: outside bars are often followed by second breakouts (H2/L2); bear follow-through confirms',
  },
  'ob.note': {
    'zh-CN': 'Brooks 经验描述：外包线后的反向突破可靠性中等，常演变为两段式行情（定性描述）',
    'en-US': "Brooks' qualitative guidance: post-outside-bar counter breakouts are moderately reliable and often evolve into two-legged moves (qualitative)",
  },

  // ── 趋势线突破 TLB → MTR ──
  'tlb.label.down': { 'zh-CN': '破线↓', 'en-US': 'TLB↓' },
  'tlb.label.up': { 'zh-CN': '破线↑', 'en-US': 'TLB↑' },
  'tlb.title.bull': { 'zh-CN': '多头趋势线被收盘跌穿（警戒）', 'en-US': 'Bull trend line broken by a close below (warning)' },
  'tlb.title.bear': { 'zh-CN': '空头趋势线被收盘上穿（警戒）', 'en-US': 'Bear trend line broken by a close above (warning)' },
  'tlb.pivot.low': { 'zh-CN': '低点', 'en-US': 'lows' },
  'tlb.pivot.high': { 'zh-CN': '高点', 'en-US': 'highs' },
  'tlb.reason': {
    'zh-CN': '连接摆动{pivot} {p1}(第{b1}根) 与 {p2}(第{b2}根) 的趋势线，在第 {bar} 根被收盘穿越（线值 {line}，收盘 {close}）',
    'en-US': 'The trend line connecting swing {pivot} {p1} (bar {b1}) and {p2} (bar {b2}) was crossed by the close of bar {bar} (line value {line}, close {close})',
  },
  'tlb.concept': {
    'zh-CN': '《高级反转技术分析》：趋势线突破是趋势减弱的第一个信号，但需要「测试 + 反转信号」确认',
    'en-US': 'Trading Price Action Reversals: a trend-line break is the first sign of trend weakness, but needs "test + reversal signal" confirmation',
  },
  'tlb.note': {
    'zh-CN': 'Brooks 经验统计：趋势线被突破后约半数最终反转、半数恢复原趋势（美股股指期货口径，只作警戒）',
    'en-US': "Brooks' empirical statistics: about half of trend-line breaks lead to reversals and half resume the trend (US stock index futures context; treat as warning only)",
  },
  'mtr.title.bull': { 'zh-CN': '主要趋势反转（多头 → 空头）', 'en-US': 'Major trend reversal (bull → bear)' },
  'mtr.title.bear': { 'zh-CN': '主要趋势反转（空头 → 多头）', 'en-US': 'Major trend reversal (bear → bull)' },
  'mtr.reason': {
    'zh-CN': '第 {breakBar} 根趋势线破位{tested}后，第 {bar} 根{confirm}，MTR 序列完成',
    'en-US': 'After the trend-line break at bar {breakBar}{tested}, bar {bar} {confirm} — MTR sequence complete',
  },
  'mtr.tested': { 'zh-CN': '、出现回测', 'en-US': ' and a retest' },
  'mtr.confirm.origin.low': {
    'zh-CN': '收盘 {close} 击穿趋势线起点摆动低点',
    'en-US': 'closed at {close} through the swing low at the line origin',
  },
  'mtr.confirm.origin.high': {
    'zh-CN': '收盘 {close} 击穿趋势线起点摆动高点',
    'en-US': 'closed at {close} through the swing high at the line origin',
  },
  'mtr.confirm.strong': {
    'zh-CN': '以强反转趋势棒收盘确认',
    'en-US': 'confirmed with a strong reversal trend-bar close',
  },
  'mtr.concept': {
    'zh-CN': '《高级反转技术分析》MTR：趋势线突破 → 测试 → 反转信号（HL/LH），三者齐备才是主要趋势反转',
    'en-US': 'Trading Price Action Reversals, MTR: trend-line break → test → reversal signal (HL/LH) — all three are required for a major trend reversal',
  },
  'mtr.note': {
    'zh-CN': 'Brooks 经验统计：MTR 成立后市场大多至少演变为区间，反向两腿是最低预期（美股股指期货口径）',
    'en-US': "Brooks' empirical statistics: once an MTR completes, the market usually evolves into at least a range; two counter legs is the minimum expectation (US stock index futures context)",
  },

  // ── 交易区间突破 ──
  'tr.label.up': { 'zh-CN': '区间破↑', 'en-US': 'TR BO↑' },
  'tr.label.down': { 'zh-CN': '区间破↓', 'en-US': 'TR BO↓' },
  'tr.title.up': { 'zh-CN': '交易区间向上突破', 'en-US': 'Trading-range upside breakout' },
  'tr.title.down': { 'zh-CN': '交易区间向下突破', 'en-US': 'Trading-range downside breakout' },
  'tr.reason.up': {
    'zh-CN': '第 {from}~{to} 根构成 {len} 根交易区间（{lo}~{hi}），第 {bar} 根以趋势棒收盘 {close} 上破区间高点',
    'en-US': 'Bars {from}~{to} form a {len}-bar trading range ({lo}~{hi}); bar {bar} closes at {close} with a trend bar above the range high',
  },
  'tr.reason.down': {
    'zh-CN': '第 {from}~{to} 根构成 {len} 根交易区间（{lo}~{hi}），第 {bar} 根以趋势棒收盘 {close} 跌破区间低点',
    'en-US': 'Bars {from}~{to} form a {len}-bar trading range ({lo}~{hi}); bar {bar} closes at {close} with a trend bar below the range low',
  },
  'tr.concept.up': {
    'zh-CN': '《高级区间技术分析》：区间突破需强趋势棒确认；突破后回测区间顶（突破测试）是低风险二次进场',
    'en-US': 'Trading Price Action Trading Ranges: range breakouts need a strong trend bar; a retest of the range top (breakout test) is the low-risk second entry',
  },
  'tr.concept.down': {
    'zh-CN': '《高级区间技术分析》：区间突破需强趋势棒确认；突破后回测区间底（突破测试）是低风险二次进场',
    'en-US': 'Trading Price Action Trading Ranges: range breakouts need a strong trend bar; a retest of the range bottom (breakout test) is the low-risk second entry',
  },
  'tr.note': {
    'zh-CN': 'Brooks 经验统计：区间突破尝试大多失败、首次突破约半数存活（美股股指期货口径）——本信号仅作结构研究',
    'en-US': "Brooks' empirical statistics: most range breakout attempts fail and only about half of first breakouts survive (US stock index futures context) — this signal is for structural research only",
  },

  // ── 失效事件 ──
  'invalidation.note': {
    'zh-CN': '{label}（第 {triggerBar} 根触发）后第 {bar} 根收盘 {close} 击穿结构止损 {stop}，结构失效',
    'en-US': 'After {label} (triggered at bar {triggerBar}), bar {bar} closes at {close} through the structural stop {stop}; structure invalidated',
  },

  // ── analyze 事件流 ──
  'event.swing.high': {
    'zh-CN': '摆动高点 {label}（第 {bar} 根，第 {confirmBar} 根收盘确认）',
    'en-US': 'Swing high {label} (bar {bar}, confirmed by the close of bar {confirmBar})',
  },
  'event.swing.low': {
    'zh-CN': '摆动低点 {label}（第 {bar} 根，第 {confirmBar} 根收盘确认）',
    'en-US': 'Swing low {label} (bar {bar}, confirmed by the close of bar {confirmBar})',
  },
  'event.legProvisional': {
    'zh-CN': '未完成腿（进行中，可延伸，不可作为回放依据）',
    'en-US': 'Unfinished leg (in progress, may extend; not usable as replay evidence)',
  },

  // ── 市场状态 regime ──
  'regime.confirmNote': {
    'zh-CN': '市场状态确认为 {type}（raw 自第 {atBar} 根翻转，第 {knownBar} 根收盘确认）',
    'en-US': 'Market regime confirmed as {type} (raw flipped at bar {atBar}, confirmed by the close of bar {knownBar})',
  },
  'regime.text.spike_bull': { 'zh-CN': '多头冲刺（Spike）：连续强趋势棒上攻', 'en-US': 'Bull spike: consecutive strong trend bars driving up' },
  'regime.text.channel_bull': { 'zh-CN': '多头通道：收盘价大部分位于 EMA20 上方', 'en-US': 'Bull channel: closes mostly above the EMA20' },
  'regime.text.spike_bear': { 'zh-CN': '空头冲刺（Spike）：连续强趋势棒下杀', 'en-US': 'Bear spike: consecutive strong trend bars driving down' },
  'regime.text.channel_bear': { 'zh-CN': '空头通道：收盘价大部分位于 EMA20 下方', 'en-US': 'Bear channel: closes mostly below the EMA20' },
  'regime.text.trading_range': { 'zh-CN': '交易区间（震荡）：多空拉锯，80% 突破尝试失败', 'en-US': 'Trading range: two-sided tug-of-war; 80% of breakout attempts fail' },
  'regime.text.tight_range': { 'zh-CN': '紧凑交易区间：K线大幅重叠，突破质量差', 'en-US': 'Tight trading range: heavily overlapping bars, poor breakout quality' },
  'regime.text.barbwire': { 'zh-CN': '铁丝网（Barbwire）：重叠+doji，Brooks 建议不交易', 'en-US': 'Barbwire: overlapping bars with dojis; Brooks advises staying out' },
  'alwaysIn.initial': { 'zh-CN': '初始状态未定（数据不足或处于震荡）', 'en-US': 'Initial direction undetermined (insufficient data or ranging market)' },
  'alwaysIn.dir.bull': { 'zh-CN': '多头', 'en-US': 'bull' },
  'alwaysIn.dir.bear': { 'zh-CN': '空头', 'en-US': 'bear' },
  'alwaysIn.reason.spike': {
    'zh-CN': '{dir}冲刺（连续同向强趋势棒）确立新方向',
    'en-US': 'A {dir} spike (consecutive strong same-direction trend bars) establishes the new direction',
  },
  'alwaysIn.reason.trend': {
    'zh-CN': '{dir}趋势环境持续 ≥{count} 根（收盘价持续位于 EMA20 {side}）',
    'en-US': '{dir} trend regime persists for ≥{count} bars (closes staying {side} the EMA20)',
  },
  'alwaysIn.side.above': { 'zh-CN': '上方', 'en-US': 'above' },
  'alwaysIn.side.below': { 'zh-CN': '下方', 'en-US': 'below' },

  // ── 摆动与结构摘要 ──
  'swing.kind.high': { 'zh-CN': '高', 'en-US': 'high' },
  'swing.kind.low': { 'zh-CN': '低', 'en-US': 'low' },
  'structure.unformed': { 'zh-CN': '结构未定型（摆动点不足）', 'en-US': 'Structure not yet formed (insufficient swing points)' },
  'structure.bull': { 'zh-CN': '多头结构（HH + HL 交替抬升）', 'en-US': 'Bull structure (alternating HH + HL stepping up)' },
  'structure.bear': { 'zh-CN': '空头结构（LH + LL 交替下移）', 'en-US': 'Bear structure (alternating LH + LL stepping down)' },
  'structure.ranging': { 'zh-CN': '多空拉锯（高低点方向不一致，按震荡处理）', 'en-US': 'Two-sided stalemate (highs and lows disagree; treat as a range)' },
}

export function msg(key: string, vars: Record<string, string | number> = {}, locale: SharedLocale = 'zh-CN'): string {
  const entry = SIGNAL_MESSAGES[key]
  const template = entry?.[locale] ?? entry?.['zh-CN'] ?? key
  return template.replace(/\{(\w+)\}/g, (raw, name: string) => (name in vars ? String(vars[name]) : raw))
}
