/**
 * 统一可信回答组装器（P0-2，vertical-agent-architecture.md §6 P0-2）：
 * 所有会话场景回复经单一组装器产出，内容只允许来自三类来源——
 *   1. 已计算事实（facts 命名槽位：数值由代码计算/用户确认输入，非 LLM 产出）
 *   2. 冻结证据治理段（llmText：LLM 基于冻结证据的归纳，校验引用编号与概率红线；
 *      sections：来源列表/资料摘录等证据文本，原样透传——数字来自证据本身）
 *   3. 配置文案（模板文本；本文件为代码版本控制的模板常量，P1-8 换 app_settings）
 *
 * 校验（组装器内强制，失败回退安全模板）：
 * - 数字白名单：模板渲染段中出现的数字必须 ⊆（模板原文 ∪ facts 槽位值）的数字集合；
 *   出现白名单之外的数字（如意外注入的行情价）→ 拒绝该段并回退。
 * - 引用编号：llmText 的 [k] 必须 ∈ 1..sourceCount（无来源时不允许携带编号）。
 * - 概率红线：llmText 不得含「概率/胜率词 + 数字」共现（与 validator.hasFabricatedProb 同口径）。
 */

export type ReplyTemplateKey =
  | 'system_intro'
  | 'news_unconfigured'
  | 'news_empty'
  | 'news_body' // llmText（归纳正文）+ sections（来源列表）
  | 'concept_no_hit'
  | 'concept_body' // llmText（教学解释）+ sections（资料依据）
  | 'run_started'
  | 'draft_pending'
  | 'draft_complete'
  | 'draft_cancelled'
  | 'replay_invalid'
  | 'replay_missing'
  | 'quote_missing' // 事件研究缺报价：启动前追问（缺什么/为什么/怎么补），不晾用户
  | 'quote_recorded' // 会话代录 preview 报价：复述录入值供核对
  | 'quote_invalid' // 口述报价数值非法（返还<投入等）：不建行，请求更正
  | 'quote_discarded' // 作废刚代录的报价引用

/** 模板（代码版本控制；占位 {{name}} 对应 facts 槽位，{{notes}} 对应动态说明行） */
const TEMPLATES: Record<ReplyTemplateKey, string> = {
  system_intro:
    '我是基于 Brooks 价格行为的研究助手，可以这样问我：\n' +
    '- 概念：「什么是内包线」「什么是高潮反转」\n' +
    '- 结构与方向：「BTC 现在结构如何」「ETHUSDT 一小时能买吗」\n' +
    '- 持仓研究：先录入持仓，再说「用我的持仓分析」\n' +
    '- 历史复盘：「复盘昨天 BTC 的走势」',
  news_unconfigured: '新闻归因需要联网搜索能力（Brave Search 等），当前未配置：无法给出消息面归因，也不编造新闻。请管理员在 Agent 配置中启用 search 能力后重试。',
  news_empty: '联网搜索未获得可通过原页核验的证据（域名白名单/重定向/超时/体积限制）：不编造新闻。可稍后重试，或让管理员检查 search 能力的白名单配置。',
  news_body: '{{llmText}}\n\n{{sections}}',
  concept_no_hit: '知识库未命中相关资料：不编造解释。可在知识库导入 Brooks 官方术语表/手册后重试。',
  concept_body: '{{llmText}}\n\n{{sections}}',
  run_started:
    '按「{{intentLabel}} · {{symbol}} · {{horizon}}」{{asOfNote}}{{directionNote}}启动研究：' +
    '已冻结行情输入包与配置版本，结构、检索、计算与校验完成后给出结论与证据。{{notes}}' +
    '{{queueNote}}{{subAnswer}}' +
    '可继续追问（如「换成 ETHUSDT」「改成 1 小时」「现在呢」）。',
  draft_pending: '已记录持仓草稿，还缺：{{missingLabels}}。请补充（例如「入场 60000，最多亏 200」），或回复「取消」丢弃草稿。',
  draft_complete: '持仓信息已齐，请核对确认卡（确认后才会计入你的持仓；重复确认不会重复建仓）。',
  draft_cancelled: '已丢弃待确认的持仓草稿，未写入持仓。',
  replay_invalid: '复盘日期无法解析（或指向未来）：请给出有效日期（如「复盘 2026-10-01 的 BTC」）或相对时间（「昨天」「前天」）。不使用当前行情冒充历史复盘。',
  replay_missing: '复盘需要明确的历史时点：请给出日期（如「复盘 2026-10-01 的 BTC」）或相对时间（「昨天」「前天」）。不使用当前行情冒充历史复盘。',
  quote_missing:
    '事件合约研究需要一条真实报价才能算 EV：赔率来自报价里的投入与返还（盈亏平衡胜率=投入÷返还），官方没有查询接口，报价只能由你从 App 抄录，助手不编造。\n' +
    '还缺：{{missingLabels}}。\n' +
    '三种继续方式（任选其一）：\n' +
    '- 直接补发报价描述（示例格式：「BTC 高于 60000，投入 10 返还 17，10 分钟」），我会录入为预览报价并立即研究\n' +
    '- 只想看结构偏向：回复「只要结构」，结构结论不依赖报价\n' +
    '- 在研究表单「事件研究」录入报价后再来提问{{notes}}',
  quote_recorded:
    '已按你的描述录入预览报价（60 秒时效，执行价未锁定）并引用启动研究：{{quoteSummary}}。如与 App 实际报价不符，回复「作废报价」后重发；已提交的订单报价请用表单录入（到期时刻需精确）。',
  quote_invalid: '报价数值不合法：{{reason}}。请核对 App 实际展示的数字后重发（示例：「BTC 高于 60000，投入 10 返还 17，10 分钟」）。',
  quote_discarded: '已作废该预览报价引用（未启动研究）。可重新发送报价描述，或改问「只要结构」。',
}

