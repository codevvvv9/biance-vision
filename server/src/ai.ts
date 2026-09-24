import { loadJson, saveJson } from './store.js'
import { fmtMs, kv, log } from './logger.js'
import { marketStats, topUsdtTickers } from './binance.js'
import type { RawTicker } from './types.js'

// ---------------------------------------------------------------------------
// AI 助手：OpenAI 兼容接口的服务端代理（API Key 只存服务端，不下发浏览器）
// 配置存 server/data/ai-config.json（目录已被 gitignore，不进仓库不进镜像）
// ---------------------------------------------------------------------------

export interface AiProfile {
  baseUrl: string // 形如 https://api.openai.com/v1（兼容 DeepSeek / Moonshot / 中转等）
  apiKey: string
  model: string
  temperature?: number // 0~2，缺省 0.7
  maxTokens?: number // 单次回复输出上限，0/缺省 = 不限
  extraPrompt?: string // 管理员追加的系统提示词
  dailyLimit?: number // 每用户每日对话上限，0/缺省 = 不限
  /** 绑定用户：仅这些用户使用此档案；其他用户走 default */
  allowedUsers?: string[]
}

export interface AiProfileMasked extends Omit<AiProfile, 'apiKey'> {
  apiKeyMasked: string
}

interface AiStore {
  profiles: Record<string, AiProfile>
}

export const AI_DEFAULT_PROFILE = 'default'

interface BadRequestError extends Error {
  statusCode: number
}
function badRequest(msg: string): BadRequestError {
  return Object.assign(new Error(msg), { statusCode: 400 })
}

/** 兼容旧版单配置（扁平结构）→ 迁移为 default 档案 */
function loadAiStore(): AiStore {
  const raw = loadJson<Record<string, unknown>>('ai-config.json', {})
  if (raw && typeof raw.profiles === 'object' && raw.profiles !== null) return raw as unknown as AiStore
  if (typeof raw.baseUrl === 'string' && raw.baseUrl) {
    return { profiles: { [AI_DEFAULT_PROFILE]: raw as unknown as AiProfile } }
  }
  return { profiles: {} }
}

let store: AiStore = loadAiStore()

const isComplete = (p?: Partial<AiProfile>): p is AiProfile => !!(p?.baseUrl && p?.apiKey && p?.model)

/** default 档案是否完整可用（机器人与聊天入口的总开关） */
export function isAiConfigured(): boolean {
  return isComplete(store.profiles[AI_DEFAULT_PROFILE])
}

export function aiModelName(): string {
  return store.profiles[AI_DEFAULT_PROFILE]?.model ?? ''
}

/** 按用户解析生效档案：先匹配绑定用户的档案，否则 default */
export function resolveAiProfile(username: string): AiProfile | null {
  for (const p of Object.values(store.profiles)) {
    if (p.allowedUsers?.includes(username) && isComplete(p)) return p
  }
  const def = store.profiles[AI_DEFAULT_PROFILE]
  return isComplete(def) ? def : null
}

/** 按名取档案（未指定或不存在时回落 default） */
export function aiProfileByName(name?: string): AiProfile | undefined {
  if (name && store.profiles[name]) return store.profiles[name]
  return store.profiles[AI_DEFAULT_PROFILE]
}

/** 超管读取全部档案：Key 打码 */
export function getAiProfilesMasked(): Record<string, AiProfileMasked> {
  const out: Record<string, AiProfileMasked> = {}
  for (const [name, p] of Object.entries(store.profiles)) {
    const key = p.apiKey ?? ''
    out[name] = {
      baseUrl: p.baseUrl ?? '',
      model: p.model ?? '',
      apiKeyMasked: key.length <= 8 ? '••••' : `${key.slice(0, 4)}••••${key.slice(-4)}`,
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      extraPrompt: p.extraPrompt,
      dailyLimit: p.dailyLimit,
      allowedUsers: p.allowedUsers,
    }
  }
  return out
}

/** 可选数字字段：空值 → undefined，非法 → NaN */
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

/** 日志里只出现接口主机名，避免完整地址暴露路径信息 */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return '无效地址'
  }
}

