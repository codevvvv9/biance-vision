import { test, expect } from '@playwright/test'
import { pagePaths, published } from '../../lib/publications'

const origin = process.env.WEBSITE_ORIGIN || 'http://localhost:3100'
test('every bilingual publication is server HTML with matching metadata, source links, TOC and conversion exits', async ({ page, request }) => {
  for (const locale of ['en', 'zh', 'zh-TW'] as const) {
    for (const item of published) {
      const t = item.translations[locale]
      const response = await request.get(t.url)
      expect(response.status(), t.url).toBe(200)
      const html = await response.text()
      expect(html).toContain(t.title)
      expect(html).toContain(`id="${t.toc[0].id}"`)
      expect(html).toContain('id="sources"')
      expect(html).toContain(t.modifiedAt)
      expect(html).not.toContain('name="robots" content="noindex"')
    }
  }
  await page.goto('/en/guides/second-entry-h2')
  const graph = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent()!)['@graph']
  const article = graph.find((g: Record<string, unknown>) => g['@type'] === 'Article')
  expect(article.author['@id']).toBe(`${origin}/#organization`)
  expect(article.dateModified).toBe('2026-10-24')
  expect(article.citation).toContain('https://www.brookstradingcourse.com/price-action-trading-terms-glossary/')
  expect(article.workTranslation['@id']).toBe(`${origin}/zh/guides/second-entry-h2#page`)
  const crumbs = graph.find((g: Record<string, unknown>) => g['@type'] === 'BreadcrumbList')
  expect(crumbs.itemListElement.map((c: {position: number}) => c.position)).toEqual([1,2,3])
  await page.locator('.article-toc a').nth(2).click()
  expect(page.url()).toContain('#section-3')
  await expect(page.locator('#section-3')).toBeInViewport()
  await expect(page.locator('.article-body a[href="/en/contact"]')).toHaveCount(1)
  await expect(page.locator('.article-body a[href^="/login?"]')).toHaveCount(1)
  await page.locator('.lang-menu summary').click()
  await page.getByRole('link', { name: '简体中文', exact: true }).click()
  await expect(page).toHaveURL(/\/zh\/guides\/second-entry-h2$/)
  await expect(page.locator('html')).toHaveAttribute('lang','zh-CN')
  // the traditional tree serves the same publication with zh-TW metadata
  const twResponse = await request.get('/zh-TW/guides/second-entry-h2')
  expect(twResponse.status()).toBe(200)
  expect(await twResponse.text()).toContain('與')
})
test('sitemap lists exactly the published locale pages with stable translations and dates', async ({ request }) => {
  const xml = await (await request.get('/sitemap.xml')).text()
  const locations = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m=>new URL(m[1]).pathname).sort()
  expect(locations).toEqual(['en','zh','zh-TW'].flatMap(locale => pagePaths.map(p=>`/${locale}${p?`/${p}`:''}`)).sort())
  expect(xml).toContain('hreflang="x-default"')
  expect(locations.some(p=>/^\/(?:login|research|admin)(?:\/|$)/.test(p))).toBe(false)
})
test('effective crawler groups allow public content, preserve protected disallows and deny GPTBot', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text()
  const groups = robots.trim().split(/\n\s*\n/)
  for (const agent of ['*','Googlebot','Bingbot','OAI-SearchBot','PerplexityBot']) {
    const group = groups.find(g=>g.split('\n').includes(`User-Agent: ${agent}`))!
    expect(group,agent).toBeTruthy()
    expect(group).toContain('Allow: /')
    for (const path of ['/api','/admin','/login','/research','/dashboard']) expect(group).toContain(`Disallow: ${path}`)
  }
  expect(groups.find(g=>g.includes('User-Agent: GPTBot'))).toContain('Disallow: /')
  const user = await (await request.get('/en/demo/range-breakout')).text()
  const bot = await (await request.get('/en/demo/range-breakout',{headers:{'user-agent':'OAI-SearchBot'}})).text()
  expect(bot).toBe(user)
})
test('root language selection is GET/HEAD equivalent, ignores supplied region headers unless opted in, and never redirects explicit locale pages', async ({ request }) => {
  for (const method of ['get','head'] as const) {
    const response = await request[method]('/?returnTo=https://evil.test&question=PRIVATE',{headers:{'accept-language':'fr','x-website-client-ip':'1.0.1.1','cookie':'bv_session=anything'},maxRedirects:0})
    expect(response.status()).toBe(302)
    // Preview process has no trusted proxy opt-in, so a caller cannot select via a spoofed header.
    expect(response.headers().location).toBe('/en')
    expect(response.headers()['set-cookie']).toBeUndefined()
    expect(response.headers()['cache-control']).toContain('no-store')
  }
  for (const locale of ['en','zh','zh-TW']) {
    const response = await request.get(`/${locale}/about`,{headers:{'accept-language':locale==='en'?'zh':'en','x-website-client-ip':'1.0.1.1'},maxRedirects:0})
    expect(response.status()).toBe(200); expect(response.headers().location).toBeUndefined()
  }
})
test('standalone cases and original diagrams are usable without JS at desktop and mobile sizes', async ({ browser }) => {
  const context = await browser.newContext({javaScriptEnabled:false})
  const page = await context.newPage()
  try {
    for (const width of [390,768,1440]) {
      await page.setViewportSize({width,height:1000})
      await page.goto('/en/demo/wait-for-confirmation')
      await expect(page.getByRole('heading',{level:1})).toContainText('Waiting for confirmation')
      await expect(page.locator('figure svg')).toBeVisible()
      await expect(page.locator('.article-next a.button-primary')).toHaveAttribute('href','/en/demo')
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow ${width}`).toBe(true)
      await page.locator('.article-toc a[href="#sources"]').click()
      await expect(page.locator('#sources')).toBeInViewport()
    }
    await page.setViewportSize({width:390,height:1000})
    await page.goto('/zh/about')
    await expect(page.getByText(/与 Binance 无隶属/)).toBeVisible()
    await page.goto('/zh-TW/about')
    await expect(page.getByText(/與 Binance 無隸屬/)).toBeVisible()
    await page.screenshot({path:'../docs/references/website-qa/geo-about-mobile.png',fullPage:true})
    await page.setViewportSize({width:1440,height:1000})
    await page.goto('/en/guides/second-entry-h2')
    await page.screenshot({path:'../docs/references/website-qa/geo-h2-desktop.png',fullPage:true})
  } finally { await context.close() }
})
