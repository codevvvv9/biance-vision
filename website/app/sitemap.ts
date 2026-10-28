import type { MetadataRoute } from 'next'
import { locales, publicOrigin } from '@/lib/site'
import { pagePaths, publication } from '@/lib/publications'
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin()
  return locales.flatMap(locale => pagePaths.map(path => {
    const suffix = path ? `/${path}` : ''
    return { ...(publication(path) ? { lastModified: publication(path)!.translations[locale].modifiedAt } : {}), url: `${origin}/${locale}${suffix}`, alternates: { languages: { en: `${origin}/en${suffix}`, 'zh-CN': `${origin}/zh${suffix}`, 'zh-TW': `${origin}/zh-TW${suffix}`, 'zh-Hant': `${origin}/zh-TW${suffix}`, 'x-default': `${origin}/en${suffix}` } } }
  }))
}
