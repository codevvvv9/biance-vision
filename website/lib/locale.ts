import type { Locale } from './site'

/**
 * Accept-language matchers, most specific first: traditional-Chinese regions
 * (Taiwan / Hong Kong / Macau / any zh-Hant*) map to the zh-TW tree before the
 * generic simplified fallback claims every remaining zh tag.
 */
const LOCALE_MATCHERS: readonly (readonly [RegExp, Locale])[] = [
  [/^zh-(?:tw|hk|mo|hant)(?:-[a-z0-9]+)*$/, 'zh-TW'],
  [/^zh(?:-[a-z0-9]+)*$/, 'zh'],
  [/^en(?:-[a-z0-9]+)*$/, 'en'],
]

export function browserLocale(header: string | null): Locale | null {
  const preferences = (header || '').slice(0, 2048).split(',').map((item, order) => {
    const [tag, ...params] = item.trim().toLowerCase().split(';')
    const weight = params.find(p => p.trim().startsWith('q='))
    const q = weight ? Number(weight.trim().slice(2)) : 1
    return { tag, q, order }
  }).filter(p => Number.isFinite(p.q) && p.q > 0 && p.q <= 1).sort((a, b) => b.q - a.q || a.order - b.order)
  for (const { tag } of preferences) {
    for (const [pattern, locale] of LOCALE_MATCHERS) if (pattern.test(tag)) return locale
  }
  return null
}

function ipv4(value: string): number | null {
  const parts = value.split('.')
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null
  return parts.reduce((n, p) => n * 256 + Number(p), 0)
}

export function isMainlandIp(ip: string, list: string): boolean {
  const target = ipv4(ip.startsWith('::ffff:') ? ip.slice(7) : ip)
  if (target === null) return false
  return list.split(/\r?\n/).some(line => {
    const [base, maskText] = line.trim().split('/')
    const subnet = ipv4(base)
    const bits = Number(maskText)
    if (subnet === null || !/^\d{1,2}$/.test(maskText || '') || bits < 0 || bits > 32) return false
    const block = 2 ** (32 - bits)
    return Math.floor(target / block) === Math.floor(subnet / block)
  })
}

/** Reject the whole snapshot on malformed or non-network CIDRs; never partially trust it. */
export function validateCidrs(list: string): string[] {
  const rows = list.trim().split(/\r?\n/)
  if (!list.trim()) throw new Error('Empty mainland IPv4 snapshot')
  for (const [i, row] of rows.entries()) {
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(row)
    const base = match ? ipv4(match[1]) : null
    const bits = match ? Number(match[2]) : -1
    if (base === null || bits < 1 || bits > 32 || base % (2 ** (32 - bits)) !== 0) throw new Error(`Invalid mainland IPv4 CIDR at line ${i + 1}`)
  }
  if (new Set(rows).size !== rows.length) throw new Error('Duplicate mainland IPv4 CIDR')
  return rows
}
