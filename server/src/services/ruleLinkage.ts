/**
 * RuleLinkage（理论-建议关联链路）：
 * 当前 K 线结构 → 对应 Brooks 规则术语 → 适用条件（支持检索）与反例（反证检索）
 * → 研究建议的声明携带原文引用（evidenceIds）。
 *
 * 映射表覆盖引擎 SignalKind / regime / 冲突；术语同时给中英文，
 * 检索侧靠词项召回（术语表 + bigram）与向量召回双路命中。
 * 未覆盖的 ruleId 回退「按 ruleId 原词检索」，不假装有理论解释。
 */
import type { StructureView } from './decisionPolicy.js'

export interface RuleLinkageTarget {
  /** 关联键：`setup:<ruleId>` / `regime:<tf>` / `conflict` / `alwaysin` */
  key: string
  /** Brooks 术语中文名（claim 文本与建议解释用） */
  termZh: string
  /** 支持检索词（适用条件/定义） */
  queryText: string
  /** 反例检索词（失效条件/不适用场景）；缺省用 queryText + 失败语境 */
  counterText: string
}

interface RuleMeta {
  termZh: string
  query: string
  counter?: string
}

const RULE_META: Record<string, RuleMeta> = {
  H1: { termZh: '高点1（多头首次进场尝试）', query: 'H1 high 1 first entry pullback 多头 回调 首次进场' },
  H2: { termZh: '高点2（多头二次进场）', query: 'H2 high 2 second entry pullback 多头 回调 二次进场', counter: 'H2 fails barbwire trading range 二次进场 失败 铁丝网 交易区间' },
  H3: { termZh: '高点3（多头三次进场）', query: 'H3 high 3 third entry pullback 多头 回调 三次进场 衰竭' },
  H4: { termZh: '高点4（多头四次进场，警惕衰竭）', query: 'H4 high 4 fourth entry pullback 多头 回调 四次进场 衰竭' },
  L1: { termZh: '低点1（空头首次进场尝试）', query: 'L1 low 1 first entry pullback 空头 回调 首次进场' },
  L2: { termZh: '低点2（空头二次进场）', query: 'L2 low 2 second entry pullback 空头 回调 二次进场', counter: 'L2 fails barbwire trading range 二次进场 失败 铁丝网 交易区间' },
  L3: { termZh: '低点3（空头三次进场）', query: 'L3 low 3 third entry pullback 空头 回调 三次进场 衰竭' },
  L4: { termZh: '低点4（空头四次进场，警惕衰竭）', query: 'L4 low 4 fourth entry pullback 空头 回调 四次进场 衰竭' },
  WEDGE_TOP: { termZh: '顶部楔形（三推反转）', query: 'wedge top three push reversal 楔形 三推 反转', counter: 'wedge fails strong trend 楔形 失败 强趋势 延续' },
  WEDGE_BOTTOM: { termZh: '底部楔形（三推反转）', query: 'wedge bottom three push reversal 楔形 三推 反转', counter: 'wedge fails strong trend 楔形 失败 强趋势 延续' },
  DOUBLE_TOP: { termZh: '双顶', query: 'double top 双顶 高点 回落' },
  DOUBLE_BOTTOM: { termZh: '双底', query: 'double bottom 双底 低点 反弹' },
  II_BREAKOUT_UP: { termZh: '双内包向上突破', query: 'ii breakout inside bar 内包 突破 多头', counter: 'breakout fails trading range 突破 失败 交易区间 假突破' },
  II_BREAKOUT_DOWN: { termZh: '双内包向下突破', query: 'ii breakout inside bar 内包 突破 空头', counter: 'breakout fails trading range 突破 失败 交易区间 假突破' },
  OB_REVERSAL_UP: { termZh: '外包线向上反转', query: 'outside bar reversal 外包 反转 多头' },
  OB_REVERSAL_DOWN: { termZh: '外包线向下反转', query: 'outside bar reversal 外包 反转 空头' },
  TLB_BULL: { termZh: '趋势线突破（多头趋势减弱首信号）', query: 'trend line break TLB 趋势线突破 趋势减弱', counter: 'trend line break fails minor 趋势线突破 次要 强趋势延续' },
  TLB_BEAR: { termZh: '趋势线突破（空头趋势减弱首信号）', query: 'trend line break TLB 趋势线突破 趋势减弱', counter: 'trend line break fails minor 趋势线突破 次要 强趋势延续' },
  MTR_BULL: { termZh: '主要趋势反转（多头）', query: 'MTR major trend reversal 主要趋势反转 测试 反转信号' },
  MTR_BEAR: { termZh: '主要趋势反转（空头）', query: 'MTR major trend reversal 主要趋势反转 测试 反转信号' },
  TR_BREAKOUT_UP: { termZh: '交易区间向上突破', query: 'trading range breakout 交易区间 突破 多头', counter: 'breakout test fails 交易区间 突破测试 失败' },
  TR_BREAKOUT_DOWN: { termZh: '交易区间向下突破', query: 'trading range breakout 交易区间 突破 空头', counter: 'breakout test fails 交易区间 突破测试 失败' },
  SPIKE_UP: { termZh: '冲刺与通道（向上冲刺腿）', query: 'spike and channel 冲刺 通道 趋势棒' },
  SPIKE_DOWN: { termZh: '冲刺与通道（向下冲刺腿）', query: 'spike and channel 冲刺 通道 趋势棒' },
  hl_count: { termZh: '高低点计数（始终持仓方向）', query: 'always in 高低点计数 始终持仓 趋势 强度' },
}

