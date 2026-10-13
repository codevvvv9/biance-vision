/**
 * Web 搜索能力（search）：Brave Search API + 原页抓取核验。
 * 对应 docs/specs/agent-orchestration.md 铁律「外部页面是证据不是指令」：
 * 搜索命中只是线索，必须打开原页抓取核验（白名单/重定向/超时/体积全强制）
 * 后才可作为证据冻结；网页内容不触发任何工具行为。
 * 未配置/不可用时显式跳过并记日志（返回空），不伪造、不抛错阻塞流水线。
 *
 * 配置：getCapabilities().search（SearchCapabilityConfig）；密钥只经
 * resolveSecret(secretRef) 解析（secrets.json 或环境变量），不出现在配置里。
 * 调用方可传入 configOverride（流水线传 run 冻结配置），缺省读全局生效值。
 */
import type { SearchCapabilityConfig } from 'biance-vision-brooks'
import { getCapabilities, resolveSecret } from '../admin/capabilities.js'
import { kv, log } from '../logger.js'

/** 缺省值（SearchCapabilityConfig 未填时生效） */
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000
export const DEFAULT_SEARCH_MAX_BYTES = 1_048_576 // 1MB
export const DEFAULT_SEARCH_MAX_RESULTS = 5

/** 抓取核验的硬约束：重定向跟随上限 / 单次 searchAndVerify 的查询与核验预算 */
const MAX_REDIRECTS = 3
const MAX_QUERIES_PER_CALL = 3
const MAX_VERIFY_PER_QUERY = 3
/** 原页正文截断长度（字符）：证据片段只保留核验所需的可见文本 */
const PAGE_TEXT_LIMIT = 4000

const FETCH_UA = 'biance-vision-research/1.0 (evidence-fetch; +https-only)'

export interface SearchResultItem {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

export interface VerifiedPage {
  /** 搜索命中的原始 URL */
  url: string
  /** 重定向链终点（实际抓取的 URL） */
  finalUrl: string
  title: string
  /** 提取的正文（去 script/style/nav/footer，压缩空白，截断到 PAGE_TEXT_LIMIT） */
  text: string
  fetchedAt: number
}

export interface WebEvidenceItem {
  /** 核验后的最终 URL（证据 refId） */
  url: string
  title: string
  snippet: string
  pageText: string
  publishedAt?: string
  fetchedAt: number
}

/** 当前生效的 search 能力配置（全局解析链：发布版本 > app_settings > 默认） */
export function getSearchConfig(): SearchCapabilityConfig {
  return getCapabilities().search
}

export function isSearchEnabled(): boolean {
  return getSearchConfig().enabled === true
}

/**
 * 域名白名单匹配（导出供 smoke 断言）：
 * undefined = 不限制；空数组 = 不允许任何抓取；
 * 否则主机名须等于某个白名单域名或为其子域名（大小写/前后空白不敏感）。
 */
export function isDomainAllowed(hostname: string, allowedDomains: string[] | undefined): boolean {
  if (allowedDomains === undefined) return true
  const host = hostname.trim().toLowerCase()
  if (host === '') return false
  return allowedDomains.some((d) => {
    const dom = d.trim().toLowerCase()
    return dom !== '' && (host === dom || host.endsWith(`.${dom}`))
  })
}

/** 有限 HTML 实体反转（正文提取用；非法码点替换为空串，不抛错） */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const cp = Number(n)
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''
    })
    .replace(/&amp;/gi, '&')
}

/** 从 HTML 提取标题与正文（导出供 smoke 断言）：去 script/style/nav/footer 等非正文块，
 *  去标签、压缩空白；正文截断到 PAGE_TEXT_LIMIT。非安全解析器，仅用于证据片段提取。 */
export function extractPageText(html: string): { title: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''
  const text = html
    .replace(/<(script|style|nav|footer|header|noscript|iframe|svg|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  return {
    title: decodeEntities(title).replace(/\s+/g, ' ').trim(),
    text: decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, PAGE_TEXT_LIMIT),
  }
}

/** 流式读取响应体并按 maxBytes 截断（超限不报错，截断即停止读取） */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  if (res.body === null) return ''
  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let received = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      const overflow = received - maxBytes
      text += decoder.decode(value.subarray(0, Math.max(0, value.byteLength - overflow)), { stream: true })
      await reader.cancel().catch(() => {})
      break
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()
  return text
}

