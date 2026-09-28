/**
 * Brooks 术语速查（「!」悬停提醒）：把复盘页上的专业术语映射为通俗解释 + 出处。
 * 信号面板在滚动容器内（绝对定位气泡会被裁剪），信号种类改用函数取文案配原生 title。
 */

import type { ReactNode } from 'react'

export interface BrooksTermDef {
  name: string
  def: string
  src?: string
}

export const BROOKS_TERMS: Record<string, BrooksTermDef> = {
  市场状态: {
    name: '市场状态（Market Cycle）',
    def: 'Brooks 把市场划为趋势与交易区间两种状态并循环演化：冲刺(spike)→通道(channel)→区间(range)→突破。状态决定打法：趋势里顺势做回调，区间里低买高卖、不追突破。',
    src: '《高级趋势技术分析》',
  },
  alwaysIn: {
    name: 'Always In（永远在场方向）',
    def: '如果必须持仓、非多即空，当前应持的方向。它是「强趋势是否存在」的仲裁器，翻转很保守（Brooks：一天约翻 2~5 次）。',
    src: 'Brooks 官方词汇表',
  },
  摆动序列: {
    name: '摆动点序列 HH/HL/LH/LL',
    def: 'HH=更高高顶、HL=更高低底（多头特征）；LH=更低高顶、LL=更低低底（空头特征）。HH+HL 交替=多头结构，LH+LL 交替=空头结构，混杂交错=震荡。',
    src: '《高级趋势技术分析》',
  },
  结构判定: {
    name: '结构判定',
    def: '由最近的摆动高低点组合推断的多空格局：结构决定「顺势还是逆势」，是所有 Brooks 信号的上下文门。',
    src: '《高级趋势技术分析》',
  },
  最近一腿: {
    name: '腿（Leg）与回调深度',
    def: '相邻摆动点之间的单向移动。趋势健康时回调幅度约为前腿的 38%~50%；超过前腿（>100%）说明趋势减弱甚至反转。两腿回调、AB=CD 测量移动都以腿为单位。',
    src: '《高级趋势技术分析》',
  },
  H计数: {
    name: 'H1~H4（多头回调计数）',
    def: '多头趋势回调中，第 n 根上破前一根高点的K线 = Hn。H2 = 二次进场，是 Brooks 体系胜率最高的结构（先验 ≈60%）；计数越高质量越低。',
    src: '《价格行为交易》',
  },
  L计数: {
    name: 'L1~L4（空头回调计数）',
    def: '空头趋势回调中，第 n 根跌破前一根低点的K线 = Ln。L2 = 二次进场（先验 ≈60%）；L3/L4 常出现在趋势末期。',
    src: '《价格行为交易》',
  },
  楔形: {
    name: '楔形（Wedge，三推反转）',
    def: '三个同向推进的摆动点（如三个依次抬升的高点），第三推动能衰减时可靠性更高。Brooks：任意三推形态都当楔形交易，目标=楔形全幅回到起点。',
    src: '《高级反转技术分析》',
  },
  双顶底: {
    name: '双顶 / 双底（Double Top / Bottom）',
    def: '两个摆动点近似等高/等低（差 ≤0.3×ATR），中间有明显回落/反弹。第二点测试前极值失败即形态成立，突破颈线（中间极值）确认。',
    src: '《高级反转技术分析》',
  },
  ii突破: {
    name: 'ii 突破（连续内包线突破）',
    def: '连续两根内包线（ii）是突破模式：市场观望到极致，随后的收盘突破方向常引发一波趋势，属日内最可靠的突破形态之一。',
    src: '《价格行为交易》',
  },
  外包线: {
    name: '外包线（Outside Bar）',
    def: '一根K线的高低点完全吞没前一根，多空双杀后往往跟随二次突破（H2/L2），方向沿突破方向概率更高。',
    src: '《价格行为交易》',
  },
  TLB: {
    name: '趋势线突破（TLB，警戒级）',
    def: '连接摆动点的趋势线被收盘穿越，是趋势减弱的第一个信号——但只有约 50% 最终演变为反转，另一半会恢复趋势，所以只作警戒，需等测试+反转确认。',
    src: '《高级反转技术分析》',
  },
  MTR: {
    name: '主要趋势反转（MTR）',
    def: '趋势线突破 → 回测 → 反转信号，三步齐备才是 MTR。成立后约 80% 至少演变为区间，反向两腿是最低预期。',
    src: '《高级反转技术分析》',
  },
  区间突破: {
    name: '交易区间突破',
    def: '震荡区间被趋势棒收盘突破。先验：80% 的区间突破尝试失败、首次突破仅约 50% 存活——突破后回测区间边缘不破，才是低风险二次进场点。',
    src: '《高级区间技术分析》',
  },
  冲刺: {
    name: '冲刺（Spike）',
    def: '≥5 根连续同向趋势棒的强突破，spike and channel 的起点。冲刺腿是趋势最强阶段，逆势首单 80% 会失败。',
    src: '《高级趋势技术分析》',
  },
  内包线: {
    name: '内包线（Inside Bar）',
    def: '高低点完全被前一根包含 = 市场观望/突破模式。连续内包（ii）后沿突破方向追进的可靠性显著提高。',
    src: '《价格行为交易》',
  },
  铁丝网: {
    name: '铁丝网（Barbwire）',
    def: 'K线大幅重叠且含 doji 的紧凑区间，假突破高发。Brooks 的明确建议：不参与，等结构走出区间再说。',
    src: 'Brooks 官方词汇表',
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
  return def ? `${def.name}：${def.def}${def.src ? `（${def.src}）` : ''}` : label
}

/** 带「!」悬停提醒的术语（用于非滚动容器，如当前结构摘要） */
export function BrooksTerm({ term, children }: { term: string; children?: ReactNode }): JSX.Element {
  const def = BROOKS_TERMS[term]
  if (!def) return <span>{children ?? term}</span>
  return (
    <span className="brooks-term" tabIndex={0}>
      {children ?? term}
      <i className="term-bang" aria-hidden>
        !
      </i>
      <span className="term-pop" role="tooltip">
        <b>{def.name}</b>
        {def.def}
        {def.src ? <em>—— {def.src}</em> : null}
      </span>
    </span>
  )
}
