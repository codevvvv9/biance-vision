import { test, expect } from '@playwright/test'

test('public HTML, language entry, indexing metadata and genuine 404s', async ({ request }) => {
  for (const [lang, target] of [['zh-CN,en;q=.8', '/zh'], ['zh-TW,zh;q=0.9,en;q=0.8', '/zh-TW'], ['zh-HK,en;q=.8', '/zh-TW'], ['zh-Hant;q=.9,en;q=.8', '/zh-TW'], ['fr,en;q=.8', '/en'], ['', '/en']]) {
    const response = await request.get('/', { headers: { 'accept-language': lang }, maxRedirects: 0 })
    expect(response.status()).toBe(302)
    expect(response.headers().location).toBe(target)
    expect(response.headers()['cache-control']).toContain('no-store')
  }
  for (const path of ['/unknown', '/fr', '/zh/guides/unknown', '/research/anything', '/assets/missing.js', '/_next/static/missing.js']) {
    expect((await request.get(path)).status(), path).toBe(404)
  }
  const page = await request.get('/zh/guides/getting-started')
  const html = await page.text()
  expect(html).toContain('lang="zh-CN"')
  expect(html).toContain('第一次研究')
  expect(html).toContain('application/ld+json')
  expect(html).toMatch(/hreflang="en"/i)
  expect(page.headers()['content-security-policy']).toContain("object-src 'none'")
  expect(page.headers()['set-cookie']).toBeUndefined()
  expect((await request.get('/robots.txt')).status()).toBe(200)
  expect(await (await request.get('/robots.txt')).text()).toContain('GPTBot')
  const sitemap = await (await request.get('/sitemap.xml')).text()
  expect(sitemap).toContain('/en/guides/getting-started')
  expect(sitemap).toContain('/zh-TW/guides/getting-started')
  expect(sitemap).not.toContain('/login')
})

test('responsive home remains readable and navigation preserves the same page', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/en')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Navigate risk')
  await expect(page.getByRole('link', { name: 'View research demo', exact: true }).first()).toHaveAttribute('href', '/en/demo')
  for (const width of [390, 768, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `overflow at ${width}`).toBe(true)
  }
  await page.goto('/en/guides/getting-started')
  await page.locator('.lang-menu summary').click()
  await page.getByRole('link', { name: '简体中文', exact: true }).click()
  await expect(page).toHaveURL(/\/zh\/guides\/getting-started$/)
  // the traditional entry survives the same path swap
  await page.locator('.lang-menu summary').click()
  await page.getByRole('link', { name: '繁體中文', exact: true }).click()
  await expect(page).toHaveURL(/\/zh-TW\/guides\/getting-started$/)
  expect(errors).toEqual([])
})

test('teaching case selection, evidence highlighting and mobile views work', async ({ page }) => {
  await page.goto('/en/demo')
  await page.getByRole('tab', { name: /Range breakout/ }).click()
  await expect(page.getByRole('heading', { name: 'Separate the breakout attempt from its confirmation.' })).toBeVisible()
  const evidence = page.getByRole('button', { name: /A retest can reveal/ })
  await evidence.click()
  await expect(evidence).toHaveAttribute('aria-pressed', 'true')
  await page.locator('#case-panel summary').click()
  await expect(page.locator('#case-panel').getByText('A return into the range weakens the breakout interpretation.')).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Evidence', exact: true }).click()
  await expect(evidence).toBeVisible()
})

test('contact is real, application status is not fabricated, copy failure has manual recovery', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/en/contact')
  await expect(page.getByRole('link', { name: 'Write an email' })).toHaveAttribute('href', /^mailto:codevvvv9@gmail\.com/)
  await expect(page.getByText('Telegram, soon.')).toBeVisible()
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('blocked')) } }))
  await page.getByRole('button', { name: 'Copy inquiry template' }).click()
  await expect(page.getByRole('textbox', { name: 'Text to copy manually' })).toBeVisible()
  await expect(page.getByText('Copy is unavailable. Select and copy the text below.')).toBeVisible()
})

test('question stays out of URLs, existing entry draft requires a choice, and nothing calls research', async ({ page }) => {
  const calls: string[] = []
  page.on('request', r => { if (r.url().includes('/api/')) calls.push(r.url()) })
  await page.goto('/en/demo')
  await page.evaluate(() => sessionStorage.setItem('bv.research-entry.v1', JSON.stringify({ version: 1, question: 'Earlier question', scene: 'perp', symbol: 'BTCUSDT', horizon: '1h', locale: 'en-US', createdAt: Date.now() })))
  await page.getByRole('textbox', { name: 'Research question' }).fill('Private question not for a URL')
  await page.getByRole('button', { name: 'Have an account? Continue', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Replace with this question' })).toBeVisible()
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('bv.research-entry.v1')!).question)).toBe('Earlier question')
  expect(page.url()).not.toContain('Private')
  expect(calls).toEqual([])
})

test('core information and navigation are available without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto('/en/demo')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.locator('.case-transcripts > summary').click()
  await page.getByRole('link', { name: 'Trend pullback ↗', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Trend pullback')
  await expect(page.getByRole('heading', { name: 'Supporting evidence and the opposing case' })).toBeVisible()
  await expect(page.locator('a[href="/en/contact"]').last()).toBeVisible()
  await context.close()
})
