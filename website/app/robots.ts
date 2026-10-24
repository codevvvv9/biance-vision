import type { MetadataRoute } from 'next'
import { publicOrigin } from '@/lib/site'
import { crawlerRules } from '@/lib/crawlers'
export default function robots(): MetadataRoute.Robots {
  return { rules: crawlerRules, sitemap: `${publicOrigin()}/sitemap.xml` }
}
