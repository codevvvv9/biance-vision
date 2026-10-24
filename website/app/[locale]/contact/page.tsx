import { structuredData } from '@/lib/structured-data'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ContactPage, pageInfo } from '@/lib/pages'
import { readPublicContacts } from '@/lib/public-config'
import { isLocale, pageAlternates } from '@/lib/site'
export const dynamic = 'force-dynamic'
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params
  if (!isLocale(locale)) notFound()
  return { ...pageInfo(locale, 'contact'), alternates: pageAlternates(locale, '/contact') }
}
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!isLocale(locale)) notFound()
  return <><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData(locale, 'contact')).replace(/</g, '\\u003c') }} /><ContactPage locale={locale} contacts={await readPublicContacts()} /></>
}
