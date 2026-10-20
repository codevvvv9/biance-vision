/**
 * 翻译执行（Part 2 翻译 Agent，方案 ant-man-crystal-wolverine.md）：
 * 三级降级链——
 *   1. LLM 主翻：resolveLlmClient() + 注册表 'translate' 提示词（金融术语表，
 *      低 temperature、20s 超时；成功返回 engine:'llm'）
 *   2. Argos 离线包：research-py /tasks/translate（zh↔en 离线神经 MT）；
 *      LLM 未配置/抛错/超时或目标语言不在 Argos 支持范围时尝试；成功 engine:'argos'
 *   3. 终态降级：两者都不可用 → 显式「翻译能力暂不可用」，不伪造译文（红线：不编造）
 *
 * 翻译不创建研究 run、不写 portfolio，与持仓/事件草稿流程完全隔离。
 * 链路 B 直答分支与链路 A /translate slash 命令共用本模块。
 */
import { resolveLlmClient } from './llm.js'
import { resolvePromptTemplate } from './prompts.js'
import type { ResolvedPrompt } from './prompts.js'
import { translateViaArgos } from '../researchpy.js'

/** Argos 离线包支持的语言对（只随镜像预置 zh↔en；其余目标语言仅 LLM 可翻） */
export const ARGOS_LANGS = new Set(['zh', 'en'])

export interface TranslateOutcome {
  /** 译文；null = 两个引擎均不可用（调用方走显式降级文案） */
  text: string | null
  /** 'llm' = 大模型主翻；'argos' = 离线引擎兜底（回复需附来源标注） */
  engine: 'llm' | 'argos' | null
  /** LLM 路径实际使用的提示词版本（审计；Argos/降级路径为 null） */
  promptRefs: { name: string; scene: string; version: number | null; templateId: string | null }[] | null
}

export interface TranslateRequest {
  /** 去掉指令部分后的待译文本 */
  text: string
  /** 目标语言（BCP-47 简码：zh / en / ja / ko / …） */
  targetLang: string
  /** 源语言；'auto' = 由引擎自动检测 */
  sourceLang: string
}

const LANG_PATTERNS: { lang: string; re: RegExp }[] = [
  { lang: 'zh', re: /中文|汉语|国语|chinese|mandarin/i },
  { lang: 'en', re: /英文|英语|english/i },
  { lang: 'ja', re: /日文|日语|japanese|にほんご/i },
  { lang: 'ko', re: /韩文|韩语|korean/i },
  { lang: 'fr', re: /法文|法语|french/i },
  { lang: 'de', re: /德文|德语|german/i },
  { lang: 'es', re: /西班牙文|西班牙语|spanish/i },
  { lang: 'ru', re: /俄文|俄语|russian/i },
]

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/

/**
 * 解析翻译指令：「把 X 翻译成英文」「X 译成中文」「translate X to English」「帮我翻译 X」。
 * 目标语言缺省规则：待译文本以中文为主 → 译成英文；否则 → 译成中文（用剥离指令后的
 * 正文判断，指令词「翻译/帮我」的汉字不得污染比例）。
 * 与 conversation.ts TRANSLATE_RE 同源语义（意图路由命中后才进入本函数）。
 */
