import { test, expect } from '@playwright/test'
import { pagePaths } from '../../lib/publications'

test('all public routes have one current brand in server HTML and structured metadata', async ({ request }) => {
  for (const locale of ['en', 'zh']) {
    for (const path of pagePaths) {
      const response = await request.get(`/${locale}${path ? `/${path}` : ''}`)
      expect(response.status()).toBe(200)
      const html = await response.text()
      expect(html).toContain('DuckStrat')
      expect(html).not.toMatch(/Biance Vision|BIANCE(?:&nbsp;|\s*)VISION|btcpilot(?:-admin)?\.duckdns\.org/)
    }
  }
})

test('the seven-second story plays once; pause, resume and replay operate on the same scene', async ({ page }) => {
  const errors: string[] = []
  const calls: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) calls.push(request.url()) })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/en')
  const scene = page.locator('[data-playback]')
  await expect(scene).toHaveAttribute('data-playback', 'playing')
  await page.getByRole('button', { name: 'Pause animation', exact: true }).click()
  await expect(scene).toHaveAttribute('data-playback', 'paused')
  const mascot = scene.locator('g[class*=mascot]')
  const stopped = await mascot.getAttribute('style')
  await page.waitForTimeout(250)
  expect(await mascot.getAttribute('style')).toBe(stopped)
  await page.getByRole('button', { name: 'Resume animation', exact: true }).click()
  await expect(scene).toHaveAttribute('data-playback', 'complete', { timeout: 12_000 })
  await expect(scene).toHaveAttribute('data-phase', '2')
  await page.getByRole('button', { name: 'Replay animation', exact: true }).click()
  await expect(scene).toHaveAttribute('data-playback', 'playing')
  await expect(scene).toHaveAttribute('data-phase', '0')
  expect(errors).toEqual([])
  expect(calls).toEqual([])
})

test('risk labels respond to pointer distance, keyboard activation and touch', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/en')
  const scene = page.locator('[data-playback]')
  await expect(scene).toHaveAttribute('data-enhanced', 'true')
  const risk = page.getByRole('button', { name: /Overconfidence/ })
  const box = (await risk.boundingBox())!
  await page.mouse.move(box.x - 15, box.y + box.height / 2)
  await expect(risk).toHaveAttribute('aria-pressed', 'true')
  await expect(scene.getByRole('status')).toHaveText('Challenge your view with counterevidence.')
  await page.getByRole('button', { name: /Missing evidence/ }).focus()
  await page.keyboard.press('Enter')
  await expect(scene.getByRole('status')).toHaveText('Waiting for confirmation is a valid conclusion.')
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const phone = await touch.newPage()
  await phone.goto('/en')
  await phone.getByRole('button', { name: /Market noise/ }).tap()
  await expect(phone.locator('[data-playback]').getByRole('status')).toHaveText('Read the context before reacting.')
  await touch.close()
})

test('failure to download optional animation features keeps the static final scene usable', async ({ page, browser, request }) => {
  const initialHtml = await (await request.get('/en')).text()
  const initialScripts = [...initialHtml.matchAll(/<script[^>]*src="([^"]+)"/g)].map(match => match[1])
  await page.goto('/en')
  await expect(page.locator('[data-playback]')).toHaveAttribute('data-enhanced', 'true')
  const optional = await page.evaluate(initial => performance.getEntriesByType('resource').map(entry => entry.name).filter(url => url.includes('/_next/static/chunks/') && url.endsWith('.js') && !initial.includes(new URL(url).pathname)), initialScripts)
  expect(optional.length).toBeGreaterThan(0)
  const context = await browser.newContext()
  await context.route(url => optional.includes(url.href), route => route.abort())
  const fallback = await context.newPage()
  await fallback.goto('/en')
  await fallback.waitForLoadState('networkidle')
  await expect(fallback.locator('[data-playback]')).toHaveAttribute('data-playback', 'static')
  await expect(fallback.locator('[data-playback]')).toHaveAttribute('data-phase', '2')
  await expect(fallback.getByText('Evidence, before action.')).toBeVisible()
  await expect(fallback.getByRole('link', { name: 'View research demo', exact: true }).first()).toBeVisible()
  await context.close()
})

test('animation suspends outside the viewport and while the document is hidden', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/en')
  const scene = page.locator('[data-playback]')
  await expect(scene).toHaveAttribute('data-playback', 'playing')
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect(scene).toHaveAttribute('data-playback', 'suspended')
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')) })
  await expect(scene).toHaveAttribute('data-playback', 'playing')
  await page.locator('footer').scrollIntoViewIfNeeded()
  await expect(scene).toHaveAttribute('data-playback', 'suspended')
  await scene.scrollIntoViewIfNeeded()
  await expect(scene).toHaveAttribute('data-playback', 'playing')
})

test('reduced motion and no JavaScript expose a complete, readable static story', async ({ page, browser }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/zh')
  const scene = page.locator('[data-playback]')
  await scene.scrollIntoViewIfNeeded()
  await expect(scene).toHaveAttribute('data-playback', 'static')
  await expect(scene).toHaveAttribute('data-phase', '2')
  await expect(page.getByRole('button', { name: '重播动画', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: /证据不足/ }).click()
  await expect(scene.getByRole('status')).toHaveText('等待确认，也是有效结论。')
  const context = await browser.newContext({ javaScriptEnabled: false })
  const staticPage = await context.newPage()
  await staticPage.goto('/en')
  await expect(staticPage.locator('[data-playback]')).toHaveAttribute('data-phase', '2')
  await expect(staticPage.getByText('builds strategy on evidence.')).toBeVisible()
  await expect(staticPage.getByRole('link', { name: 'View research demo', exact: true }).first()).toHaveAttribute('href', '/en/demo')
  await context.close()
})

test('story and conversion links fit desktop, tablet and phone without horizontal overflow', async ({ page }) => {
  for (const locale of ['en', 'zh']) {
    await page.goto(`/${locale}`)
    for (const width of [390, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale}, ${width}`).toBe(true)
      const scene = page.locator('[data-playback]')
      const box = (await scene.boundingBox())!
      for (const label of await scene.locator('[data-risk]').all()) {
        const risk = (await label.boundingBox())!
        expect(risk.x).toBeGreaterThanOrEqual(box.x)
        expect(risk.x + risk.width).toBeLessThanOrEqual(box.x + box.width)
      }
    }
  }
})
