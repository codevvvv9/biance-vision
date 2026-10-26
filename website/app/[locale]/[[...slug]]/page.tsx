import { PublicationPage } from '@/components/PublicationPage'
import { publication } from '@/lib/publications'
import { structuredData } from '@/lib/structured-data'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ContactPage, DemoPage, GuidesPage, HomePage, pageInfo, pagePaths } from '@/lib/pages'
import { isLocale, pageAlternates } from '@/lib/site'

type Params = { locale: string; slug?: string[] }
export const dynamicParams = false
export function generateStaticParams() { return pagePaths.filter(path => path !== 'contact').map(path => ({ slug: path ? path.split('/') : [] })) }

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { locale, slug = [] } = await params
  const path = slug.join('/')
  if (!isLocale(locale) || !pagePaths.includes(path)) notFound()
  const info = pageInfo(locale, path)!
  return { title: path === '' ? { absolute: info.title } : info.title, description: info.description, alternates: pageAlternates(locale, path ? `/${path}` : ''),
    openGraph: { siteName: 'Biance Vision', type: 'website', images: [{ url: '/opengraph-image', width: 1200, height: 630 }], title: info.title, description: info.description, url: `/${locale}${path ? `/${path}` : ''}`, locale: locale === 'zh' ? 'zh_CN' : 'en_US', alternateLocale: locale === 'zh' ? 'en_US' : 'zh_CN' },
  }
}

export default async function Page({ params }: { params: Promise<Params> }) {
  const { locale, slug = [] } = await params
  const path = slug.join('/')
  if (!isLocale(locale) || !pagePaths.includes(path)) notFound()
  const item = publication(path)
  let body
  if (!path) body = <HomePage locale={locale} />
  else if (path === 'demo') body = <DemoPage locale={locale} />
  else if (path === 'guides') body = <GuidesPage locale={locale} />
  else if (path === 'contact') body = <ContactPage locale={locale} />
  else if (item) body = <PublicationPage item={item} locale={locale} />
  else notFound()
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData(locale, path)).replace(/</g, '\\u003c') }} />{body}</>
}
