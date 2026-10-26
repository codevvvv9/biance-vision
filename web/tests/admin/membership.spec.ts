import { test, expect } from '@playwright/test'
import { plan, refresh, membership } from './membership-data'
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('app-lang', 'zh-CN'))
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname
    let body: unknown = {}
    if (path === '/api/auth/me')
      body = { user: { username: 'fixture-admin', role: 'superadmin' } }
    else if (path === '/api/admin/membership/plans')
      body = { plans: [plan], refresh }
    else if (path === '/api/admin/membership/refresh-settings')
      body = { refresh }
    else if (path === '/api/admin/membership/campaigns')
      body = {
        campaigns: [
          {
            id: 'founders',
            name: '内测',
            enabled: true,
            capacity: 100,
            used: 5,
            remaining: 95,
            startsAt: null,
            endsAt: null,
            revision: 1,
          },
        ],
        refresh,
      }
    else if (path === '/api/admin/membership/users')
      body = {
        users: [
          {
            username: 'member',
            managed: true,
            config: plan.draft,
            revision: 1,
            used: 4,
            ends_at: new Date(membership.current.endsAt).toISOString(),
          },
        ],
        total: 1,
        refresh,
      }
    else if (path === '/api/admin/users/member/membership')
      body = { membership, receipts: [], history: [] }
    else if (path === '/api/admin/ai/config')
      body = {
        profiles: {
          default: { model: 'chat', apiKeyMasked: 'test••key' },
          research: { model: 'research', apiKeyMasked: 'test••key' },
        },
      }
    else if (path === '/api/admin/membership/stats')
      body = { stats: { active: 1, managed: 1, received: '15' }, refresh }
    await route.fulfill({ status: 200, json: body })
  })
})
test('refresh settings show actual configuration and submit a revision-protected change', async ({
  page,
}) => {
  await page.goto('/admin/membership')
  await page.getByRole('tab', { name: '状态刷新设置', exact: true }).click()
  await expect(page.getByLabel('userSeconds', { exact: true })).toHaveValue(
    '60',
  )
  await page.getByLabel('userSeconds', { exact: true }).fill('30')
  const posted = page.waitForRequest(
    (r) =>
      r.method() === 'PUT' && r.url().endsWith('/membership/refresh-settings'),
  )
  await page.getByRole('button', { name: '保存刷新设置', exact: true }).click()
  expect((await posted).postDataJSON()).toEqual({
    userSeconds: 30,
    adminSeconds: 60,
    publicSeconds: 60,
    expectedRevision: 1,
  })
})
test('plan editor exposes independent AI references and preserves draft revision', async ({
  page,
}) => {
  await page.goto('/admin/membership')
  await page.getByRole('button', { name: '编辑草稿', exact: true }).click()
  await expect(
    page.getByRole('combobox', { name: 'Chat AI profile' }),
  ).toBeVisible()
  await expect(
    page.getByRole('combobox', { name: 'Research AI profile' }),
  ).toBeVisible()
  await page.getByLabel('Regular price', { exact: true }).fill('19')
  const posted = page.waitForRequest(
    (r) =>
      r.method() === 'PUT' && r.url().includes('/membership/plans/monthly'),
  )
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  expect((await posted).postDataJSON()).toMatchObject({
    expectedRevision: 1,
    config: {
      price: '19',
      chatProfile: 'default',
      researchProfile: 'research',
    },
  })
})
test('member details show current access and renewal controls', async ({
  page,
}) => {
  await page.goto('/admin/membership')
  await page.getByRole('tab', { name: '用户会员', exact: true }).click()
  await page
    .getByRole('button', { name: '开通／续费／详情', exact: true })
    .click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(
    page.getByRole('dialog').getByText('今日已用', { exact: false }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '确认保存会员授权', exact: true }),
  ).toBeVisible()
})
for (const width of [360, 1440])
  test(`membership page has no outer overflow at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/admin/membership')
    await expect(
      page.getByRole('button', { name: '编辑草稿', exact: true }),
    ).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width)
    await page.screenshot({
      path: testInfo.outputPath(`membership-${width}.png`),
      fullPage: true,
    })
  })
