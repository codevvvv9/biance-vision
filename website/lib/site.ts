export const locales = ['en', 'zh', 'zh-TW'] as const
export type Locale = typeof locales[number]
export const isLocale = (value: string): value is Locale => locales.includes(value as Locale)
/** Chinese-script locales (simplified or traditional) share the zh copy branch. */
export const isZh = (locale: Locale) => locale !== 'en'

/**
 * Locale registry — the single source of truth for every per-locale mapping.
 * Consumers read from here instead of scattering `locale === 'zh'` ternaries:
 * htmlLang → <html lang>, ogLocale → OpenGraph locale, terminalLang → the login
 * link's lang param (the terminal only ships zh-CN / en-US today).
 */
export const localeMeta: Record<Locale, { htmlLang: string; ogLocale: string; terminalLang: 'zh-CN' | 'zh-TW' | 'en-US' }> = {
  en: { htmlLang: 'en', ogLocale: 'en_US', terminalLang: 'en-US' },
  zh: { htmlLang: 'zh-CN', ogLocale: 'zh_CN', terminalLang: 'zh-CN' },
  'zh-TW': { htmlLang: 'zh-TW', ogLocale: 'zh_TW', terminalLang: 'zh-TW' },
}

/** en / zh (simplified) / zh-TW (traditional, Taiwan-style); tw falls back to simplified when omitted. */
export const text = (locale: Locale, en: string, zh: string, tw?: string) => locale === 'zh-TW' ? (tw ?? zh) : locale === 'zh' ? zh : en

export function publicOrigin(): string {
  const value = process.env.WEBSITE_ORIGIN || 'http://localhost:3100'
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('WEBSITE_ORIGIN must be an HTTP(S) origin without a path, credentials, query or fragment')
  }
  return parsed.origin
}

export function contactConfig() {
  const telegram = (process.env.WEBSITE_TELEGRAM || '').trim().replace(/^@/, '')
  const email = (process.env.WEBSITE_CONTACT_EMAIL ?? 'codevvvv9@gmail.com').trim()
  if (telegram && !/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(telegram)) throw new Error('Invalid WEBSITE_TELEGRAM username')
  if (email && !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(email)) throw new Error('Invalid WEBSITE_CONTACT_EMAIL')
  return { telegram, email }
}

export function loginUrl(locale: Locale): string {
  const query = new URLSearchParams({ ui: 'dev', returnTo: '/research?ui=dev', lang: localeMeta[locale].terminalLang }).toString()
  // Production serves /login from the app behind Caddy path routing. A local website preview has no such routing (404), so dev points straight at the local app container — override with NEXT_PUBLIC_WEBSITE_LOGIN_ORIGIN, or set it to 'relative' to keep the same-origin path.
  const override = process.env.NEXT_PUBLIC_WEBSITE_LOGIN_ORIGIN
  const origin = override !== undefined
    ? override === 'relative' ? '' : override
    : process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:3200' : ''
  return `${origin}/login?${query}`
}

export function pageAlternates(locale: Locale, path = '') {
  return {
    canonical: `/${locale}${path}`,
    // zh-Hant (script-level) and zh-TW (regional) both resolve to the traditional tree.
    languages: { en: `/en${path}`, 'zh-CN': `/zh${path}`, 'zh-TW': `/zh-TW${path}`, 'zh-Hant': `/zh-TW${path}`, 'x-default': `/en${path}` },
  }
}

export const disclaimer = (locale: Locale) => text(locale, 'For research and education only. Not investment advice.', '仅供研究与教学，不构成投资建议。', '僅供研究與教學，不構成投資建議。')
