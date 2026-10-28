import { brand } from '@biance/brand/identity'
import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { isLocale, localeMeta, locales, publicOrigin, text } from '@/lib/site'
import { Header } from '@/components/Header'
import { Footer } from '@/components/Footer'
import '@biance/brand/tokens.css'
import '../globals.css'
import styles from '../site.module.css'

export const dynamicParams = false
export function generateStaticParams() { return locales.map(locale => ({ locale })) }
export const metadata: Metadata = {
  metadataBase: new URL(publicOrigin()),
  title: { default: brand.name, template: `%s | ${brand.name}` },
  applicationName: brand.name,
  verification: { google: process.env.GOOGLE_SITE_VERIFICATION || undefined, other: process.env.BING_SITE_VERIFICATION ? { 'msvalidate.01': process.env.BING_SITE_VERIFICATION } : undefined },
  icons: { icon: '/site-assets/mark.svg', apple: '/site-assets/mark.svg' },
  openGraph: { type: 'website', siteName: brand.name, images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: `${brand.name} — ${brand.promise.en}` }] },
  twitter: { card: 'summary_large_image', images: ['/opengraph-image'] },
}

export default async function Layout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!isLocale(locale)) notFound()
  return <html lang={localeMeta[locale].htmlLang}><body className={styles.site}><a href="#main-content" className="skip-link">{text(locale, 'Skip to content', '跳转到主要内容', '跳轉到主要內容')}</a><Header locale={locale} /><main id="main-content">{children}</main><Footer locale={locale} /></body></html>
}
