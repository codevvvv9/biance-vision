import { brand } from '@biance/brand/identity'
import type { Metadata } from 'next'
import './globals.css'
import styles from './site.module.css'
export const metadata: Metadata = { title: `Page not found | ${brand.name}`, robots: { index: false, follow: false } }
export default function NotFound() {
  return <html lang="en"><body className={styles.site}><main className="container page-intro not-found"><span className="eyebrow">{brand.name} / 404</span><h1>This page is outside the map.<br />页面不存在。</h1><p>Try a public website entry below.<br />请从下方入口返回官网。</p><div className="button-row"><a href="/en" className="button button-primary">English home ↗</a><a href="/zh" className="button button-outline">中文官网 ↗</a></div></main></body></html>
}