/** 概率红线（与 services/validator.ts 同口径；独立实现避免 server→web 分层纠缠） */
const PROB_WORD_RE = /概率|胜率|胜算|probability|win\s*rate|winrate/i
const PCT_NUM_RE = /\d+(?:\.\d+)?\s*%/
const DECIMAL_PROB_RE = /(?<![\d.])0?\.\d+(?![\d.])/

function numbersOf(text: string): Set<string> {
  return new Set(text.match(/\d+(?:\.\d+)?/g) ?? [])
}

export interface TrustedReplyInput {
  key: ReplyTemplateKey
  /** 已计算事实槽位（值渲染进模板；其数字进入白名单） */
  facts?: Record<string, string | number>
  /** 动态说明行（服务端计算的状态说明；作为 notes 段拼入，文本进入白名单） */
  notes?: string[]
  /** LLM 归纳正文（evidence-governed）：校验引用编号与概率红线，失败回退 llmFallback */
  llmText?: string | null
  /** llmText 可引用的来源数（[k] 上限；0/缺省 = 不允许携带编号） */
  sourceCount?: number
  /** llmText 校验失败时的回退文本（如原文摘录模式）；缺省回退安全模板 key 对应说明 */
  llmFallback?: string
  /** 证据治理段（来源列表/资料摘录）：原样透传（数字来自证据文本，不做白名单约束） */
  sections?: string[]
  /**
   llmText 归纳所依据的证据正文（冻结引用的原文）：其中的数字进入 llmText 的数字白名单。
   llmText 句级数字治理（2026-10-19 审查修正）：LLM 归纳正文此前整体豁免数字检查，
   用户注入或模型幻觉的行情价/杠杆倍数会原样透传——现在 llmText 按句过滤，
   句中数字必须 ⊆（模板 ∪ facts ∪ notes ∪ evidenceTexts）的数字集，违例句剔除。
   */
  evidenceTexts?: string[]
}

export interface AssembleResult {
  content: string
  /** true = 某段校验失败，已回退安全形态（内容仍可信） */
  degraded: boolean
  checkNotes: string[]
}

/**
 * 组装可信回复。任何校验失败不抛错——回退安全模板并置 degraded=true（调用方照常落库，
 * 回复永远可信但可能不完整；失败详情在 checkNotes 供日志/评测）。
 */
