/**
 * 提示词注册表（P0-6，vertical-agent-architecture.md §4.B）：
 * 五个模板（intent-classifier / counter-reviewer / news-attribution /
 * concept-teaching / query-rewrite）从代码内联迁入 prompt_templates 注册表，
 * 复用 agentVersions 生命周期（draft→published 不可变→指针回滚）。
 *
 * 解析链（三级回退，缺省不阻塞）：
 *   显式 promptRef（inline: / registry:<id> / 旧文件名兼容）
 *   > 指针 (name,scene) → published 版本
 *   > 工程默认内联（DEFAULT_PROMPTS，与迁移种子同源）
 *
 * 冻结语义（红线 #2）：freezeRunConfig 创建 run 时终解析全部模板，
 * {name, templateId, version, content, source} 全文冻结进 frozenConfig.raw.prompts；
 * 执行阶段只读冻结内容，禁止再次解析发布指针（retrieve 评审 F4 的教训）。
 * 会话层（intent/news/concept）不冻结全文，在 conversation_messages.promptRefs
 * 记录 {name, scene, version, templateId} 供审计。
 *
 * 不做长缓存：每次解析直接查指针表（每 run 创建 1-2 次索引查询）——
 * 规避 API 与 pg-boss worker 双进程缓存失效问题。
 */
import { and, desc, eq } from 'drizzle-orm'
import { promptTemplates, promptTemplatePointers } from '../models.js'
import type { PromptTemplateRow } from '../models.js'
import { getDb } from '../db.js'
import { kv, log } from '../logger.js'

/** 注册表管理的模板名（全部 LLM 调用点的提示词，§3.2.1 表 + P1-2/P1-5 新增两个） */
export const PROMPT_NAMES = [
  'intent-classifier',
  'counter-reviewer',
  'news-attribution',
  'concept-teaching',
  'query-rewrite',
  'synthesis-writer',
  'memory-extraction',
  'translate',
] as const
export type PromptName = (typeof PROMPT_NAMES)[number]

/**
 * 工程默认模板（与迁移 0017 种子同源；counter-reviewer 为 P0-3 版——
 * 要求每行 [k] 证据编号，配合 countercaseParse 逐条绑定）。
 */
