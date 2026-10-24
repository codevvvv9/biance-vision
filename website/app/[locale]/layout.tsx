import type { ReactNode } from 'react'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { isLocale, locales, publicOrigin } from '@/lib/site'
import { Header } from '@/components/Header'
import { Footer } from '@/components/Footer'
import '@biance/brand/tokens.css'
import '../globals.css'
import styles from '../site.module.css'

export const dynamicParams = false
export function generateStaticParams() { return locales.map(locale => ({ locale })) }
export const metadata: Metadata = {
  metadataBase: new URL(publicOrigin()),
  title: { default: 'Biance Vision', template: '%s | Biance Vision' },
  applicationName: 'Biance Vision',
  verification: { google: process.env.GOOGLE_SITE_VERIFICATION || undefined, other: process.env.BING_SITE_VERIFICATION ? { 'msvalidate.01': process.env.BING_SITE_VERIFICATION } : undefined },
  icons: { icon: '/favicon.ico', apple: '/site-assets/mark.svg' },
  openGraph: { type: 'website', siteName: 'Biance Vision', images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'Biance Vision — Evidence before conviction.' }] },
  twitter: { card: 'summary_large_image', images: ['/opengraph-image'] },
}

export default async function Layout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params
  if (!isLocale(locale)) notFound()
  return <html lang={locale === 'zh' ? 'zh-CN' : 'en'}><body className={styles.site}><a href="#main-content" className="skip-link">{locale === 'zh' ? '跳转到主要内容' : 'Skip to content'}</a><Header locale={locale} /><main id="main-content">{children}</main><Footer locale={locale} /></body></html>
}
