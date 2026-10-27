export const locales = ['en', 'zh'] as const
export type Locale = typeof locales[number]
export const isLocale = (value: string): value is Locale => locales.includes(value as Locale)
export const text = (locale: Locale, en: string, zh: string) => locale === 'zh' ? zh : en

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
  const query = new URLSearchParams({ ui: 'dev', returnTo: '/research?ui=dev', lang: locale === 'zh' ? 'zh-CN' : 'en-US' }).toString()
  // Production serves /login from the app behind Caddy path routing. A local website preview has no such routing (404), so dev points straight at the local app container — override with NEXT_PUBLIC_WEBSITE_LOGIN_ORIGIN, or set it to 'relative' to keep the same-origin path.
  const override = process.env.NEXT_PUBLIC_WEBSITE_LOGIN_ORIGIN
  const origin = override !== undefined
    ? override === 'relative' ? '' : override
    : process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:3200' : ''
  return `${origin}/login?${query}`
}

export function pageAlternates(locale: Locale, path = '') {
  return { canonical: `/${locale}${path}`, languages: { en: `/en${path}`, 'zh-CN': `/zh${path}`, 'x-default': `/en${path}` } }
}

export const disclaimer = (locale: Locale) => text(locale, 'For research and education only. Not investment advice.', '仅供研究与教学，不构成投资建议。')
