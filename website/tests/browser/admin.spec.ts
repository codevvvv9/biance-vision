import { plan, refresh, membership, versionId } from '../../../web/tests/admin/membership-data'
import { test, expect } from '@playwright/test'
const admin = process.env.WEBSITE_ADMIN_TEST_URL

test('administrator publishes contacts and delivers a provisioned account only after save succeeds', async ({ page }) => {
  test.skip(!admin, 'Set WEBSITE_ADMIN_TEST_URL for admin browser checks.')
  const mutations: { path: string; body: Record<string, unknown> }[] = []
  let provisioned = false
  await page.route('**/api/**', async route => {
    const r = route.request(), path = new URL(r.url()).pathname
    let body: object = {}
    if (r.method() !== 'GET') mutations.push({ path, body: r.postDataJSON() as Record<string, unknown> })
    if (path === '/api/auth/me') body = { user: { username: 'test_admin', role: 'superadmin' } }
    else if (path === '/api/ai/status') body = { configured: true, model: 'test-model' }
    else if (path === '/api/admin/ai/config') body = { profiles: { default: { baseUrl: 'https://model.example.test/v1', model: 'test-model', apiKeyMasked: 'test••••key', maxTokens: 4096 } } }
    else if (path === '/api/admin/membership/plans') body = { plans: [plan], refresh }
    else if (path === '/api/admin/ai/models') body = { models: [] }
    else if (path === '/api/admin/ai/prompt') body = { prompt: '' }
    else if (path === '/api/admin/users') body = { users: [] }
    else if (path === '/api/admin/audit-logs') body = { records: [], usernames: [] }
    else if (path === '/api/admin/website-config') body = { contacts: { version: 1, revision: r.method() === 'GET' ? 0 : 1, telegram: '', email: 'codevvvv9@gmail.com', updatedAt: Date.now() } }
    else if (path === '/api/admin/users/provision') { provisioned = true; body = { username: 'bv_test_user', password: 'review-only-random-pass12', publicOrigin: 'https://user.example.test', loginPath: '/login?ui=dev&returnTo=%2Fresearch%3Fui%3Ddev', membership } }
    await route.fulfill({ status: path.endsWith('/provision') ? 201 : 200, json: body })
  })
  await page.addInitScript(() => localStorage.setItem('app-lang', 'zh-CN'))
  await page.goto(`${admin}/admin/panel`)
  await page.getByRole('tab', { name: '官网设置', exact: true }).click()
  await expect(page.getByText('官网公开联系方式', { exact: true })).toBeVisible()
  await page.getByLabel('Telegram 用户名', { exact: true }).fill('real_contact')
  await page.getByRole('button', { name: '保存并发布公开联系方式' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已发布 v1' })).toBeVisible()
  await page.getByRole('tab', { name: '用户管理', exact: true }).click()
  await page.getByRole('button', { name: '生成用户并配置 AI', exact: true }).click()
  await page.getByRole('combobox', { name: 'Membership plan' }).click()
  await page.getByTitle('月付会员 / Monthly · v1', { exact: true }).click()
  expect(provisioned).toBe(false)
  await page.getByRole('button', { name: '开通并生成交付信息', exact: true }).click()
  await expect(page.getByLabel('用户名', { exact: true }).last()).toHaveValue('bv_test_user')
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'password')
  expect(mutations.find(m => m.path.endsWith('/provision'))?.body).toMatchObject({ versionId, paidAmount: '15', action: 'bind' })
  expect(mutations.find(m => m.path.endsWith('/website-config'))?.body).toMatchObject({ telegram: 'real_contact', expectedRevision: 0 })
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(stored).not.toContain('review-only-random-pass12')
  await page.getByRole('button', { name: '清除并关闭' }).click()
  await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0)
})
