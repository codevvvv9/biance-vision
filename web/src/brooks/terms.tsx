/**
 * Brooks 术语速查（「!」悬停提醒）：把复盘页上的专业术语映射为通俗解释 + 出处。
 * 信号面板在滚动容器内（绝对定位气泡会被裁剪），信号种类改用函数取文案配原生 title。
 * 词条双语存储（zh/en），消费端按当前 UI 语言取词。
 */

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { currentLocale } from '../i18n'
import type { AppLocale } from '../i18n'

export interface BrooksTermText {
  zh: string
  en: string
}

export interface BrooksTermDef {
  name: BrooksTermText
  def: BrooksTermText
  src?: BrooksTermText
}

function pick(text: BrooksTermText, locale: AppLocale): string {
  return locale === 'en-US' ? text.en : text.zh
}

export const BROOKS_TERMS: Record<string, BrooksTermDef> = {
  市场状态: {
    name: { zh: '市场状态（Market Cycle）', en: 'Market Cycle' },
    def: {
      zh: 'Brooks 把市场划为趋势与交易区间两种状态并循环演化：冲刺(spike)→通道(channel)→区间(range)→突破。状态决定打法：趋势里顺势做回调，区间里低买高卖、不追突破。',
      en: 'Brooks splits the market into trend and trading-range phases that cycle: spike → channel → range → breakout. The phase dictates tactics: trade pullbacks with the trend; in ranges, buy low / sell high and never chase breakouts.',
    },
    src: { zh: '《高级趋势技术分析》', en: 'Trading Price Action Trends' },
  },
  alwaysIn: {
    name: { zh: 'Always In（永远在场方向）', en: 'Always In Direction' },
    def: {
      zh: '如果必须持仓、非多即空，当前应持的方向。它是「强趋势是否存在」的仲裁器，翻转很保守（Brooks：一天约翻 2~5 次）。',
      en: 'The direction to hold if you had to stay in the market, long or short. It arbitrates whether a strong trend exists and flips conservatively (Brooks: about 2~5 flips a day).',
    },
    src: { zh: 'Brooks 官方词汇表', en: "Brooks' official glossary" },
  },
  摆动序列: {
    name: { zh: '摆动点序列 HH/HL/LH/LL', en: 'Swing Sequence HH/HL/LH/LL' },
    def: {
      zh: 'HH=更高高顶、HL=更高低底（多头特征）；LH=更低高顶、LL=更低低底（空头特征）。HH+HL 交替=多头结构，LH+LL 交替=空头结构，混杂交错=震荡。',
      en: 'HH=higher high, HL=higher low (bull traits); LH=lower high, LL=lower low (bear traits). Alternating HH+HL = bull structure, LH+LL = bear structure, mixed = ranging.',
    },
    src: { zh: '《高级趋势技术分析》', en: 'Trading Price Action Trends' },
  },
  结构判定: {
    name: { zh: '结构判定', en: 'Structure Verdict' },
    def: {
      zh: '由最近的摆动高低点组合推断的多空格局：结构决定「顺势还是逆势」，是所有 Brooks 信号的上下文门。',
      en: 'Bull/bear posture inferred from the latest swing highs and lows: structure decides "with-trend or counter-trend" and gates every Brooks signal.',
    },
    src: { zh: '《高级趋势技术分析》', en: 'Trading Price Action Trends' },
  },
  最近一腿: {
    name: { zh: '腿（Leg）与回调深度', en: 'Legs & Pullback Depth' },
    def: {
      zh: '相邻摆动点之间的单向移动。趋势健康时回调幅度约为前腿的 38%~50%；超过前腿（>100%）说明趋势减弱甚至反转。两腿回调、AB=CD 测量移动都以腿为单位。',
      en: 'A one-way move between adjacent swing points. In healthy trends pullbacks retrace ~38%–50% of the prior leg; beyond 100% of it the trend is weakening or reversing. Two-legged pullbacks and AB=CD measured moves are counted in legs.',
    },
    src: { zh: '《高级趋势技术分析》', en: 'Trading Price Action Trends' },
  },
  H计数: {
    name: { zh: 'H1~H4（多头回调计数）', en: 'H1~H4 (Bull Pullback Count)' },
    def: {
      zh: '多头趋势回调中，第 n 根上破前一根高点的K线 = Hn。H2 = 二次进场，是 Brooks 体系胜率最高的结构（先验 ≈60%）；计数越高质量越低。',
      en: 'In a bull-trend pullback, the nth bar breaking above the prior bar high = Hn. H2 = second entry, the highest-probability Brooks setup (prior ≈60%); quality degrades as the count rises.',
    },
    src: { zh: '《价格行为交易》', en: 'Trading Price Action' },
  },
  L计数: {
    name: { zh: 'L1~L4（空头回调计数）', en: 'L1~L4 (Bear Pullback Count)' },
    def: {
      zh: '空头趋势回调中，第 n 根跌破前一根低点的K线 = Ln。L2 = 二次进场（先验 ≈60%）；L3/L4 常出现在趋势末期。',
      en: 'In a bear-trend pullback, the nth bar breaking below the prior bar low = Ln. L2 = second entry (prior ≈60%); L3/L4 often appear late in the trend.',
    },
    src: { zh: '《价格行为交易》', en: 'Trading Price Action' },
  },
  楔形: {
    name: { zh: '楔形（Wedge，三推反转）', en: 'Wedge (Three-Push Reversal)' },
    def: {
      zh: '三个同向推进的摆动点（如三个依次抬升的高点），第三推动能衰减时可靠性更高。Brooks：任意三推形态都当楔形交易，目标=楔形全幅回到起点。',
      en: 'Three same-direction pushes (e.g. three rising highs); more reliable when the third push loses momentum. Brooks: treat any three pushes as a wedge; target = full retrace to the wedge origin.',
    },
    src: { zh: '《高级反转技术分析》', en: 'Trading Price Action Reversals' },
  },
  双顶底: {
    name: { zh: '双顶 / 双底（Double Top / Bottom）', en: 'Double Top / Double Bottom' },
    def: {
      zh: '两个摆动点近似等高/等低（差 ≤0.3×ATR），中间有明显回落/反弹。第二点测试前极值失败即形态成立，突破颈线（中间极值）确认。',
      en: 'Two swing points at nearly the same level (≤0.3×ATR apart) with a clear dip/bounce between. The pattern completes when the second test fails at the prior extreme; a break of the neck line (intervening extreme) confirms it.',
    },
    src: { zh: '《高级反转技术分析》', en: 'Trading Price Action Reversals' },
  },
  ii突破: {
    name: { zh: 'ii 突破（连续内包线突破）', en: 'ii Breakout (Consecutive Inside Bars)' },
    def: {
      zh: '连续两根内包线（ii）是突破模式：市场观望到极致，随后的收盘突破方向常引发一波趋势，属日内最可靠的突破形态之一。',
      en: 'Two consecutive inside bars (ii) form a breakout mode: the market is maximally coiled, and the eventual close-out direction often starts a trend leg — one of the most reliable intraday breakout patterns.',
    },
    src: { zh: '《价格行为交易》', en: 'Trading Price Action' },
  },
  外包线: {
    name: { zh: '外包线（Outside Bar）', en: 'Outside Bar' },
    def: {
      zh: '一根K线的高低点完全吞没前一根，多空双杀后往往跟随二次突破（H2/L2），方向沿突破方向概率更高。',
      en: 'A bar whose high/low fully engulfs the prior bar. After the two-sided washout, a second breakout (H2/L2) often follows, favoring the breakout direction.',
    },
    src: { zh: '《价格行为交易》', en: 'Trading Price Action' },
  },
  TLB: {
    name: { zh: '趋势线突破（TLB，警戒级）', en: 'Trend Line Break (TLB, Warning Level)' },
    def: {
      zh: '连接摆动点的趋势线被收盘穿越，是趋势减弱的第一个信号——但只有约 50% 最终演变为反转，另一半会恢复趋势，所以只作警戒，需等测试+反转确认。',
      en: 'A close through a trend line connecting swing points — the first sign of trend weakness. Only ~50% become reversals (the rest resume the trend), so treat it as a warning and wait for test + reversal confirmation.',
    },
    src: { zh: '《高级反转技术分析》', en: 'Trading Price Action Reversals' },
  },
  MTR: {
    name: { zh: '主要趋势反转（MTR）', en: 'Major Trend Reversal (MTR)' },
    def: {
      zh: '趋势线突破 → 回测 → 反转信号，三步齐备才是 MTR。成立后约 80% 至少演变为区间，反向两腿是最低预期。',
      en: 'Trend-line break → retest → reversal signal: all three are required for an MTR. Once complete, ~80% evolve into at least a range; two counter legs is the minimum expectation.',
    },
    src: { zh: '《高级反转技术分析》', en: 'Trading Price Action Reversals' },
  },
  区间突破: {
    name: { zh: '交易区间突破', en: 'Trading-Range Breakout' },
    def: {
      zh: '震荡区间被趋势棒收盘突破。先验：80% 的区间突破尝试失败、首次突破仅约 50% 存活——突破后回测区间边缘不破，才是低风险二次进场点。',
      en: 'A trend-bar close beyond the range. Priors: 80% of range breakout attempts fail and only ~50% of first breakouts survive — a low-risk second entry comes only after a retest of the range edge holds.',
    },
    src: { zh: '《高级区间技术分析》', en: 'Trading Price Action Trading Ranges' },
  },
  冲刺: {
    name: { zh: '冲刺（Spike）', en: 'Spike' },
    def: {
      zh: '≥5 根连续同向趋势棒的强突破，spike and channel 的起点。冲刺腿是趋势最强阶段，逆势首单 80% 会失败。',
      en: 'A strong breakout of ≥5 consecutive same-direction trend bars — the start of spike and channel. The spike is the strongest trend phase; 80% of first counter-trend trades against it fail.',
    },
    src: { zh: '《高级趋势技术分析》', en: 'Trading Price Action Trends' },
  },
  内包线: {
    name: { zh: '内包线（Inside Bar）', en: 'Inside Bar' },
    def: {
      zh: '高低点完全被前一根包含 = 市场观望/突破模式。连续内包（ii）后沿突破方向追进的可靠性显著提高。',
      en: 'A bar fully contained by the prior bar = market pause / breakout mode. After consecutive inside bars (ii), following the breakout direction is markedly more reliable.',
    },
    src: { zh: '《价格行为交易》', en: 'Trading Price Action' },
  },
  铁丝网: {
    name: { zh: '铁丝网（Barbwire）', en: 'Barbwire' },
    def: {
      zh: 'K线大幅重叠且含 doji 的紧凑区间，假突破高发。Brooks 的明确建议：不参与，等结构走出区间再说。',
      en: 'A tight range of heavily overlapping bars with dojis — fake breakouts are common. Brooks is explicit: stay out and wait for structure to leave the range.',
    },
    src: { zh: 'Brooks 官方词汇表', en: "Brooks' official glossary" },
  },
}

