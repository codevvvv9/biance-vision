import { membership as baseMembership } from '../../../web/tests/admin/membership-data'
import { test, expect, type Page } from '@playwright/test'
const gateway = process.env.WEBSITE_GATEWAY_TEST_URL
const makeDraft = (question: string, ago = 0) => ({
  version: 1,
  question,
  scene: 'perp',
  symbol: 'BTCUSDT',
  horizon: '1h',
  locale: 'en-US',
  createdAt: Date.now() - ago,
})
async function terminalApi(page: Page, remaining = 3) {
  const posts: string[] = []
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    if (request.method() === 'POST') posts.push(path)
    let body: object = {}
    if (path === '/api/auth/me')
      body = { user: { username: 'browser_test', role: 'user' } }
    else if (path === '/api/users/me/membership')
      body = {
        ...baseMembership,
        usedToday: 100 - remaining,
        remainingToday: remaining,
        current: {
          ...baseMembership.current,
          startsAt: Date.now() - 86400000,
          endsAt: Date.now() + 86400000,
        },
      }
    else if (path === '/api/users/me/ai-access')
      body = { managed: true, remaining }
    else if (path === '/api/conversations') body = { conversations: [] }
    else if (path === '/api/portfolio') body = { positions: [] }
    else if (path === '/api/event-quotes') body = { quotes: [] }
    await route.fulfill({ json: body })
  })
  return posts
}
test.describe('same-origin terminal handoff with controlled APIs', () => {
  test.skip(
    !gateway,
    'Start deploy/local/Caddyfile and set WEBSITE_GATEWAY_TEST_URL for the integration suite.',
  )
  test('a valid website question restores without submitting or putting text in a URL', async ({
    page,
  }) => {
    const posts = await terminalApi(page)
    await page.goto(`${gateway}/en`)
    await page.evaluate(
      (draft) =>
        sessionStorage.setItem('bv.research-entry.v1', JSON.stringify(draft)),
      makeDraft('Review BTC structure privately'),
    )
    await page.goto(`${gateway}/research?ui=dev`)
    await expect(page.locator('textarea')).toHaveValue(
      'Review BTC structure privately',
    )
    expect(posts).toEqual([])
    expect(page.url()).not.toContain('privately')
    expect(
      await page.evaluate(() => sessionStorage.getItem('bv.research-entry.v1')),
    ).toBeNull()
    await expect(
      page
        .getByRole('region', { name: 'My membership' })
        .getByText(/Remaining 3/),
    ).toBeVisible()
  })
  test('an existing draft requires a choice and survives keeping it', async ({
    page,
  }) => {
    const posts = await terminalApi(page)
    await page.goto(`${gateway}/en`)
    await page.evaluate((draft) => {
      sessionStorage.setItem('bv.research-entry.v1', JSON.stringify(draft))
      sessionStorage.setItem(
        'bv.workbench.drafts.v1',
        JSON.stringify({
          owner: 'browser_test',
          scene: 'perp',
          symbol: 'ETHUSDT',
          horizon: '30m',
          drafts: { perp: 'Keep this existing draft', spot: '', event: '' },
        }),
      )
      localStorage.setItem('app-lang', 'en-US')
    }, makeDraft('New website question'))
    await page.goto(`${gateway}/research?ui=dev`)
    await expect(page.locator('textarea')).toHaveValue(
      'Keep this existing draft',
    )
    await page
      .getByRole('button', { name: 'Keep current draft', exact: true })
      .click()
    await expect(page.locator('textarea')).toHaveValue(
      'Keep this existing draft',
    )
    expect(posts).toEqual([])
  })
  test('expired drafts offer manual input; exhausted quota disables submission and offers contact', async ({
    page,
  }) => {
    const posts = await terminalApi(page, 0)
    await page.goto(`${gateway}/en`)
    await page.evaluate(
      (draft) => {
        sessionStorage.setItem('bv.research-entry.v1', JSON.stringify(draft))
        localStorage.setItem('app-lang', 'en-US')
      },
      makeDraft('Expired private question', 31 * 60_000),
    )
    await page.goto(`${gateway}/research?ui=dev`)
    await expect(
      page.getByText(
        'Your website question expired. Write a question or choose an example below.',
      ),
    ).toBeVisible()
    await page.locator('textarea').fill('New question')
    await expect(
      page.getByRole('button', { name: 'Send research question', exact: true }),
    ).toBeDisabled()
    await expect(
      page.getByRole('link', { name: 'Contact admin to renew' }),
    ).toHaveAttribute('href', 'https://t.me/test_contact')
    expect(posts).toEqual([])
  })
  test('membership card and composer share status; accepted AI refreshes usage and failed polling preserves it', async ({
    page,
  }) => {
    await terminalApi(page)
    await page.addInitScript(() => localStorage.setItem('app-lang', 'en-US'))
    let reads = 0,
      used = 4,
      unavailable = false,
      failAi = false,
      idempotency = ''
    await page.route('**/api/users/me/membership', async (route) => {
      reads++
      await route.fulfill(
        unavailable
          ? { status: 503, json: { message: 'Status temporarily unavailable' } }
          : {
              json: {
                ...baseMembership,
                usedToday: used,
                remainingToday: 100 - used,
              },
            },
      )
    })
    await page.route('**/api/conversations', (route) =>
      route.fulfill({
        json:
          route.request().method() === 'POST'
            ? { conversation: { id: 'membership-test' } }
            : { conversations: [] },
      }),
    )
    await page.route('**/api/conversations/membership-test/**', (route) => {
      if (route.request().method() === 'POST') {
        if (failAi)
          return route.fulfill({
            status: 503,
            json: { message: 'AI test failure' },
          })
        used++
        idempotency = route.request().headers()['idempotency-key'] ?? ''
        return route.fulfill({
          status: 202,
          json: {
            message: {
              content: 'Accepted membership test',
              runId: null,
              card: null,
            },
            runId: null,
          },
        })
      }
      return route.fulfill({ json: {} })
    })
    await page.goto(`${gateway}/research?ui=dev`)
    const card = page.getByRole('region', { name: 'My membership' })
    await expect(card).toContainText('Used today 4')
    expect(reads).toBe(1)
    await page.locator('textarea').fill('Explain a higher low')
    await page
      .getByRole('button', { name: 'Send research question', exact: true })
      .click()
    await expect(card).toContainText('Used today 5')
    expect(reads).toBe(2)
    expect(idempotency).toMatch(/^[a-f0-9-]{36}$/)
    failAi = true
    await page
      .locator('textarea')
      .fill('Failed request refunds its reservation')
    await page
      .getByRole('button', { name: 'Send research question', exact: true })
      .click()
    await expect.poll(() => reads).toBe(3)
    await expect(card).toContainText('Used today 5')
    unavailable = true
    await card.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(card.getByRole('status')).toContainText('Last updated')
    await expect(card).toContainText('Used today 5')
    await expect(card).toContainText('Remaining 95')
  })
})
