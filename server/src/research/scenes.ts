/**
 * 场景注册表（P1-1，vertical-agent-architecture.md §4.A）：
 * 三维度分离——Product（产品契约）/ TaskScene（任务场景）/ UiMode（纯前端）。
 * sceneCode 只统一任务场景配置（提示词集作用域 / 追问动作集 / 结果卡模板），
 * 不替代产品契约与服务端权限校验：perp run 仍须持仓归属校验（routes.ts 创建时执行），
 * ui 参数只作用于前端渲染开关，服务端不读。
 *
 * resolveScene 把「七意图 × 产品组合」映射到 TaskScene（会话层在意图路由后调用，
 * run 直建路径按 product+引用推导缺省场景）；sceneCode 记入 conversation_messages
 * 与 research_runs 行（迁移 0020）。
 */
import type { ResearchProduct, TaskScene, SceneDef, FollowUpAction } from 'biance-vision-brooks'
import { TASK_SCENES } from 'biance-vision-brooks'

export { TASK_SCENES }
export type { TaskScene }

/** 会话意图（conversation.ts 的 Intent；此处仅类型引用避免循环依赖） */
type IntentLike = 'concept' | 'structure' | 'perp' | 'event' | 'replay' | 'news' | 'system'

/** 场景注册表（提示词按 (name, scene) 复合作用域差异化；追问动作集见 followUpsOf） */
export const SCENES: Record<TaskScene, SceneDef> = {
  'hold-review': {
    code: 'hold-review',
    label: '持仓复查',
    products: ['perp'],
    description: '已确认持仓的结构与风险复查：计划盈亏、减仓与增量、止损触发条件',
  },
  'structure-scan': {
    code: 'structure-scan',
    label: '结构扫描',
    products: ['perp', 'teaching'],
    description: '当前结构与方向研究：执行/背景周期状态、已确认 setup 与理论依据',
  },
  'concept-teach': {
    code: 'concept-teach',
    label: '概念教学',
    products: ['teaching'],
    description: '概念/术语问答：知识库 RAG 直引 + 反证提醒，不启动行情流程',
  },
  'quote-review': {
    code: 'quote-review',
    label: '报价评估',
    products: ['event'],
    description: '事件合约报价评估：EV、盈亏平衡胜率、参与门槛与失效条件',
  },
  'replay-analysis': {
    code: 'replay-analysis',
    label: '历史复盘',
    products: ['perp', 'teaching'],
    description: '历史时点复盘：只使用当时可见数据（asOf 冻结）',
  },
  'news-attribution': {
    code: 'news-attribution',
    label: '消息归因',
    products: ['teaching'],
    description: '涨跌归因：web 搜索 + 原页核验后作答，不编造新闻',
  },
}

/**
 * 意图 × 产品组合 → TaskScene：
 * - concept/news/replay/event 意图直接映射（产品由意图决定）；
 * - perp 意图带已确认持仓 → hold-review，无持仓 → structure-scan（按一般结构研究）；
 * - structure/system 及其余缺省 → structure-scan。
 */
export function resolveScene(
  intent: IntentLike,
  ctx: { product?: ResearchProduct | null; hasPosition?: boolean; replay?: boolean } = {},
): TaskScene {
  if (intent === 'concept') return 'concept-teach'
  if (intent === 'news') return 'news-attribution'
  if (intent === 'replay' || ctx.replay === true) return 'replay-analysis'
  if (intent === 'event' || ctx.product === 'event') return 'quote-review'
  if (intent === 'perp' || ctx.product === 'perp') return ctx.hasPosition === true ? 'hold-review' : 'structure-scan'
  return 'structure-scan'
}

/** run 直建路径（无会话意图）按产品+引用推导缺省场景 */
export function defaultSceneForProduct(product: ResearchProduct, opts: { positionId?: string | null; quoteId?: string | null; asOfIsHistorical?: boolean } = {}): TaskScene {
  if (opts.asOfIsHistorical === true) return 'replay-analysis'
  if (product === 'perp') return opts.positionId != null && opts.positionId !== '' ? 'hold-review' : 'structure-scan'
  if (product === 'event') return 'quote-review'
  return 'structure-scan'
}

export function sceneLabel(code: string | null | undefined): string {
  if (code == null || !(TASK_SCENES as readonly string[]).includes(code)) return ''
  return SCENES[code as TaskScene].label
}

// ---------------------------------------------------------------------------
// P1-3 结构化追问（§4.F-1）：发布时由确定性模板按场景生成动作对象。
// prerequisites 门控语义（服务端决定是否返回，不下发客户端）：
// - counter_search：仅 search 能力启用（frozen caps）时返回；
// - open_rule_card：仅当冻结证据中存在规则卡（refId 以 rulecard:/case: 开头）时返回；
// - rerun_with：恒可用（同 context 重建 run）；
// - switch_context(position)：仅持仓过期（task_degraded ask_user）时返回。
// 语义纪律：event 场景「触达执行价（touch）」与「到期高于执行价（above）」文案区分；
// 文案不包含结果之外的数字。
// ---------------------------------------------------------------------------

export interface FollowUpContext {
  scene: TaskScene
  product: ResearchProduct
  runId: string
  /** 冻结证据 refId 集合（判断规则卡证据是否存在） */
  evidenceRefIds: string[]
  /** search 能力（冻结配置）是否启用 */
  searchEnabled: boolean
  /** 持仓已过期（触发补问） */
  positionStale?: boolean
  /** event 报价方向语义（touch=过程触达 / above=到期高于）——当前产品契约只研究 above */
  eventDirectionSemantics?: 'touch' | 'above'
}

export function buildFollowUpActions(ctx: FollowUpContext): FollowUpAction[] {
  const actions: FollowUpAction[] = []
  const hasRuleCard = ctx.evidenceRefIds.some((r) => r.startsWith('rulecard:') || r.startsWith('case:'))
  actions.push({
    action: 'open_evidence',
    label: '查看本研究的证据',
    sourceRunId: ctx.runId,
  })
  if (hasRuleCard) {
    actions.push({ action: 'open_rule_card', label: '查看命中的规则卡', sourceRunId: ctx.runId })
  }
  if (ctx.product === 'perp') {
    actions.push({ action: 'rerun_with', label: '换个周期再跑一次', sourceRunId: ctx.runId, parameters: { interval: 'next' } })
    if (ctx.positionStale === true) {
      actions.push({ action: 'switch_context', label: '重新确认持仓（已过期）', sourceRunId: ctx.runId, parameters: { positionId: 'reconfirm' } })
    }
  } else if (ctx.product === 'event') {
    // 语义纪律：明确「到期高于/低于执行价」是结算语义，与盘中触达区分
    const above = ctx.eventDirectionSemantics !== 'touch'
    actions.push({
      action: 'rerun_with',
      label: above ? '到期临近时重估（结算口径）' : '临近触发价时重估（盘中口径）',
      sourceRunId: ctx.runId,
      parameters: { interval: 'next' },
    })
  }
  if (ctx.searchEnabled) {
    actions.push({
      action: 'counter_search',
      label: '定向检索这条结论的反证',
      sourceRunId: ctx.runId,
      parameters: { stance: 'counter' },
    })
  }
  return actions.slice(0, 5)
}