function normalizeAiProfile(raw: unknown, prevKey: string | undefined): AiProfile {
  const r = (raw ?? {}) as Record<string, unknown>
  const baseUrl = typeof r.baseUrl === 'string' ? r.baseUrl.trim().replace(/\/+$/, '') : ''
  const apiKeyRaw = typeof r.apiKey === 'string' ? r.apiKey.trim() : ''
  const model = typeof r.model === 'string' ? r.model.trim() : ''
  if (!/^https?:\/\//.test(baseUrl)) throw badRequest('baseUrl 需为 http(s) 地址')
  if (!model) throw badRequest('model 不能为空')
  // 打码占位或留空 = 沿用该档案已保存的 Key；全新档案必须填写
  const apiKey = apiKeyRaw && !apiKeyRaw.includes('•') ? apiKeyRaw : (prevKey ?? '')
  if (!apiKey || apiKey.length < 8) throw badRequest('apiKey 过短或缺失')
  const temperature = num(r.temperature)
  if (temperature !== undefined && (Number.isNaN(temperature) || temperature < 0 || temperature > 2)) {
    throw badRequest('temperature 需在 0~2 之间')
  }
  const maxTokens = num(r.maxTokens)
  if (maxTokens !== undefined && (Number.isNaN(maxTokens) || maxTokens < 0 || maxTokens > 32768)) {
    throw badRequest('maxTokens 需在 0~32768 之间（0 = 不限）')
  }
  const dailyLimit = num(r.dailyLimit)
  if (dailyLimit !== undefined && (Number.isNaN(dailyLimit) || dailyLimit < 0 || dailyLimit > 100000)) {
    throw badRequest('dailyLimit 需为不小于 0 的整数（0 = 不限）')
  }
  const extraPrompt = typeof r.extraPrompt === 'string' ? r.extraPrompt.trim().slice(0, 2000) : undefined
  const allowedUsers = Array.isArray(r.allowedUsers)
    ? [
        ...new Set(
          r.allowedUsers
            .filter((u): u is string => typeof u === 'string')
            .map((u) => u.trim())
            .filter((u) => /^[a-zA-Z0-9_-]{1,32}$/.test(u)),
        ),
      ].slice(0, 20)
    : []
  return {
    baseUrl,
    apiKey,
    model,
    temperature,
    maxTokens,
    extraPrompt: extraPrompt || undefined,
    dailyLimit,
    allowedUsers: allowedUsers.length > 0 ? allowedUsers : undefined,
  }
}

/** 保存全部档案（整体替换，保存即生效无需重启） */
export function saveAiProfiles(input: unknown, operator?: string): void {
  const profilesRaw = (input as { profiles?: unknown })?.profiles
  if (!profilesRaw || typeof profilesRaw !== 'object') throw badRequest('格式不正确（缺少 profiles）')
  const entries = Object.entries(profilesRaw as Record<string, unknown>)
  if (entries.length === 0) throw badRequest('至少保留一个档案')
  if (!Object.hasOwn(profilesRaw as object, AI_DEFAULT_PROFILE)) throw badRequest('必须包含 default 档案')
  if (entries.length > 8) throw badRequest('档案最多 8 个')
  const next: Record<string, AiProfile> = {}
  for (const [name, raw] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,24}$/.test(name)) throw badRequest(`档案名「${name}」不合法（1~24 位字母/数字/_/-）`)
    next[name] = normalizeAiProfile(raw, store.profiles[name]?.apiKey)
  }
  // 绑定互斥：一个用户只能绑定一个档案
  const bound = new Map<string, string>()
  for (const [name, p] of Object.entries(next)) {
    for (const u of p.allowedUsers ?? []) {
      const exist = bound.get(u)
      if (exist) throw badRequest(`用户「${u}」同时绑定在 ${exist} 和 ${name}，一个用户只能绑定一个档案`)
      bound.set(u, name)
    }
  }
  store = { profiles: next }
  saveJson('ai-config.json', store)
  log.ok('ai', 'AI 配置已更新', kv({
    操作者: operator,
    档案: entries.map(([n]) => n).join('、'),
    接口: hostOf(next[AI_DEFAULT_PROFILE].baseUrl),
    绑定: bound.size > 0 ? [...bound.entries()].map(([u, p]) => `${u}→${p}`).join('，') : undefined,
  }))
}