/** regime 字符串（引擎 summary.regime）→ 术语 */
function regimeMeta(regime: string): RuleMeta {
  if (/trend|bull|bear/i.test(regime)) {
    return {
      termZh: '趋势段（always-in 有方向）',
      query: 'trend always in bar 趋势 始终持仓 趋势棒 回调进场',
      counter: 'trend becomes trading range 趋势 转为 交易区间 衰竭',
    }
  }
  if (/range|震荡|区间|barbwire/i.test(regime)) {
    return {
      termZh: '交易区间（多空拉锯）',
      query: 'trading range 交易区间 边缘 突破 概率',
      counter: 'trading range breakout success 交易区间 突破 成功率',
    }
  }
  return { termZh: '混合/过渡状态', query: 'transition trend range 过渡 转换' }
}

/**
 * 从结构视图提取本轮需要理论关联的目标（≤4 个，按决策相关性排序）：
 * 已确认 setup > 执行周期状态 > 周期冲突 > 背景周期状态。
 */
export function linkageTargets(input: {
  structureView: StructureView
  perTimeframe: Record<string, { regime: string; alwaysIn: string; signalCount: number }>
  execTf: string
  bgTf: string
}): RuleLinkageTarget[] {
  const { structureView, perTimeframe, execTf, bgTf } = input
  const targets: RuleLinkageTarget[] = []
  const push = (key: string, meta: RuleMeta, fallbackQuery?: string): void => {
    targets.push({
      key,
      termZh: meta.termZh,
      queryText: fallbackQuery ?? meta.query,
      counterText: meta.counter ?? `${meta.query} 失败 反例 不适用`,
    })
  }
  const setup = structureView.confirmedSetup
  if (setup !== null) {
    const meta = RULE_META[setup.ruleId]
    if (meta !== undefined) push(`setup:${setup.ruleId}`, meta)
    else push(`setup:${setup.ruleId}`, { termZh: `结构规则 ${setup.ruleId}`, query: `${setup.ruleId} ${setup.direction} setup 规则` })
  }
  const execRegime = perTimeframe[execTf]?.regime
  if (execRegime !== undefined) push(`regime:${execTf}`, regimeMeta(execRegime))
  if (structureView.conflict) {
    push('conflict', {
      termZh: '多周期冲突（执行周期与背景周期方向不一致）',
      query: 'multi timeframe conflict background 背景周期 执行周期 冲突 等待',
      counter: 'single timeframe trade 周期冲突 强信号 趋势主导',
    })
  }
  if (!structureView.conflict) {
    const bgRegime = perTimeframe[bgTf]?.regime
    if (bgRegime !== undefined) push(`regime:${bgTf}`, regimeMeta(bgRegime))
  }
  return targets.slice(0, 4)
}

/** 检索链路结果（retrieve 阶段填充；publish 装配解释时引用） */
export interface RuleLink {
  key: string
  termZh: string
  supportIds: string[]
  counterIds: string[]
  /** 支持片段摘要（适用条件，取自最高分支持证据） */
  applicabilityNote: string | null
  /** 反例摘要（失效条件） */
  counterNote: string | null
}
