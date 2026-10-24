import { readFile } from 'node:fs/promises'
import { browserLocale, isMainlandIp, validateCidrs } from '@/lib/locale'

export const dynamic = 'force-dynamic'

async function root(request: Request) {
  let locale = browserLocale(request.headers.get('accept-language'))
  // Proxy trust is opt-in. Production must bind Next to an internal interface and
  // overwrite this header in Caddy; an Internet-supplied forwarding header is not trusted.
  if (!locale && process.env.WEBSITE_TRUST_PROXY === '1' && process.env.WEBSITE_CN_IP_LIST) {
    try {
      const ip = request.headers.get('x-website-client-ip') || ''
      const list = await readFile(process.env.WEBSITE_CN_IP_LIST, 'utf8')
      validateCidrs(list)
      if (isMainlandIp(ip, list)) locale = 'zh'
    } catch { /* Region is only a hint; unavailable data never blocks the website. */ }
  }
  return new Response(null, { status: 302, headers: { Location: `/${locale || 'en'}`, 'Cache-Control': 'private, no-store', Vary: 'Accept-Language' } })
}
export const GET = root
export const HEAD = root