/** 信号种类 → 术语词条（信号面板用原生 title，避免滚动容器裁剪气泡） */
export function termForSignalKind(label: string, kind: string): string {
  const key = kind.startsWith('H') ? 'H计数'
    : kind.startsWith('L') ? 'L计数'
    : kind.startsWith('WEDGE') ? '楔形'
    : kind.startsWith('DOUBLE') ? '双顶底'
    : kind.startsWith('II_') ? 'ii突破'
    : kind.startsWith('OB_') ? '外包线'
    : kind.startsWith('TLB') ? 'TLB'
    : kind.startsWith('MTR') ? 'MTR'
    : kind.startsWith('TR_') ? '区间突破'
    : kind.startsWith('SPIKE') ? '冲刺'
    : ''
  const def = BROOKS_TERMS[key]
  if (!def) return label
  const locale = currentLocale()
  const src = def.src ? `（${pick(def.src, locale)}）` : ''
  return `${pick(def.name, locale)}：${pick(def.def, locale)}${src}`
}

/** 带「!」悬停提醒的术语（用于非滚动容器，如当前结构摘要） */
export function BrooksTerm({ term, children }: { term: string; children?: ReactNode }): JSX.Element {
  useTranslation()
  const def = BROOKS_TERMS[term]
  if (!def) return <span>{children ?? term}</span>
  const locale = currentLocale()
  return (
    <span className="brooks-term" tabIndex={0}>
      {children ?? term}
      <i className="term-bang" aria-hidden>
        !
      </i>
      <span className="term-pop" role="tooltip">
        <b>{pick(def.name, locale)}</b>
        {pick(def.def, locale)}
        {def.src ? <em>—— {pick(def.src, locale)}</em> : null}
      </span>
    </span>
  )
}
