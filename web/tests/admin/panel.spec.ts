import { plan, refresh, membership, versionId } from './membership-data'
import { test, expect } from '@playwright/test'
const admin = 'http://127.0.0.1:17846'

test('administrator publishes contacts and delivers a provisioned account only after save succeeds', async ({ page }) => {
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
    else if (path === '/api/admin/users/provision') { provisioned = true; body = { username: 'bv_test_user', password: 'review-only-random-pass12', publicOrigin: 'https://user.example.test', loginPath: '/login?ui=dev&returnTo=%2Fbrooks', membership } }
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

test('rename migrates associations and reports the moved rows', async ({ page }) => {
  const mutations: { path: string; body: Record<string, unknown> }[] = []
  await page.route('**/api/**', async route => {
    const r = route.request(), path = new URL(r.url()).pathname
    let body: object = {}
    if (r.method() !== 'GET') mutations.push({ path, body: r.postDataJSON() as Record<string, unknown> })
    if (path === '/api/auth/me') body = { user: { username: 'test_admin', role: 'superadmin' } }
    else if (path === '/api/ai/status') body = { configured: true, model: 'test-model' }
    else if (path === '/api/admin/ai/config') body = { profiles: {} }
    else if (path === '/api/admin/users') body = { users: [{ username: 'bv_rename_me', role: 'user', createdAt: Date.now(), chatPolicy: { disabled: false, dailyLimit: null }, chatUsage: { today: 0, limit: null }, activeRecently: false }] }
    else if (path === '/api/admin/audit-logs') body = { records: [], usernames: [] }
    else if (path === '/api/admin/users/bv_rename_me/rename') body = { from: 'bv_rename_me', to: 'bv_renamed', migrated: { 'research_runs.user_id': 3, 'ai_conversations.username': 2 } }
    await route.fulfill({ status: 200, json: body })
  })
  await page.addInitScript(() => localStorage.setItem('app-lang', 'zh-CN'))
  await page.goto(`${admin}/admin/panel`)
  await page.getByRole('button', { name: '改名', exact: true }).click()
  await expect(page.getByText('改名后研究记录、会话、聊天、会员与额度等全部关联自动迁移')).toBeVisible()
  await page.getByLabel('新用户名', { exact: true }).fill('bv_renamed')
  await page.getByRole('button', { name: '改名用户', exact: true }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByText('bv_rename_me 已改名为 bv_renamed，共迁移 5 行关联数据。')).toBeVisible()
  expect(mutations.find(m => m.path.endsWith('/rename'))?.body).toEqual({ to: 'bv_renamed' })
  await page.getByRole('button', { name: '关闭' }).last().click()
})

test('custom password is delivered verbatim; random reset still posts an empty body', async ({ page }) => {
  const mutations: { path: string; body: Record<string, unknown> }[] = []
  await page.route('**/api/**', async route => {
    const r = route.request(), path = new URL(r.url()).pathname
    let body: object = {}
    if (r.method() !== 'GET') mutations.push({ path, body: r.postDataJSON() as Record<string, unknown> })
    if (path === '/api/auth/me') body = { user: { username: 'test_admin', role: 'superadmin' } }
    else if (path === '/api/ai/status') body = { configured: true, model: 'test-model' }
    else if (path === '/api/admin/ai/config') body = { profiles: {} }
    else if (path === '/api/admin/users') body = { users: [{ username: 'bv_pw_user', role: 'user', createdAt: Date.now(), chatPolicy: { disabled: false, dailyLimit: null }, chatUsage: { today: 0, limit: null }, activeRecently: false }] }
    else if (path === '/api/admin/audit-logs') body = { records: [], usernames: [] }
    else if (path === '/api/admin/users/bv_pw_user/ai-access') body = { access: { totalLimit: 100, used: 1, dailyLimit: 10, requestsPerMinute: 6 } }
    else if (path === '/api/admin/users/bv_pw_user/reset-credentials') {
      const posted = r.postDataJSON() as { password?: string }
      body = { username: 'bv_pw_user', password: posted.password ?? 'handover-pass-42' }
    }
    await route.fulfill({ status: 200, json: body })
  })
  await page.addInitScript(() => localStorage.setItem('app-lang', 'zh-CN'))
  await page.goto(`${admin}/admin/panel`)
  await page.getByRole('button', { name: '额度 / 重置密码', exact: true }).click()
  // 填入自定义密码 → 按钮变「设置密码」，按原文交付
  await page.locator('#custom-password').fill('custom-pass-123')
  await page.getByRole('button', { name: '设置密码', exact: true }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByLabel('随机密码', { exact: true })).toHaveValue('custom-pass-123')
  expect(mutations.find(m => m.path.endsWith('/reset-credentials'))?.body).toEqual({ password: 'custom-pass-123' })
  // 留空 → 按钮回到「重置交付密码」，空 body 生成随机（原设计保持）
  await page.locator('#custom-password').fill('')
  await page.getByRole('button', { name: '重置交付密码', exact: true }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.getByLabel('随机密码', { exact: true })).toHaveValue('handover-pass-42')
  expect(mutations.filter(m => m.path.endsWith('/reset-credentials')).map(m => m.body)).toEqual([{ password: 'custom-pass-123' }, {}])
})
