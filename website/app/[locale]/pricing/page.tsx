import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { isLocale, pageAlternates } from '@/lib/site'
import { pageInfo } from '@/lib/pages'
import { structuredData } from '@/lib/structured-data'
import { Pricing } from '@/components/Pricing'
import type { PublicMembershipCatalog } from 'biance-vision-brooks/membership'

// 套餐价格进初始 HTML（供搜索与 AI 搜索代理读取）：服务端向用户 API 内网取公开目录；
// WEBSITE_API_ORIGIN 未配置或获取失败时回退为客户端轮询，页面行为与纯客户端版本一致。
export const dynamic = 'force-dynamic'
async function readCatalog(): Promise<PublicMembershipCatalog | undefined> {
  const origin = process.env.WEBSITE_API_ORIGIN
  if (!origin) return
  try {
    const response = await fetch(`${origin}/api/public/membership-plans`, {
      signal: AbortSignal.timeout(2500),
      cache: 'no-store',
    })
    if (!response.ok) return
    const data = (await response.json()) as PublicMembershipCatalog
    if (!data || typeof data !== 'object' || !Array.isArray(data.plans)) return
    return data
  } catch {
    return undefined
  }
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}): Promise<Metadata> {
  const { locale } = await params
  if (!isLocale(locale)) notFound()
  const info = pageInfo(locale, 'pricing')!
  return {
    title: info.title,
    description: info.description,
    alternates: pageAlternates(locale, '/pricing'),
  }
}
export default async function Page({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!isLocale(locale)) notFound()
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData(locale, 'pricing')).replace(
            /</g,
            '\\u003c',
          ),
        }}
      />
      <Pricing locale={locale} initial={await readCatalog()} />
    </>
  )
}