export const DEFAULT_PROMPTS: Record<PromptName, string> = {
  'intent-classifier': `你是 Brooks 价格行为研究助手的意图分类器。把用户消息分类为恰好一个意图，只输出 JSON：
{"intent":"...","subQuestions":["..."]}

intent 取值：
- concept：询问概念/术语/方法含义（「什么是」「怎么理解」「是什么意思」）
- structure：问行情结构/方向/能不能买卖（「现在能买吗」「看涨还是看跌」「结构如何」「要不要抄底」）
- perp：涉及用户自己的永续持仓/杠杆/止损/加减仓/强平（「我的多单」「止损放哪」「改成 20 倍」）
- event：事件合约/执行价/到期/报价语义（「到期高于 70000」「这份报价值不值」）
- replay：复盘历史时点（「昨天这时候」「复盘上周」「如果当时」）
- news：新闻/消息面/涨跌归因（「为什么大跌」「有什么消息」）
- translate：翻译请求（「翻译成英文」「把这段译成中文」「translate ... to English」）
- system：寒暄、与交易研究无关、能力询问（「你好」「你是谁」「你能做什么」）

规则：
- 拿不准选 structure。
- 「能不能买/要不要卖」无持仓语境 → structure；明确提到自己的持仓/多单/空单/杠杆 → perp。
- 明确的翻译/译成指令（消息主体是要翻译的文本）→ translate，不是 system。
- subQuestions：消息明显包含 2 个以上相互独立的问题、主意图只能覆盖其一时，把其余问题原文列出（至多 2 个）；否则空数组。
- 只输出 JSON，不要任何其他文字。`,
  'counter-reviewer': `你是反证审查者。基于编号反证证据，每行一条反对当前方向的理由（中文，≤80字）。要求：
- 每行末尾用 [k] 标注该行引用的证据编号（如 [1]，或多条 [2][3]）；无合适证据时标 [0]，不要为了格式编造关联。
- 只引用证据内容，禁止编造数字，禁止出现概率/胜率数字。
- 没有可用反证输出：无。`,
  'news-attribution':
    '你是加密市场新闻归因助手。只基于给定的已核验网页内容回答用户问题（中文，≤250 字），' +
    '结尾用 [1][2] 标注引用编号；网页内容与问题无关就明说未找到相关归因，不得使用外部知识编造。',
  'concept-teaching':
    '你是 Brooks 价格行为教学者。基于给出的资料片段回答概念问题（中文，≤200 字），末尾用「注意：」给一条常见误解或反例。只使用资料内容，没有就明说资料未覆盖。',
  'query-rewrite':
    '你是检索查询改写器。给定中文交易研究问题与命中的 Brooks 术语，生成改写查询用于知识库召回。' +
    '规则：保持原意；可展开术语规范名、中英文对应、同义表述；不得引入原问题没有的概念；' +
    '每个变体不超过 120 字；只输出 JSON 字符串数组，不要任何解释。',
  'synthesis-writer': `你是研究综合解释者。基于给出的「已计算事实与条件」「反证要点」「编号证据」，直接回应用户的研究问题（中文，≤200 字）。要求：
- 只能引用已给出的内容：不引入任何新数字、新结论、新价格；概率数字一律禁止。
- 句末用 [k] 标注该句依据的证据编号（如 [1]，或多条 [2][3]）；无合适证据的句子不标注。
- 先给结论（对应已计算的动作），再说主要理由与前提条件，最后点出最需要留意的反证。
- 不给建议性指令，不出现在证据之外的市场判断。`,
  'memory-extraction': `你是记忆管理器，负责从「用户与研究助手的对话」中提取关于用户的长期记忆。

一条记忆 = 一个独立、自包含的事实或偏好，脱离原对话也能读懂（例如「用户偏好短线交易，主要关注 SOL 和 meme 币」）。

只提取跨对话仍有价值的信息：
- 用户背景（职业、交易经验水平）
- 分析偏好（风格、风险偏好、仓位习惯、关注的板块/币种）
- 明确表达过的要求与习惯（回复详略、语言、格式偏好）
- 长期目标或约束

不要提取：
- 与当下行情临时相关的内容（某币此刻涨跌、今日大盘状态）
- 助手回答的内容本身
- 一次性的具体提问

维护规则：
- 与已有记忆重复或近似 → 不加
- 与已有记忆矛盾（偏好改变等）→ 用 update 修正原条目
- 已明显过时（用户已明确放弃）→ 用 delete 移除

只输出严格 JSON，不要任何其他文本：
{"add":[{"kind":"preference|fact|interest|habit","content":"一句话记忆"}],"update":[{"id":"已有记忆id","content":"修正后的内容"}],"delete":["过时记忆id"]}
没有变更时输出 {"add":[],"update":[],"delete":[]}`,
  'translate': `你是金融/加密领域的专业译者。把用户提供的文本翻译成指定的目标语言。术语表（固定译法，双向适用）：
- 冲刺 = spike；楔顶/楔底 = wedge top/bottom；二次进场 = second entry；内包线 = inside bar；外包线 = outside bar
- 趋势线突破 = trend line break（TLB）；主要趋势反转 = major trend reversal（MTR）；交易区间 = trading range
- 高潮反转 = climax reversal；铁丝网 = barbed wire；Always In / H1~H4 / L1~L4 / EMA20 保持原文不译

规则：
- 保留交易对代码（BTCUSDT）、数字、价格、百分比、公式与 markdown 结构，不做任何换算或改写。
- 只输出译文本身，不要任何解释、前缀或原文复述。
- 原文中的语言混杂按目标语言统一；无对应术语时保留原文。`,
}

/**
 * 提示词占位符渲染（§4.B：{{vertical}}/{{traderProfile}}/{{memory}}/{{knowledgeVersion}}
 * 服务端统一拼装，调用方传入实际值；未提供的占位符剔除（不残留 {{...}} 语法给模型）。
 */
