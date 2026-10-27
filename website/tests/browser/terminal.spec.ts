import { membership as baseMembership, membershipDenied } from '../../../web/tests/admin/membership-data'
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
  test('no research access shows the gate card and the workbench never mounts or requests', async ({
    page,
  }) => {
    const posts: string[] = []
    const otherCalls: string[] = []
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname
      if (request.method() === 'POST') posts.push(path)
      else if (path !== '/api/auth/me' && path !== '/api/users/me/membership')
        otherCalls.push(path)
      let body: object = {}
      if (path === '/api/auth/me')
        body = { user: { username: 'browser_test', role: 'user' } }
      else if (path === '/api/users/me/membership') body = membershipDenied
      await route.fulfill({ json: body })
    })
    await page.addInitScript(() => localStorage.setItem('app-lang', 'en-US'))
    await page.goto(`${gateway}/research?ui=dev`)
    await expect(
      page.getByRole('heading', {
        name: 'Research terminal is a membership feature',
      }),
    ).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'Contact to enable' }),
    ).toHaveAttribute('href', 'https://t.me/test_contact')
    await expect(
      page.getByRole('button', { name: 'View past research' }),
    ).toBeVisible()
    // 工作台主体（含其数据请求）在门禁拒绝下完全不挂载；全局外壳
    // （如 alerts 轮询）不属于工作台主体，不计入
    await expect(page.locator('textarea')).toHaveCount(0)
    expect(posts).toEqual([])
    const workbenchCalls = otherCalls.filter((p) =>
      ['/api/conversations', '/api/portfolio', '/api/event-quotes', '/api/config/research-ui', '/api/research/'].some(
        (w) => p.startsWith(w),
      ),
    )
    expect(workbenchCalls).toEqual([])
  })
  test('a failed background refresh keeps the mounted workbench and shows a banner', async ({
    page,
  }) => {
    let fail = false
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }))
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        json: { user: { username: 'browser_test', role: 'user' } },
      }),
    )
    await page.route('**/api/conversations', (route) =>
      route.fulfill({ json: { conversations: [] } }),
    )
    await page.route('**/api/portfolio', (route) =>
      route.fulfill({ json: { positions: [] } }),
    )
    await page.route('**/api/event-quotes', (route) =>
      route.fulfill({ json: { quotes: [] } }),
    )
    await page.route('**/api/users/me/membership', async (route) => {
      if (fail)
        return route.fulfill({
          status: 503,
          json: { message: 'Status temporarily unavailable' },
        })
      await route.fulfill({
        json: {
          ...baseMembership,
          current: {
            ...baseMembership.current!,
            startsAt: Date.now() - 86400000,
            endsAt: Date.now() + 86400000,
          },
        },
      })
    })
    await page.addInitScript(() => localStorage.setItem('app-lang', 'en-US'))
    await page.goto(`${gateway}/research?ui=dev`)
    await page.locator('textarea').fill('Draft survives a failed refresh')
    await expect(page.locator('textarea')).toHaveValue(
      'Draft survives a failed refresh',
    )
    fail = true
    await page
      .getByRole('region', { name: 'My membership' })
      .getByRole('button', { name: 'Refresh', exact: true })
      .click()
    await expect(page.getByText(/Membership status refresh failed/)).toBeVisible()
    // 刷新失败只加横幅：主体不卸载，草稿与输入不丢
    await expect(page.locator('textarea')).toHaveValue(
      'Draft survives a failed refresh',
    )
  })
  test('a rejected send restores the question in the composer and after reload', async ({
    page,
  }) => {
    await page.route('**/api/**', (route) => route.fulfill({ json: {} }))
    await page.route('**/api/auth/me', (route) =>
      route.fulfill({
        json: { user: { username: 'browser_test', role: 'user' } },
      }),
    )
    await page.route('**/api/portfolio', (route) =>
      route.fulfill({ json: { positions: [] } }),
    )
    await page.route('**/api/event-quotes', (route) =>
      route.fulfill({ json: { quotes: [] } }),
    )
    await page.route('**/api/users/me/membership', (route) =>
      route.fulfill({
        json: {
          ...baseMembership,
          current: {
            ...baseMembership.current!,
            startsAt: Date.now() - 86400000,
            endsAt: Date.now() + 86400000,
          },
        },
      }),
    )
    await page.route('**/api/conversations', (route) => {
      if (route.request().method() === 'POST')
        return route.fulfill({
          status: 403,
          json: { code: 'research_access_required', message: 'denied' },
        })
      return route.fulfill({ json: { conversations: [] } })
    })
    await page.addInitScript(() => localStorage.setItem('app-lang', 'en-US'))
    await page.goto(`${gateway}/research?ui=dev`)
    await page.locator('textarea').fill('Restore me after denial')
    await page
      .getByRole('button', { name: 'Send research question', exact: true })
      .click()
    // 发送被拒：失败回填 + 待发送备份保证清空输入后原文不丢
    await expect(page.locator('textarea')).toHaveValue('Restore me after denial')
    await page.reload()
    await expect(page.locator('textarea')).toHaveValue('Restore me after denial')
  })
  test('an anonymous visitor sees the public workbench without private requests', async ({
    page,
  }) => {
    const calls: string[] = []
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      calls.push(path)
      if (path === '/api/auth/me')
        return route.fulfill({ status: 401, json: {} })
      await route.fulfill({ json: {} })
    })
    await page.addInitScript(() => localStorage.setItem('app-lang', 'en-US'))
    await page.goto(`${gateway}/research?ui=dev`)
    // 游客态正常展示（未登录无 membership store，绝不落入永久加载）
    await expect(page.locator('textarea')).toBeVisible()
    await expect(
      page.getByRole('button', { name: /sign in/i }).first(),
    ).toBeVisible()
    // 不请求私有数据（会话/持仓/报价仅登录后拉取）
    expect(calls).not.toContain('/api/conversations')
    expect(calls).not.toContain('/api/portfolio')
    expect(calls).not.toContain('/api/event-quotes')
    expect(calls).not.toContain('/api/users/me/membership')
  })
})
