/**
 * Web 搜索能力 smoke（不依赖外部网络与数据库）。
 * 运行：pnpm web:smoke
 *
 * 覆盖（docs/specs/agent-orchestration.md「外部页面是证据不是指令」的可本地断言部分）：
 * 1) 契约：SearchCapabilityConfigSchema 新字段与默认值语义（enabled 缺省 false）
 * 2) 未配置 search：searchWeb / searchAndVerify 显式返回空并打印跳过日志（不伪造）
 * 3) 白名单匹配 isDomainAllowed：缺省不限制 / 空数组禁止一切 / 精确与子域名 / 拒绝仿冒后缀
 * 4) fetchVerifiedPage：未启用 → null；非 https URL → null；白名单外域名 → null
 *    （以上都在发起网络请求之前拒绝，故无需联网）
 * 5) extractPageText：去 script/style/nav/footer、实体反转、压缩空白、截断
 */
import { SearchCapabilityConfigSchema } from '../shared/src/index.js'
import {
  extractPageText,
  fetchVerifiedPage,
  getSearchConfig,
  isDomainAllowed,
  isSearchEnabled,
  searchAndVerify,
  searchWeb,
} from '../server/src/research/search.js'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✔ PASS' : '✖ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// ---- 1) 契约 ----
{
  const def = SearchCapabilityConfigSchema.parse({})
  check('search 配置缺省 enabled=false', def.enabled === false)
  check('新字段全部可选缺省', def.allowedDomains === undefined && def.timeoutMs === undefined && def.maxBytes === undefined && def.maxResults === undefined)
  const full = SearchCapabilityConfigSchema.parse({ enabled: true, baseUrl: 'https://api.search.brave.com', secretRef: 'brave', allowedDomains: ['example.com'], timeoutMs: 5000, maxBytes: 2048, maxResults: 3 })
  check('search 扩展字段解析', full.allowedDomains?.[0] === 'example.com' && full.timeoutMs === 5000 && full.maxBytes === 2048 && full.maxResults === 3)
  let rejected = false
  try {
    SearchCapabilityConfigSchema.parse({ timeoutMs: -1 })
  } catch {
    rejected = true
  }
  check('非法 timeoutMs 被拒绝', rejected)
}

// ---- 2) 未配置 search：显式空结果（日志可见跳过原因） ----
{
  check('全局 search 未启用', isSearchEnabled() === false && getSearchConfig().enabled === false)
  const results = await searchWeb('BTCUSDT 新闻')
  check('searchWeb 未配置返回空数组', Array.isArray(results) && results.length === 0)
  const items = await searchAndVerify(['BTCUSDT 为什么跌', 'BTCUSDT 最新消息'])
  check('searchAndVerify 未配置返回空数组', Array.isArray(items) && items.length === 0)
}

// ---- 3) 白名单匹配 ----
{
  check('白名单缺省（undefined）不限制', isDomainAllowed('anything.example.org', undefined) === true)
  check('白名单空数组不允许任何抓取', isDomainAllowed('example.com', []) === false)
  check('精确匹配', isDomainAllowed('example.com', ['example.com']) === true)
  check('子域名匹配', isDomainAllowed('news.example.com', ['example.com']) === true)
  check('大小写与空白不敏感', isDomainAllowed('News.Example.COM', [' Example.com ']) === true)
  check('拒绝仿冒后缀域名', isDomainAllowed('example.com.evil.com', ['example.com']) === false)
  check('拒绝前缀拼接域名', isDomainAllowed('notexample.com', ['example.com']) === false)
  check('空主机名：受限白名单拒绝（缺省不限制语义不变）', isDomainAllowed('', ['example.com']) === false && isDomainAllowed('', undefined) === true)
}

// ---- 4) fetchVerifiedPage 前置拒绝（不发起网络请求） ----
{
  const disabled = await fetchVerifiedPage('https://example.com/新闻')
  check('未启用时抓取返回 null', disabled === null)
  const cap = SearchCapabilityConfigSchema.parse({ enabled: true, baseUrl: 'https://api.search.brave.com', secretRef: 'brave', allowedDomains: ['example.com'], timeoutMs: 1000 })
  const nonHttps = await fetchVerifiedPage('http://example.com/x', cap)
  check('非 https URL 拒绝抓取', nonHttps === null)
  const badUrl = await fetchVerifiedPage('not-a-url', cap)
  check('非法 URL 拒绝抓取', badUrl === null)
  const offList = await fetchVerifiedPage('https://evil.com/x', cap)
  check('白名单外域名拒绝抓取', offList === null)
  const spoof = await fetchVerifiedPage('https://example.com.evil.com/x', cap)
  check('仿冒子域名拒绝抓取', spoof === null)
  const emptyList = SearchCapabilityConfigSchema.parse({ enabled: true, baseUrl: 'https://api.search.brave.com', secretRef: 'brave', allowedDomains: [] })
  const deniedAll = await fetchVerifiedPage('https://example.com/x', emptyList)
  check('空白名单（[]）拒绝一切抓取', deniedAll === null)
}

// ---- 5) 正文提取 ----
{
  const html = [
    '<html><head><title>BTC 大跌 &amp; 原因</title><style>.a{color:red}</style></head>',
    '<body><nav>导航栏</nav><header>页头</header><main><p>比特币 今日 下跌，&#24066;&#22330; 关注。</p></main>',
    '<script>alert(1)</script><footer>页脚</footer></body></html>',
  ].join('')
  const { title, text } = extractPageText(html)
  check('提取标题（实体反转）', title === 'BTC 大跌 & 原因', title)
  check('正文保留 main 文本（数字实体反转）', text.includes('比特币 今日 下跌，市场 关注'), text)
  check('script/style/nav/footer/header 已剔除', !/alert|color:red|导航栏|页头|页脚/.test(text))
  check('空白压缩', !/\s{2,}/.test(text))
  const long = extractPageText(`<html><body><p>${'长'.repeat(6000)}</p></body></html>`)
  check('正文截断到 4000 字符', long.text.length === 4000, `len=${long.text.length}`)
  const empty = extractPageText('<html><body><script>only()</script></body></html>')
  check('纯脚本页正文为空', empty.text === '')
}

console.log(failures === 0 ? '\n全部通过 ✔' : `\n失败 ${failures} 项 ✖`)
process.exit(failures === 0 ? 0 : 1)