export function renderPrompt(content: string, vars: Partial<Record<'vertical' | 'traderProfile' | 'memory' | 'knowledgeVersion', string>>): string {
  let out = content
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v ?? '')
  }
  return out.replace(/\{\{(vertical|traderProfile|memory|knowledgeVersion)\}\}/g, '')
}

/** 终解析结果（冻结进 frozenConfig.raw.prompts 的形状） */
export interface ResolvedPrompt {
  name: PromptName
  scene: string
  content: string
  /** registry 解析时为模板行 id；inline/文件/默认时为 null */
  templateId: string | null
  version: number | null
  source: 'registry' | 'inline_ref' | 'file_ref' | 'default'
}

function fallback(name: PromptName, scene: string): ResolvedPrompt {
  return { name, scene, content: DEFAULT_PROMPTS[name], templateId: null, version: null, source: 'default' }
}

/** 旧文件名兼容：server/data/prompts/<ref>.txt（与 resolveRolePrompt 同规则；独立实现避免与 stages 循环依赖） */
async function readPromptFile(promptRef: string): Promise<string | null> {
  if (!/^[\w.-]{1,64}$/.test(promptRef)) return null
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const file = fileURLToPath(new URL('../../data/prompts/' + promptRef + '.txt', import.meta.url))
  try {
    const text = (await readFile(file, 'utf8')).trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

async function pointerPublished(name: string, scene: string): Promise<PromptTemplateRow | null> {
  const d = getDb()
  if (d === null) return null
  try {
    const ptr = await d
      .select({ publishedId: promptTemplatePointers.publishedId })
      .from(promptTemplatePointers)
      .where(and(eq(promptTemplatePointers.name, name), eq(promptTemplatePointers.scene, scene)))
      .limit(1)
    if (ptr.length === 0) return null
    const rows = await d
      .select()
      .from(promptTemplates)
      .where(and(eq(promptTemplates.id, ptr[0].publishedId), eq(promptTemplates.status, 'published')))
      .limit(1)
    return rows[0] ?? null
  } catch {
    return null
  }
}

/**
 * 解析模板（三级回退）。scene 缺省 ''（全局）。promptRef 支持：
 * - `inline:<文本>`：配置内联
 * - `registry:<uuid>`：注册表指定版本（须 published）
 * - `<文件名>`：旧 server/data/prompts/<ref>.txt 兼容
 * 任何一步失败向下回退（记日志），最终兜底工程默认——缺省不阻塞 run 创建。
 */
export async function resolvePromptTemplate(
  name: PromptName,
  opts: { scene?: string | null; promptRef?: string | null | undefined } = {},
): Promise<ResolvedPrompt> {
  const scene = opts.scene ?? ''
  const promptRef = opts.promptRef ?? null
  // 1) 显式 promptRef
  if (promptRef !== null && promptRef !== '') {
    if (promptRef.startsWith('inline:')) {
      const text = promptRef.slice('inline:'.length).trim()
      if (text.length > 0) return { name, scene, content: text, templateId: null, version: null, source: 'inline_ref' }
    } else if (promptRef.startsWith('registry:')) {
      const id = promptRef.slice('registry:'.length).trim()
      const d = getDb()
      if (d !== null && /^[\w-]{1,64}$/.test(id)) {
        const rows = await d
          .select()
          .from(promptTemplates)
          .where(and(eq(promptTemplates.id, id), eq(promptTemplates.status, 'published')))
          .limit(1)
        if (rows[0] !== undefined) {
          return { name, scene, content: rows[0].content, templateId: rows[0].id, version: rows[0].version, source: 'registry' }
        }
      }
      log.warn('prompts', 'registry promptRef 解析失败（回退指针→默认）', kv({ name, promptRef }))
    } else {
      const text = await readPromptFile(promptRef)
      if (text !== null) return { name, scene, content: text, templateId: null, version: null, source: 'file_ref' }
      log.warn('prompts', '文件 promptRef 解析失败（回退指针→默认）', kv({ name, promptRef }))
    }
  }
  // 2) 指针 → published（2026-10-20 评审 #5：scene 非空先查场景作用域，未发布回退全局指针）
  let published = scene !== '' ? await pointerPublished(name, scene) : null
  if (published === null) published = await pointerPublished(name, '')
  if (published !== null) {
    return { name, scene: published.scene, content: published.content, templateId: published.id, version: published.version, source: 'registry' }
  }
  // 3) 工程默认
  return fallback(name, scene)
}

/**
 * freezeRunConfig 终解析：七个模板全部解析并冻结。
 * counter-reviewer 尊重 agent 配置 roles 里反证审查者的显式 promptRef
 * （旧 run 的 inline:/文件引用语义不变）；其余走指针→默认。
 * scene（2026-10-20 评审 #5）：run 的任务场景——指针按 (name, scene) 场景作用域解析，
 * 场景未发布时 resolvePromptTemplate 内部回退全局指针→工程默认。
 */
export async function freezePromptSet(
  agentRaw: { roles?: { name?: string; promptRef?: string }[] } | null | undefined,
  scene?: string,
): Promise<Record<string, ResolvedPrompt>> {
  const roles = agentRaw?.roles ?? []
  const counterRole = roles.find((r) => /counter|反证/i.test(r.name ?? '')) ?? null
  const runScene = scene ?? ''
  const out: Record<string, ResolvedPrompt> = {}
  for (const name of PROMPT_NAMES) {
    out[name] =
      name === 'counter-reviewer' && counterRole?.promptRef !== undefined
        ? await resolvePromptTemplate(name, { promptRef: counterRole.promptRef })
        : await resolvePromptTemplate(name, { scene: runScene })
  }
  return out
}

/** 冻结集里的模板取用（执行阶段只读；旧检查点恢复时无 prompts 字段 → null，调用方回退） */
export function frozenPrompt(
  frozenRaw: { prompts?: Record<string, Partial<ResolvedPrompt> | undefined> } | undefined,
  name: PromptName,
): ResolvedPrompt | null {
  const p = frozenRaw?.prompts?.[name]
  if (p === undefined || typeof p.content !== 'string' || p.content.length === 0) return null
  return {
    name,
    scene: typeof p.scene === 'string' ? p.scene : '',
    content: p.content,
    templateId: typeof p.templateId === 'string' ? p.templateId : null,
    version: typeof p.version === 'number' ? p.version : null,
    source: 'registry',
  }
}

/** 指针写入（发布/回滚与调用方同事务由 admin 端点负责；此处为独立切换的独立事务封装） */
export async function writePromptPointer(name: string, scene: string, publishedId: string): Promise<void> {
  const d = getDb()!
  await d
    .insert(promptTemplatePointers)
    .values({ name, scene, publishedId })
    .onConflictDoUpdate({ target: [promptTemplatePointers.name, promptTemplatePointers.scene], set: { publishedId, updatedAt: new Date() } })
}

/** 指针删除（回归脚本清理测试指针用；生产指针由发布/回滚路径覆写，不走删除） */
export async function deletePromptPointer(name: string, scene: string): Promise<void> {
  const d = getDb()
  if (d === null) return
  await d
    .delete(promptTemplatePointers)
    .where(and(eq(promptTemplatePointers.name, name), eq(promptTemplatePointers.scene, scene)))
}

/** 模板行删除（回归脚本清理测试草稿/发布行用） */
export async function deletePromptRow(id: string): Promise<void> {
  const d = getDb()
  if (d === null) return
  await d.delete(promptTemplates).where(eq(promptTemplates.id, id))
}

/** 同 (name,scene) 下一个版本号（新草稿用） */
export async function nextPromptVersion(name: string, scene: string): Promise<number> {
  const d = getDb()
  if (d === null) return 1
  const rows = await d
    .select({ version: promptTemplates.version })
    .from(promptTemplates)
    .where(and(eq(promptTemplates.name, name), eq(promptTemplates.scene, scene)))
    .orderBy(desc(promptTemplates.version))
    .limit(1)
  return (rows[0]?.version ?? 0) + 1
}