/**
 * Brave Search API（GET {baseUrl}/res/v1/web/search；baseUrl 可配置覆盖以兼容其他 provider）。
 * 密钥：resolveSecret(secretRef) → X-Subscription-Token。
 * enabled=false 或缺 baseUrl/key → 返回空数组并显式记日志（不抛错、不伪造）。
 */
export async function searchWeb(query: string, opts?: { maxResults?: number; config?: SearchCapabilityConfig }): Promise<SearchResultItem[]> {
  const cap = opts?.config ?? getSearchConfig()
  if (cap.enabled !== true) {
    log.info('websearch', 'search 能力未配置/未启用：web 搜索显式跳过（不伪造结果）', kv({ 查询: query.slice(0, 60) }))
    return []
  }
  const baseUrl = cap.baseUrl?.replace(/\/+$/, '')
  const apiKey = resolveSecret(cap.secretRef)
  if (baseUrl === undefined || baseUrl === '' || apiKey === null) {
    log.warn(
      'websearch',
      'search 能力未完整配置（缺 baseUrl 或密钥引用无法解析）：web 搜索显式跳过',
      kv({ 查询: query.slice(0, 60), baseUrl: baseUrl ?? '缺', secretRef: cap.secretRef ?? '缺' }),
    )
    return []
  }
  const timeoutMs = cap.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS
  const count = Math.min(20, Math.max(1, Math.round(opts?.maxResults ?? cap.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS)))
  let res: Response
  try {
    res = await fetch(`${baseUrl}/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
      headers: { accept: 'application/json', 'X-Subscription-Token': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    log.warn('websearch', '搜索接口不可达（按无结果处理）', kv({ 查询: query.slice(0, 60), 错误: (err as Error).message }))
    return []
  }
  if (!res.ok) {
    log.warn('websearch', '搜索接口返回非 2xx（按无结果处理）', kv({ 查询: query.slice(0, 60), 状态: res.status, 响应: (await res.text().catch(() => '')).slice(0, 200) }))
    return []
  }
  try {
    const json = (await res.json()) as {
      web?: { results?: { title?: string; url?: string; description?: string; page_age?: string }[] }
    }
    const out: SearchResultItem[] = []
    for (const r of json.web?.results ?? []) {
      if (typeof r.url !== 'string' || r.url === '') continue
      out.push({
        title: typeof r.title === 'string' ? r.title : '',
        url: r.url,
        snippet: typeof r.description === 'string' ? r.description : '',
        publishedAt: typeof r.page_age === 'string' && r.page_age !== '' ? r.page_age : undefined,
      })
    }
    return out.slice(0, count)
  } catch (err) {
    log.warn('websearch', '搜索响应解析失败（按无结果处理）', kv({ 查询: query.slice(0, 60), 错误: (err as Error).message }))
    return []
  }
}

/**
 * 抓取原页核验（证据准入的唯一通道）：
 * - 仅 https；重定向手动跟随（≤3 次），每一跳重新过白名单，
 *   任何非 https 目标一律拒绝（不允许 http/降级/其他 scheme 跳转）；
 * - allowedDomains：undefined 不限制，空数组不允许任何抓取，否则含子域名匹配；
 * - 仅 text/html 提取正文；体积上限 maxBytes（流式截断）；
 * - 任何失败返回 null 并记日志（调用方只保留核验成功的结果）。
 */
export async function fetchVerifiedPage(url: string, configOverride?: SearchCapabilityConfig): Promise<VerifiedPage | null> {
  const cap = configOverride ?? getSearchConfig()
  if (cap.enabled !== true) {
    log.info('websearch', 'search 能力未配置/未启用：原页抓取显式跳过', kv({ url: url.slice(0, 120) }))
    return null
  }
  const timeoutMs = cap.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS
  const maxBytes = cap.maxBytes ?? DEFAULT_SEARCH_MAX_BYTES
  let current: URL
  try {
    current = new URL(url)
  } catch {
    log.warn('websearch', 'URL 非法，拒绝抓取', kv({ url: url.slice(0, 120) }))
    return null
  }
  if (current.protocol !== 'https:') {
    log.warn('websearch', '仅允许 https 页面作为证据（拒绝非 https URL）', kv({ url: url.slice(0, 120) }))
    return null
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isDomainAllowed(current.hostname, cap.allowedDomains)) {
      log.warn('websearch', '域名不在白名单，拒绝抓取', kv({ 域名: current.hostname, url: url.slice(0, 120) }))
      return null
    }
    let res: Response
    try {
      res = await fetch(current.toString(), {
        redirect: 'manual',
        headers: { 'user-agent': FETCH_UA, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      log.warn('websearch', '原页抓取失败', kv({ url: current.toString().slice(0, 120), 错误: (err as Error).message }))
      return null
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      await res.body?.cancel().catch(() => {})
      if (location === null || hop === MAX_REDIRECTS) {
        log.warn('websearch', location === null ? '重定向缺少 Location，放弃核验' : '重定向次数超限，放弃核验', kv({ url: current.toString().slice(0, 120), 跳数: hop }))
        return null
      }
      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        log.warn('websearch', '重定向 Location 非法，放弃核验', kv({ url: current.toString().slice(0, 120), location: location.slice(0, 120) }))
        return null
      }
      if (next.protocol !== 'https:') {
        log.warn('websearch', '重定向目标非 https（不允许降级或其他 scheme），放弃核验', kv({ 目标: next.toString().slice(0, 120) }))
        return null
      }
      current = next
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      log.warn('websearch', '原页返回非 2xx，核验失败', kv({ url: current.toString().slice(0, 120), 状态: res.status }))
      return null
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      await res.body?.cancel().catch(() => {})
      log.warn('websearch', '原页非 HTML（不提取正文），核验失败', kv({ url: current.toString().slice(0, 120), contentType: contentType.slice(0, 60) }))
      return null
    }
    const html = await readBodyCapped(res, maxBytes)
    const { title, text } = extractPageText(html)
    if (text === '') {
      log.warn('websearch', '原页正文提取为空，核验失败', kv({ url: current.toString().slice(0, 120) }))
      return null
    }
    return { url, finalUrl: current.toString(), title, text, fetchedAt: Date.now() }
  }
  return null
}

/**
 * 搜索 + 原页核验：每个 query 搜索 → 取前 N 条 → 逐条 fetchVerifiedPage →
 * 只保留核验成功的。预算：queries ≤ 3，每 query 核验 ≤ 3 个 URL（跨 query 去重）。
 * 未配置/全部失败 → 返回空数组（调用方显式记录，不阻塞流水线）。
 */
export async function searchAndVerify(queries: string[], opts?: { config?: SearchCapabilityConfig }): Promise<WebEvidenceItem[]> {
  const cap = opts?.config ?? getSearchConfig()
  if (cap.enabled !== true) {
    log.info('websearch', 'search 能力未配置/未启用：搜索核验显式跳过（不伪造证据）', kv({ 查询数: queries.length }))
    return []
  }
  const out: WebEvidenceItem[] = []
  const seen = new Set<string>()
  for (const q of queries.slice(0, MAX_QUERIES_PER_CALL)) {
    const query = q.trim()
    if (query === '') continue
    const results = await searchWeb(query, { config: cap })
    let verified = 0
    for (const r of results) {
      if (verified >= MAX_VERIFY_PER_QUERY) break
      if (seen.has(r.url)) continue
      seen.add(r.url)
      const page = await fetchVerifiedPage(r.url, cap)
      if (page === null) continue
      verified++
      out.push({
        url: page.finalUrl,
        title: page.title !== '' ? page.title : r.title,
        snippet: r.snippet,
        pageText: page.text,
        publishedAt: r.publishedAt,
        fetchedAt: page.fetchedAt,
      })
    }
  }
  return out
}