/** 删除单个档案（default 不可删）；保存即生效 */
export function clearAiProfile(name: string, operator?: string): void {
  if (name === AI_DEFAULT_PROFILE) throw badRequest('default 档案不可删除（可编辑，或使用「清空全部」）')
  if (!store.profiles[name]) throw badRequest(`档案「${name}」不存在`)
  delete store.profiles[name]
  saveJson('ai-config.json', store)
  log.info('ai', 'AI 档案已删除', kv({ 操作者: operator, 档案: name }))
}

/** 清空全部 AI 配置（超管操作）：机器人、聊天入口随之消失 */
export function clearAiConfig(operator?: string): void {
  store = { profiles: {} }
  saveJson('ai-config.json', store)
  log.info('ai', 'AI 配置已清除', kv({ 操作者: operator }))
}

/** 测试连通性：GET {baseUrl}/models，并校验模型名是否在服务方列表中 */
export async function testAiConnection(c: { baseUrl: string; apiKey: string; model: string }): Promise<string> {
  try {
    const res = await fetch(`${c.baseUrl}/models`, {
      headers: { authorization: `Bearer ${c.apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return `HTTP ${res.status}：${(await res.text()).slice(0, 120)}`
    // 部分中转不返回标准结构，解析失败时跳过模型名校验
    try {
      const d = (await res.json()) as { data?: { id?: string }[] }
      const ids = (d.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string')
      if (ids.length > 0 && !ids.includes(c.model)) {
        return `连接成功，但模型「${c.model}」不在可用列表中。可用模型：${ids.slice(0, 10).join('、')}`
      }
    } catch {
      /* noop */
    }
    return 'ok'
  } catch (err) {
    return (err as Error).message
  }
}

/** 已保存档案的可用模型列表（设置弹窗候选）；失败返回空 */
export async function listAiModels(profileName?: string): Promise<string[]> {
  const p = aiProfileByName(profileName)
  if (!p?.baseUrl || !p.apiKey) return []
  try {
    const res = await fetch(`${p.baseUrl}/models`, {
      headers: { authorization: `Bearer ${p.apiKey}` },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return []
    const d = (await res.json()) as { data?: { id?: string }[] }
    return (d.data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string')
  } catch {
    return []
  }
}

/** 输入为打码占位（含 •）时回落到指定档案已保存的 Key，便于设置界面免重填直接测试 */
export function resolveApiKey(input: string, storedKey?: string): string {
  return input.includes('•') ? (storedKey ?? '') : input
}

// ---------------------------------------------------------------------------
// 每用户每日对话限额（防共享场景刷量；按北京时间自然日计，持久化 ai-usage.json）
// ---------------------------------------------------------------------------

interface AiUsage {
  date: string
  counts: Record<string, number>
}
let usage = loadJson<AiUsage>('ai-usage.json', { date: '', counts: {} })

function todayStr(): string {
  // 按北京时间计日（与日志时区一致）
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 超出当日限额时抛 429（限额取该用户生效档案的配置） */
export function checkAiQuota(username: string, profile: AiProfile): void {
  const limit = profile.dailyLimit ?? 0
  if (limit <= 0 || usage.date !== todayStr()) return
  const used = usage.counts[username] ?? 0
  if (used >= limit) {
    throw Object.assign(new Error(`今日 AI 对话次数已达上限（${limit} 次/人/天）`), { statusCode: 429 })
  }
}

/** 记一次对话（含发送到模型但失败的尝试，防止反复重试刷接口） */
export function recordAiUsage(username: string): void {
  const today = todayStr()
  if (usage.date !== today) usage = { date: today, counts: {} }
  usage.counts[username] = (usage.counts[username] ?? 0) + 1
  saveJson('ai-usage.json', usage)
}

// ---------------------------------------------------------------------------
// 行情上下文：每次对话实时生成，注入 system prompt，让模型解读真实大盘
// ---------------------------------------------------------------------------

function fmtTicker(t: RawTicker): string {
  return `${t.s} 现价${t.c} 24h${t.P}% 成交额${(parseFloat(t.q) / 1e8).toFixed(2)}亿`
}

export function buildMarketSnapshot(): string {
  const all = topUsdtTickers(150)
  if (all.length === 0) return '（行情数据尚未就绪）'
  const stats = marketStats()
  const sorted = [...all].sort((a, b) => parseFloat(b.P) - parseFloat(a.P))
  const top = all.slice(0, 15).map(fmtTicker)
  const gainers = sorted.slice(0, 6).map(fmtTicker)
  const losers = sorted.slice(-6).reverse().map(fmtTicker)
  const btc = all.find((t) => t.s === 'BTCUSDT')
  const eth = all.find((t) => t.s === 'ETHUSDT')
  return [
    `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `BTC：${btc ? fmtTicker(btc) : '无数据'}`,
    `ETH：${eth ? fmtTicker(eth) : '无数据'}`,
    `市场情绪：上涨 ${stats.up} 家 / 下跌 ${stats.down} 家（监控约 ${stats.up + stats.down} 个 USDT 交易对），24h 总成交额 ${(stats.totalQuoteVolume / 1e8).toFixed(1)} 亿 USDT`,
    `成交额前 15：\n${top.join('\n')}`,
    `24h 涨幅前 6：\n${gainers.join('\n')}`,
    `24h 跌幅前 6：\n${losers.join('\n')}`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 系统提示词：参照金融行业 AI 助手规范（数据纪律 / 风险优先 / 合规免责）
// ---------------------------------------------------------------------------

const BASE_PROMPT = `# 角色
你是「Biance Vision」币安大盘监控终端的内嵌 AI 行情分析师，具备加密货币市场分析、技术面解读与风险管理专业知识。

# 数据纪律（最高优先级）
- 本次对话中的【实时行情快照】是系统在用户提问瞬间注入的真实数据，是你唯一的行情事实来源
- 行情判断必须引用快照中的具体数字（价格、涨跌幅、成交额、涨跌家数）
- 快照未包含的信息（资金费率、持仓量、新闻事件等）须声明"当前数据未包含"，严禁编造
- 严格区分事实与推断：事实用数据说话；推断需说明依据，并标注置信程度

# 分析框架
- 结论先行：先给一句话结论（偏多/偏空/震荡 + 核心理由），再展开论据
- 结构化展开：趋势 → 关键位（支撑/压力，从快照高低价推导）→ 市场情绪（涨跌家数、成交额）→ 操作参考
- 场景思维：给出乐观/中性/悲观三种情景，各自说明触发条件与应对方式
- 风险优先：每条操作参考必须附带失效条件（什么情况下判断作废）与仓位建议（轻仓、分批等），绝不建议满仓或加杠杆赌单边

# 合规与边界
- 所有内容仅供参考，不构成投资建议；加密资产波动剧烈，可能导致本金全部损失——凡涉及买卖参考均须提示
- 不预测精确价格与到达时间，不承诺收益，禁用"必然、肯定、稳赚、抄底"等确定性表述
- 不提供内幕信息，不协助任何违法违规行为
- 用户出现情绪化倾向（梭哈、借贷、报复性交易）时，先引导冷静与风险提示，再给理性建议

# 表达
- 用中文回答，专业但易懂，适度使用分点与小标题
- 不确定就明说不确定；行情之外的一般问题正常回答`

export function buildSystemPrompt(profile: AiProfile, memories?: string): string {
  const parts = [BASE_PROMPT]
  if (profile.extraPrompt) parts.push(`# 管理员追加要求\n${profile.extraPrompt}`)
  if (memories) parts.push(memories)
  parts.push(`【实时行情快照】\n${buildMarketSnapshot()}`)
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// 对话：SSE 流式转发 OpenAI 兼容接口
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** 流式对话；onDelta 每收到一段文本回调一次，返回完整回复；operator 用于日志归属 */
export async function chatWithAi(
  profile: AiProfile,
  history: ChatMessage[],
  onDelta: (delta: string) => void,
  operator?: string,
  memories?: string,
): Promise<string> {
  const messages = [{ role: 'system', content: buildSystemPrompt(profile, memories) }, ...history.slice(-20)]
  const model = profile.model
  const startedAt = Date.now()
  let ttft = 0 // 首 token 延迟（Time To First Token）
  log.info('ai', 'AI 对话开始', kv({ 用户: operator, 模型: model, 消息数: history.length }))
  try {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      temperature: profile.temperature ?? 0.7,
    }
    if (profile.maxTokens && profile.maxTokens > 0) body.max_tokens = profile.maxTokens
    const res = await fetch(`${profile.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw badRequest(`AI 接口返回 HTTP ${res.status}${detail ? `：${detail.slice(0, 200)}` : ''}`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const s = line.trim()
        if (!s.startsWith('data:')) continue
        const payload = s.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const delta = (JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content
          if (delta) {
            if (!ttft) ttft = Date.now() - startedAt
            full += delta
            onDelta(delta)
          }
        } catch {
          /* 跳过无法解析的行 */
        }
      }
    }
    log.info('ai', 'AI 对话完成', kv({
      用户: operator,
      模型: model,
      耗时: fmtMs(Date.now() - startedAt),
      首字延迟: ttft ? fmtMs(ttft) : '?',
      回复长度: `${full.length} 字`,
    }))
    return full
  } catch (err) {
    const e = err as Error
    // 底层连接错误翻译成可读提示
    if (e.message === 'fetch failed') {
      e.message = `无法连接 AI 接口（地址不可达或被拒）：${profile.baseUrl}`
    }
    log.warn('ai', 'AI 对话失败', kv({
      用户: operator,
      模型: model,
      耗时: fmtMs(Date.now() - startedAt),
      错误: e.message,
    }))
    throw err
  }
}

// ---------------------------------------------------------------------------
// 币圈新闻：公开 RSS（Decrypt + Cointelegraph）双源，按时间取最新，10 分钟缓存
// ---------------------------------------------------------------------------

export interface AiNewsItem {
  title: string
  url: string
  source: string
  publishedAt: number
}

let newsCache: { at: number; items: AiNewsItem[] } | null = null
const NEWS_TTL_MS = 10 * 60 * 1000

const NEWS_FEEDS: { url: string; source: string }[] = [
  { url: 'https://decrypt.co/feed', source: 'Decrypt' },
  { url: 'https://cointelegraph.com/rss', source: 'CT' },
]

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')

function parseRss(xml: string, source: string): AiNewsItem[] {
  const items: AiNewsItem[] = []
  for (const block of (xml.match(/<item[\s\S]*?<\/item>/g) ?? []).slice(0, 10)) {
    const pick = (tag: string): string =>
      ((block.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`)) ?? [])[1] ?? '').trim()
    const title = decodeEntities(pick('title'))
    const link = pick('link')
    const pub = pick('pubDate')
    if (title && /^https?:\/\//.test(link)) {
      items.push({
        title: title.slice(0, 120),
        url: link,
        source,
        publishedAt: pub ? new Date(pub).getTime() || 0 : 0,
      })
    }
  }
  return items
}

export async function getAiNews(): Promise<AiNewsItem[]> {
  if (newsCache && Date.now() - newsCache.at < NEWS_TTL_MS) return newsCache.items
  const startedAt = Date.now()
  const results = await Promise.allSettled(
    NEWS_FEEDS.map(async (f) => {
      const res = await fetch(f.url, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return parseRss(await res.text(), f.source)
    }),
  )
  const perSource: string[] = []
  results.forEach((r, i) => {
    const source = NEWS_FEEDS[i].source
    if (r.status === 'fulfilled') perSource.push(`${source} ${r.value.length} 条`)
    else log.warn('ai', '新闻源拉取失败', kv({ 来源: source, 错误: (r.reason as Error)?.message ?? '?' }))
  })
  const lists = results
    .filter((r): r is PromiseFulfilledResult<AiNewsItem[]> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v) => v.length > 0)
  if (lists.length === 0) {
    log.warn('ai', '新闻拉取失败（所有源均不可用）', kv({ 耗时: fmtMs(Date.now() - startedAt) }))
    return newsCache?.items ?? []
  }
  const items = lists.flat().sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 6)
  newsCache = { at: Date.now(), items }
  log.ok('ai', '已拉取币圈新闻', kv({
    条数: items.length,
    来源: perSource.join(' / '),
    耗时: fmtMs(Date.now() - startedAt),
    最新: items[0] ? items[0].title.slice(0, 40) : undefined,
  }))
  return items
}

// ---------------------------------------------------------------------------
// 非流式补全：内部任务用（长期记忆提取），不占用户对话配额、不走流式
// ---------------------------------------------------------------------------

/** 单次问答（stream: false），返回完整文本；失败抛错由调用方吞掉打日志 */
export async function completeAi(profile: AiProfile, system: string, user: string): Promise<string> {
  const res = await fetch(`${profile.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${profile.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: profile.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(60000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw badRequest(`AI 接口返回 HTTP ${res.status}${detail ? `：${detail.slice(0, 120)}` : ''}`)
  }
  const text = ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content
  if (typeof text !== 'string') throw badRequest('AI 接口返回结构异常')
  return text
}
