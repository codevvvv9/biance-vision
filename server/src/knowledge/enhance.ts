/**
 * R3 LLM 索引增强（docs/rag-pipeline-design.md §5.6，评测驱动、默认关闭）：
 * 切块入库后、向量化前，按批（≤16 块一次调用）让 LLM 为每个文本块生成
 * auto-keyword / auto-question，**合并写入该块 terms[]**（词项召回直接受益）；
 * 问题文本存 parseMeta.enhancedQuestions 供评测审查。
 *
 * 设计纪律（OCP/解耦）：
 * - 能力开关走 AgentCapabilities.knowledge.enhance（capabilities 治理链，
 *   管理端 Agent 页可改，缺省 enabled=false=零行为变化）；
 * - 提示词走既有提示词治理（PROMPT_NAMES 注册 'knowledge-enhance'，
 *   管理端提示词页可版本化覆盖，工程默认兜底）；
 * - 失败不阻塞索引（enhance_failed 留痕于 parseMeta，文档照常 indexed）；
 * - 输出严格 JSON 解析+逐块容错：单块产出非法仅跳过该块，不判整体失败；
 * - 本模块不碰检索内核（retrieval.ts 零改动）——增强只发生在索引侧。
 */
import { log, kv } from '../logger.js'
import { resolveLlmClient } from '../research/llm.js'
import { resolvePromptTemplate } from '../research/prompts.js'
import { getCapabilities } from '../admin/capabilities.js'
/** 增强输入的最小形状（解耦：切块域对象或落库行皆可传入） */
export interface EnhanceChunk {
  id: string
  text: string
}

/** capabilities.knowledge.enhance 配置节（AgentCapabilitiesSchema 扩展，缺省关闭） */
export interface EnhanceConfig {
  enabled: boolean
  /** 每块生成关键词数 */
  keywordsPerChunk: number
  /** 每块生成假设问题数 */
  questionsPerChunk: number
}

export const ENHANCE_DEFAULTS: EnhanceConfig = { enabled: false, keywordsPerChunk: 4, questionsPerChunk: 2 }

/** 批大小（单次 LLM 调用处理的块数；方案 §5.6） */
const BATCH = 16

export interface EnhanceResult {
  /** 增强写入的词项总数（keywords+questions 合并去重后跨块合计） */
  termsAdded: number
  /** 存入 parseMeta 供评测审查的问题文本（按块序） */
  enhancedQuestions: string[]
  /** 跳过/失败的块数（产出非法或 LLM 缺失） */
  skipped: number
}

