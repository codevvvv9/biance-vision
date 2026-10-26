import { test, expect } from '@playwright/test'
import { config, versionId } from '../../../web/tests/admin/membership-data'
for (const locale of ['zh', 'en'])
  test(`published pricing loads real API data and handles unavailable updates (${locale})`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = []
    let requests = 0
    await page.clock.install()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.route('**/api/public/membership-plans', (route) => {
      requests++
      if (requests > 1)
        return route.fulfill({
          status: 503,
          headers: { 'retry-after': '180' },
          json: { message: 'temporary failure' },
        })
      return route.fulfill({
        json: {
          plans: [{ ...config, id: 'monthly', versionId, revision: 1 }],
          campaign: {
            id: 'founders',
            name: 'First 100 members',
            enabled: true,
            capacity: 100,
            used: 7,
            remaining: 93,
            startsAt: null,
            endsAt: null,
            revision: 1,
          },
          refreshSeconds: 60,
          serverTime: Date.now(),
        },
      })
    })
    await page.goto(`/${locale}/pricing`)
    await expect(
      page.getByRole('heading', {
        name: locale === 'zh' ? '月付会员' : 'Monthly',
        exact: true,
      }),
    ).toBeVisible()
    await expect(
      page.getByText(locale === 'zh' ? '剩余名额 93' : 'Remaining 93'),
    ).toBeVisible()
    await expect(
      page.locator('.pricing-grid').getByRole('link'),
    ).toHaveAttribute('href', `/${locale}/contact?plan=monthly`)
    for (const width of [360, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width)
      await page.screenshot({
        path: testInfo.outputPath(`pricing-${locale}-${width}.png`),
        fullPage: true,
      })
    }
    await page.clock.runFor(66001)
    await expect(page.getByRole('status')).toContainText(
      locale === 'zh' ? '上次更新' : 'Last updated',
    )
    await expect(
      page.getByRole('heading', {
        name: locale === 'zh' ? '月付会员' : 'Monthly',
        exact: true,
      }),
    ).toBeVisible()
    await page.clock.runFor(30000)
    expect(requests).toBe(2)
    expect(errors).toEqual([])
  })
