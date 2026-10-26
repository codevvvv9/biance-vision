import { brand } from '@biance/brand/identity'
import { pageInfo } from './pages'
import { publication, sourceUrl } from './publications'
import { publicOrigin, text, type Locale } from './site'

export function structuredData(locale: Locale, path: string) {
  const origin = publicOrigin(), home = `${origin}/${locale}`
  const url = `${home}${path ? `/${path}` : ''}`
  const info = pageInfo(locale, path)!
  const organization = { '@type': 'Organization', '@id': `${origin}/#organization`, name: brand.name, url: `${origin}/en/about`, description: 'Independent crypto market research project. Not affiliated with Binance.', logo: `${origin}/site-assets/mark.svg` }
  const website = { '@type': 'WebSite', '@id': `${origin}/#website`, name: brand.name, url: `${origin}/en`, inLanguage: ['en', 'zh-CN'], publisher: { '@id': organization['@id'] } }
  const item = publication(path), t = item?.translations[locale]
  const page = {
    '@type': item?.kind === 'page' ? (path === 'about' ? 'AboutPage' : 'WebPage') : item ? 'Article' : 'WebPage',
    '@id': `${url}#page`, url, name: info.title, headline: info.title, description: info.description,
    inLanguage: locale === 'zh' ? 'zh-CN' : 'en', isPartOf: { '@id': website['@id'] },
    ...(t ? { dateModified: t.modifiedAt, author: { '@id': organization['@id'] }, publisher: { '@id': organization['@id'] }, citation: t.sources.map(id => new URL(sourceUrl(id, locale), origin).href), ...(locale === 'zh' ? { translationOfWork: { '@id': `${origin}${t.translation}#page` } } : { workTranslation: { '@id': `${origin}${t.translation}#page` } }) } : {}),
  }
  const crumbs: { name: string; item: string }[] = [{ name: brand.name, item: home }]
  if (path.includes('/')) crumbs.push({ name: path.startsWith('guides/') ? text(locale, 'Field notes', '使用指南') : text(locale, 'Research demo', '研究演示'), item: `${home}/${path.split('/')[0]}` })
  if (path) crumbs.push({ name: info.title, item: url })
  return { '@context': 'https://schema.org', '@graph': [organization, website, page, { '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, ...c })) }] }
}