export function assembleTrustedReply(input: TrustedReplyInput): AssembleResult {
  const facts = input.facts ?? {}
  const notes = input.notes ?? []
  const checkNotes: string[] = []
  const degraded = { value: false }

  // llmText 数字白名单：模板原文 ∪ facts 槽位 ∪ notes ∪ 证据正文（evidenceTexts）。
  // sections 整段豁免不变（原文摘录即证据本身）；llmText 是 LLM 归纳，逐句核对
  const llmAllowed = numbersOf(TEMPLATES[input.key])
  for (const v of Object.values(facts)) for (const n of numbersOf(String(v))) llmAllowed.add(n)
  for (const n of notes) for (const num of numbersOf(n)) llmAllowed.add(num)
  for (const t of input.evidenceTexts ?? []) for (const n of numbersOf(t)) llmAllowed.add(n)

  // ---- 1) llmText（evidence-governed 段）先行校验 ----
  let llmText = input.llmText ?? null
  if (llmText !== null) {
    const sourceCount = input.sourceCount ?? 0
    const cited = [...llmText.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]))
    const badRef = cited.find((k) => k < 1 || k > sourceCount)
    if (badRef !== undefined) {
      checkNotes.push(`引用编号越界：[${badRef}] > 来源数 ${sourceCount}`)
      llmText = input.llmFallback ?? null
      degraded.value = true
    } else if (PROB_WORD_RE.test(llmText) && (PCT_NUM_RE.test(llmText) || DECIMAL_PROB_RE.test(llmText))) {
      checkNotes.push('llmText 含未经统计模块的概率表述（概率红线）')
      llmText = input.llmFallback ?? null
      degraded.value = true
    } else {
      // 句级数字治理：违例句剔除（保留合法句）；全部违例 → 回退 llmFallback/空。
      // [k] 引用标记先剥离——标记编号不是正文数字（否则合法引用句会被误杀）
      const sentences = llmText.split(/(?<=[。！？!?\n])/).filter((s) => s.trim() !== '')
      const kept: string[] = []
      let dropped = 0
      for (const s of sentences) {
        const bare = s.replace(/\s*\[\d{1,2}\]/g, '')
        const bad = [...numbersOf(bare)].find((n) => !llmAllowed.has(n))
        if (bad === undefined) kept.push(s)
        else dropped++
      }
      if (dropped > 0) {
        checkNotes.push(`llmText 剔除 ${dropped} 个含白名单外数字的句子`)
        degraded.value = true
        llmText = kept.length > 0 ? kept.join('') : (input.llmFallback ?? null)
      }
    }
  }

  // ---- 2) 模板渲染（facts + notes + llmText/sections 占位）----
  let template = TEMPLATES[input.key]
  const whitelist = numbersOf(template) // 模板固有数字可信
  for (const [k, v] of Object.entries(facts)) {
    const val = String(v)
    for (const n of numbersOf(val)) whitelist.add(n)
    template = template.split(`{{${k}}}`).join(val)
  }
  for (const n of notes) for (const num of numbersOf(n)) whitelist.add(num)
  const notesText = notes.length > 0 ? `${notes.join('；')}。` : ''
  template = template.split('{{notes}}').join(notesText)
  template = template.split('{{queueNote}}').join(facts.queueNote !== undefined ? String(facts.queueNote) : '')
  template = template.split('{{subAnswer}}').join(facts.subAnswer !== undefined ? String(facts.subAnswer) : '')
  // llmText/sections 占位：作为 evidence 治理段整体注入（不参与数字白名单）
  if (llmText !== null) template = template.split('{{llmText}}').join(llmText)
  else template = template.split('{{llmText}}\n\n').join('').split('{{llmText}}').join('')
  const sections = (input.sections ?? []).join('\n')
  template = template.split('{{sections}}').join(sections)

  // ---- 3) 数字白名单：渲染后文本（剔除 evidence 段）中不得出现白名单外数字 ----
  // evidence 段不参与校验：从渲染结果中剥离 llmText 与 sections 文本再比对
  let toCheck = template
  if (llmText !== null) toCheck = toCheck.split(llmText).join(' ')
  if (sections !== '') toCheck = toCheck.split(sections).join(' ')
  // 安全回退形态：原始模板 + facts 槽位（其余动态段全部剔除；残留占位一并清除）
  const safeRender = (): string => {
    let safe = TEMPLATES[input.key]
    for (const [k, v] of Object.entries(facts)) safe = safe.split(`{{${k}}}`).join(String(v))
    safe = safe.split('{{notes}}').join('').split('{{queueNote}}').join('').split('{{subAnswer}}').join('')
    safe = safe.split('{{llmText}}\n\n').join('').split('{{llmText}}').join('')
    safe = safe.split('{{sections}}').join('')
    const cleaned = safe.replace(/\{\{[\w-]+\}\}/g, '')
    // 安全形态也可能为空（news_body/concept_body 剥净后）：统一拦截提示兜底
    return cleaned.trim() === '' ? '（该回复未通过可信校验已被拦截：请稍后重试，或换一种问法。）' : cleaned
  }

  const rendered = numbersOf(toCheck)
  const offenders = [...rendered].filter((n) => !whitelist.has(n))
  if (offenders.length > 0) {
    checkNotes.push(`模板段出现白名单外数字：${offenders.slice(0, 5).join(', ')}`)
    return { content: safeRender(), degraded: true, checkNotes }
  }

  // 残留未替换占位（调用方漏传槽位）→ 降级为安全形态（不静默露出 {{...}} 语法）
  const leftover = template.match(/\{\{[\w-]+\}\}/)
  if (leftover !== null) {
    checkNotes.push(`残留未替换占位：${leftover[0]}`)
    return { content: safeRender(), degraded: true, checkNotes }
  }

  // 最终兜底：任何路径都不得产出空回复（空串＝用户看到无响应）
  if (template.trim() === '') {
    checkNotes.push('组装结果为空，回退拦截提示')
    return { content: '（该回复未通过可信校验已被拦截：请稍后重试，或换一种问法。）', degraded: true, checkNotes }
  }

  return { content: template, degraded: degraded.value, checkNotes }
}