export function parseTranslateRequest(raw: string): TranslateRequest {
  let rest = raw.trim()
  let targetLang: string | null = null

  // 1) 目标语言：中文指令「翻译成/译成/翻成/译为 + 语言」；英文指令「translate (this/it) (in)to + lang」
  const zhInto = rest.match(/(?:翻译成|译成|翻成|译为)\s*([\u4e00-\u9fff]+|[a-zA-Z]+)/)
  if (zhInto !== null) {
    const hit = LANG_PATTERNS.find((p) => p.re.test(zhInto[1]))
    if (hit !== undefined) targetLang = hit.lang
  } else {
    const enInto = rest.match(/\btranslate\b[\s\S]{0,16}?\b(?:in)?to\s+([a-zA-Z]+)/i)
    if (enInto !== null) {
      const hit = LANG_PATTERNS.find((p) => p.re.test(enInto[1]))
      if (hit !== undefined) targetLang = hit.lang
    }
  }

  // 2) 剥离指令外壳，得到待译正文
  rest = rest
    // 头部指令词
    .replace(/^(?:请|帮我|麻烦)?\s*(?:把|将)?\s*/g, '')
    .replace(/^(?:translate|翻译)\b\s*/i, '')
    // 「帮我翻译 X」剥掉「帮我」后头部残留的孤立「翻译」
    .replace(/^(?:翻译|译一下|翻译一下)\s*/, '')
    // 「this/it/这段话/这段文字」等填充指代
    .replace(/^(?:this|it|那?这段(?:话|文字|内容)|下面的?内容)\s*[:：,，]?\s*/i, '')
    // 中段「翻译成/译成/翻成/译为 + 语言（可带冒号/引号）」
    .replace(/(?:翻译成|译成|翻成|译为)\s*(?:[\u4e00-\u9fff]{1,4}|[a-zA-Z]+)\s*[:：,，]?\s*/, '')
    // 英文句式的「to <lang> + 冒号」
    .replace(/\b(?:in)?to\s+(?:chinese|english|japanese|korean|french|german|spanish|russian|mandarin)\b\s*[:：,，]?\s*/i, '')
    // 尾部「，翻译一下 / 帮我翻译 / translate (this/it)?(to xx)?」
    .replace(/(?:，|,)?\s*(?:帮我)?(?:翻译|翻译一下|译一下|翻译过来)\s*[。.!！]?$/i, '')
    .replace(/(?:，|,)?\s*translate(?:\s+(?:this|it))?(?:\s+to\s+[a-zA-Z]+)?\s*[。.!！]?$/i, '')
    // 残留的包裹引号
    .replace(/^[「"'『“]|[」"'』”]$/g, '')
    .trim()

  // 3) 缺省目标语言：按待译正文的 CJK 占比判断（zh → en；其他 → zh）
  if (targetLang === null) {
    const cjkCount = (rest.match(/[\u4e00-\u9fff]/g) ?? []).length
    targetLang = rest !== '' && cjkCount > rest.length * 0.2 ? 'en' : 'zh'
  }
  const sourceLang = targetLang === 'zh' ? 'en' : 'zh'
  return { text: rest, targetLang, sourceLang }
}

const LANG_NAME: Record<string, string> = {
  zh: '中文', en: 'English', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', ru: '俄语',
}

/**
 * 执行翻译降级链。text 为空串时直接返回 null（指令里没有可翻内容，交由调用方引导）。
 * LLM 主翻使用注册表 'translate' 模板（金融术语表）；Argos 仅支持 zh↔en。
 */
export async function translateWithFallback(rawInstruction: string, req?: TranslateRequest): Promise<TranslateOutcome> {
  const parsed = req ?? parseTranslateRequest(rawInstruction)
  if (parsed.text === '') return { text: null, engine: null, promptRefs: null }

  // ---- 主路径：LLM 主翻 ----
  const llm = resolveLlmClient()
  if (llm !== null) {
    try {
      const prompt: ResolvedPrompt = await resolvePromptTemplate('translate')
      const out = await llm.complete({
        system: prompt.content,
        user: `目标语言：${LANG_NAME[parsed.targetLang] ?? parsed.targetLang}\n\n待译文本：\n${parsed.text}`,
        maxTokens: 1200,
        temperature: 0,
        // 翻译是用户显式等待的操作；自托管 vLLM 实测排队可达 55s+，给足余量
        timeoutMs: 90_000,
      })
      const text = out.text.trim()
      if (text !== '') {
        return {
          text,
          engine: 'llm',
          promptRefs: [{ name: prompt.name, scene: prompt.scene, version: prompt.version, templateId: prompt.templateId }],
        }
      }
    } catch {
      // 落入 Argos 兜底
    }
  }

  // ---- 兜底路径：Argos 离线包（仅 zh↔en）----
  if (ARGOS_LANGS.has(parsed.targetLang) && ARGOS_LANGS.has(parsed.sourceLang)) {
    try {
      const out = await translateViaArgos(parsed.text, parsed.sourceLang, parsed.targetLang)
      if (out !== null && out !== '') return { text: out, engine: 'argos', promptRefs: null }
    } catch {
      // 落入终态降级
    }
  }

  // ---- 终态降级：显式说明，不伪造 ----
  return { text: null, engine: null, promptRefs: null }
}