/** 读生效配置（capabilities 链上的 knowledge.enhance；缺省/非法回默认关闭） */
export function enhanceConfig(): EnhanceConfig {
  const raw = (getCapabilities() as { knowledge?: { enhance?: Partial<EnhanceConfig> } }).knowledge?.enhance
  if (raw === undefined || raw === null) return ENHANCE_DEFAULTS
  return {
    enabled: raw.enabled === true,
    keywordsPerChunk: clampInt(raw.keywordsPerChunk, 1, 8, ENHANCE_DEFAULTS.keywordsPerChunk),
    questionsPerChunk: clampInt(raw.questionsPerChunk, 1, 4, ENHANCE_DEFAULTS.questionsPerChunk),
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback
}

/**
 * 工程默认提示词（与 PROMPT_NAMES 'knowledge-enhance' 注册同源；管理端可覆盖）。
 * 输出契约：严格 JSON 数组，每元素 { index, keywords[], questions[] }。
 */
export const ENHANCE_PROMPT = `你是检索索引优化器。给定一批交易教学/研究文档的文本块，为每块生成检索关键词与用户可能提出的假设问题。

要求：
- keywords：该块核心概念的检索词（术语缩写、中英别名、口语说法各取所需），不重复块内原句
- questions：用户会在搜索框里自然输入的问题句式（中文为主，可含术语英文缩写）
- 只依据块内内容，不引入外部事实；块与主题无关或太短则给空数组
- 只输出严格 JSON 数组，不要任何其他文本：
[{"index":0,"keywords":["k1","k2"],"questions":["q1","q2"]}]
没有可增强内容时输出 []`

/** 单批的 LLM 输入（块正文截断，防长块撑爆上下文） */
function blockInput(c: EnhanceChunk): string {
  return c.text.slice(0, 600)
}

/**
 * 对一批切块执行增强（核心纯逻辑：调 LLM→解析→合并词项）。
 * 高内聚：只依赖传入的块与配置，不读写库——terms 合并结果由调用方落库。
 */
export async function enhanceChunkBatch(
  chunks: EnhanceChunk[],
  cfg: EnhanceConfig,
  promptContent: string,
): Promise<{ perChunkTerms: string[][]; questions: string[]; skipped: number }> {
  const llm = resolveLlmClient()
  if (llm === null) return { perChunkTerms: chunks.map(() => []), questions: [], skipped: chunks.length }
  const numbered = chunks
    .map((c, i) => `【块${i}】${blockInput(c)}`)
    .join('\n\n')
  const out = await llm.complete({
    system: promptContent,
    user: `配置：每块 keywords≤${cfg.keywordsPerChunk} 条、questions≤${cfg.questionsPerChunk} 条。\n\n${numbered}`,
    maxTokens: 200 * BATCH,
    timeoutMs: 60_000,
  })
  const parsed = parseEnhanceJson(out.text)
  const perChunkTerms: string[][] = chunks.map(() => [])
  const questions: string[] = []
  let skipped = 0
  if (parsed === null) return { perChunkTerms, questions, skipped: chunks.length }
  const byIndex = new Map(parsed.map((p) => [p.index, p]))
  for (let i = 0; i < chunks.length; i++) {
    const item = byIndex.get(i)
    if (item === undefined) {
      skipped++
      continue
    }
    const kws = (Array.isArray(item.keywords) ? item.keywords : [])
      .filter((k): k is string => typeof k === 'string' && k.trim() !== '')
      .map((k) => k.trim().slice(0, 40))
      .slice(0, cfg.keywordsPerChunk)
    const qs = (Array.isArray(item.questions) ? item.questions : [])
      .filter((q): q is string => typeof q === 'string' && q.trim() !== '')
      .map((q) => q.trim().slice(0, 120))
      .slice(0, cfg.questionsPerChunk)
    if (kws.length === 0 && qs.length === 0) {
      skipped++
      continue
    }
    // 问题文本降为词项形态写入 terms（问题整句不进 GIN 词项索引，取其关键词）；
    // 原句进 enhancedQuestions 供评测与人工审查
    perChunkTerms[i] = [...new Set([...kws, ...qs.flatMap(questionToTerms)])]
    questions.push(...qs)
  }
  return { perChunkTerms, questions, skipped }
}

/** 问题句 → 检索词项（去停词的粗分词：中文 bigram 化、英文/缩写整词） */
function questionToTerms(q: string): string[] {
  return q
    .split(/[，。？！,.?!\s、；;：:「」"'（）()]+/)
    .filter((t) => t.length >= 2 && t.length <= 12)
    .slice(0, 6)
}

/** 容错解析 LLM 输出（直接 parse 失败时截取首尾方括号再试） */
function parseEnhanceJson(raw: string): { index: number; keywords?: unknown; questions?: unknown }[] | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  let parsed = tryParse(raw.trim())
  if (parsed === null) {
    const start = raw.indexOf('[')
    const end = raw.lastIndexOf(']')
    if (start >= 0 && end > start) parsed = tryParse(raw.slice(start, end + 1))
  }
  if (!Array.isArray(parsed)) return null
  const out: { index: number; keywords?: unknown; questions?: unknown }[] = []
  for (const p of parsed) {
    if (p === null || typeof p !== 'object') continue
    const o = p as Record<string, unknown>
    if (typeof o.index !== 'number' || !Number.isInteger(o.index) || o.index < 0) continue
    out.push({ index: o.index, keywords: o.keywords, questions: o.questions })
  }
  return out
}

/**
 * 管线挂点（pipeline.ts 在 chunking 之后、indexStep 之前调用）：
 * 全量切块分批增强并把合并词项写回各块 terms（updateChunkTerms 逐块）。
 * 返回留痕数据；任何异常在这里吸收（enhance_failed），绝不阻塞索引。
 */
export async function enhanceDocument(
  docId: string,
  chunks: EnhanceChunk[],
  updateChunkTerms: (chunkId: string, extraTerms: string[]) => Promise<void>,
): Promise<EnhanceResult | { enhance_failed: string }> {
  const cfg = enhanceConfig()
  if (!cfg.enabled) return { termsAdded: 0, enhancedQuestions: [], skipped: 0 }
  const llm = resolveLlmClient()
  if (llm === null) return { enhance_failed: 'chat 能力未配置（跳过增强，索引不受阻）' }
  const startedAt = Date.now()
  try {
    const prompt = await resolvePromptTemplate('knowledge-enhance')
    let termsAdded = 0
    const enhancedQuestions: string[] = []
    let skipped = 0
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH)
      const r = await enhanceChunkBatch(batch, cfg, prompt.content)
      for (let j = 0; j < batch.length; j++) {
        if (r.perChunkTerms[j] !== undefined && r.perChunkTerms[j].length > 0) {
          await updateChunkTerms(batch[j].id, r.perChunkTerms[j])
          termsAdded += r.perChunkTerms[j].length
        }
      }
      enhancedQuestions.push(...r.questions)
      skipped += r.skipped
    }
    log.ok('knowledge', 'R3 索引增强完成', kv({
      id: docId.slice(0, 8),
      块: chunks.length,
      增词项: termsAdded,
      跳过块: skipped || undefined,
      耗时ms: Date.now() - startedAt,
    }))
    return { termsAdded, enhancedQuestions, skipped }
  } catch (err) {
    log.warn('knowledge', 'R3 索引增强失败（索引不受阻）', kv({ id: docId.slice(0, 8), 错误: (err as Error).message }))
    return { enhance_failed: (err as Error).message.slice(0, 200) }
  }
}

/** 自测钩子（scripts/knowledge-smoke 消费；纯函数无副作用） */
export const parseEnhanceJsonForTest = parseEnhanceJson
