/**
 * 管理端域名门禁自测（pnpm admin:gate-check）。
 *
 * 用生产同款 createAdminGate/register 挂在最小 Fastify 实例上断言五组行为：
 * A. 未配置（空 hosts）→ 门禁关闭：任意 Host 的 /api/admin/* 正常进路由、/admin 正常落 SPA 回退
 * B. 已配置 → 错误 Host：/api/admin、/api/admin/*、/admin、/admin/* 一律 404，
 *    且 /admin 不得落 SPA 回退（否则等于把 admin 前端壳发给爬虫）；
 *    编码路径不得绕过（/api/%61dmin、//api/admin 双斜杠、%2561 双重编码）——
 *    路由匹配按解码后路径命中，门禁判断必须与之间层（gatePath 规范化）
 * C. 已配置 → 正确 Host（含带端口/大写变体）放行；无关路径与撞前缀路径（/api/administrator）不受影响
 * D. 登录入口策略（loginEntryPolicy）：已配置时 superadmin 只能管理域名、普通账号只能用户域名；
 *    未配置时不设限（本地开发零影响）
 * E. 登录验证前预检（loginPrecheck）：错误入口在 scrypt 之前按用户名拒绝（roleOf 桩断言）；
 *    HTTP 层「scrypt 未执行」证据由 login-regression R4b 日志断言钉住
 */
import Fastify from 'fastify'
import { createAdminGate, gatePath, loginEntryPolicy, loginPrecheck } from '../server/src/adminGate.js'

let failed = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `（期望 ${String(expected)}，实际 ${String(actual)}）`}`)
  if (!ok) failed++
}

/** 模拟生产形态：管理 API + 健康检查 + 撞前缀路由 + SPA 回退（index.ts 同款语义） */
async function buildApp(gate: ReturnType<typeof createAdminGate>) {
  const app = Fastify()
  gate.register(app)
  app.get('/api/admin/users', async () => ({ ok: true }))
  app.get('/api/administrator', async () => ({ ok: true }))
  app.get('/api/health', async () => ({ ok: true }))
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.split('?')[0].startsWith('/api/')) {
      return reply.type('text/html').send('<html>SPA</html>')
    }
    reply.code(404).send({ message: 'Not Found' })
  })
  await app.ready()
  return app
}

const MAIN = 'www.example.com'
const ADMIN = 'admin.example.com'

// ---- A. 未配置：零行为变化 ----
{
  const gate = createAdminGate('')
  check('A1 未配置时门禁关闭（enabled=false）', gate.enabled, false)
  const app = await buildApp(gate)
  check(
    'A2 主域 Host 访问管理 API 放行',
    (await app.inject({ method: 'GET', url: '/api/admin/users', headers: { host: MAIN } })).statusCode,
    200,
  )
  check(
    'A3 主域 Host 访问 /admin 落 SPA 回退',
    (await app.inject({ method: 'GET', url: '/admin', headers: { host: MAIN } })).statusCode,
    200,
  )
  await app.close()
}

// ---- B. 已配置：错误 Host 一律 404 ----
{
  const app = await buildApp(createAdminGate(ADMIN))
  const cases: Array<[string, string]> = [
    ['B1 /api/admin 精确路径', '/api/admin'],
    ['B2 /api/admin/* 深层', '/api/admin/users'],
    ['B3 /admin 精确路径', '/admin'],
    ['B4 /admin/* 深层', '/admin/knowledge/x'],
  ]
  for (const [name, url] of cases) {
    const res = await app.inject({ method: 'GET', url, headers: { host: MAIN } })
    check(`${name} → 404`, res.statusCode, 404)
    if (url === '/admin') {
      check('B5 /admin 拦截响应不得是 html（防 SPA 回退泄壳）', String(res.headers['content-type'] ?? '').includes('html'), false)
    }
  }
  check(
    'B6 带 query 不影响拦截',
    (await app.inject({ method: 'GET', url: '/api/admin/users?x=1', headers: { host: MAIN } })).statusCode,
    404,
  )
  // B7-B9 编码绕过：门禁判断与路由匹配必须同层（gatePath 解码+压缩斜杠）
  check(
    'B7 /api/%61dmin/users（URL 编码 a）→ 404',
    (await app.inject({ method: 'GET', url: '/api/%61dmin/users', headers: { host: MAIN } })).statusCode,
    404,
  )
  check(
    'B8 //api/admin/users（双斜杠）→ 404',
    (await app.inject({ method: 'GET', url: '//api/admin/users', headers: { host: MAIN } })).statusCode,
    404,
  )
  check(
    'B9 /api/%2561dmin/users（双重编码）→ 404',
    (await app.inject({ method: 'GET', url: '/api/%2561dmin/users', headers: { host: MAIN } })).statusCode,
    404,
  )
  check(
    'B10 /%61dmin（前端路径编码）→ 404',
    (await app.inject({ method: 'GET', url: '/%61dmin/knowledge', headers: { host: MAIN } })).statusCode,
    404,
  )
  check('B11 gatePath 规范化（%61 → a）', gatePath('/api/%61dmin/users'), '/api/admin/users')
  check('B12 gatePath 压缩双斜杠', gatePath('//api//admin//users'), '/api/admin/users')
  await app.close()
}

// ---- C. 已配置：正确 Host 与无关路径 ----
{
  const app = await buildApp(createAdminGate(ADMIN))
  check(
    'C1 管理 Host 访问管理 API 放行',
    (await app.inject({ method: 'GET', url: '/api/admin/users', headers: { host: ADMIN } })).statusCode,
    200,
  )
  check(
    'C2 管理 Host 带端口（:443）等同',
    (await app.inject({ method: 'GET', url: '/api/admin/users', headers: { host: `${ADMIN}:443` } })).statusCode,
    200,
  )
  check(
    'C3 管理 Host 大写变体等同',
    (await app.inject({ method: 'GET', url: '/api/admin/users', headers: { host: ADMIN.toUpperCase() } })).statusCode,
    200,
  )
  check(
    'C4 错误 Host 访问 /api/health 不受影响',
    (await app.inject({ method: 'GET', url: '/api/health', headers: { host: MAIN } })).statusCode,
    200,
  )
  check(
    'C5 撞前缀 /api/administrator 不误拦',
    (await app.inject({ method: 'GET', url: '/api/administrator', headers: { host: MAIN } })).statusCode,
    200,
  )
  await app.close()
}

// ---- D. 登录入口策略 loginEntryPolicy（生产绑默认实例；测试注入已启用工厂实例）----
{
  check('D1 未配置 ADMIN_HOSTS 时入口策略不设限（本地开发零影响）', loginEntryPolicy('superadmin', false).ok, true)
  const on = createAdminGate(ADMIN) // 已启用实例：验证「已配置」分支的双向拒绝
  check('D2 已配置：主站拒绝 superadmin 签发会话', loginEntryPolicy('superadmin', false, on).ok, false)
  check('D3 已配置：管理域名拒绝普通账号登录', loginEntryPolicy('user', true, on).ok, false)
  check('D4 已配置：主站普通账号正常', loginEntryPolicy('user', false, on).ok, true)
  check('D5 已配置：管理域名 superadmin 正常', loginEntryPolicy('superadmin', true, on).ok, true)
  check('D6 拒绝文案非空（供前端展示）', loginEntryPolicy('superadmin', false, on).message !== undefined, true)
}

// ---- E. 登录验证前预检 loginPrecheck（scrypt 之前按用户名拒错误入口；
//      roleOf 桩记录调用，断言预检确实查询了角色且结构上不接触密码）----
{
  check('E1 未配置时不限制（放行至密码验证）', loginPrecheck('admin', false, () => 'superadmin').allowed, true)
  const on = createAdminGate(ADMIN)
  let calls = 0
  const roleOf = (u: string): 'user' | 'superadmin' | null => {
    calls++
    return u === 'admin' ? 'superadmin' : u === 'bob' ? 'user' : null
  }
  check('E2 已配置：主站收到 superadmin 用户名 → 预检拒绝', loginPrecheck('admin', false, roleOf, on).allowed, false)
  check('E3 已配置：管理域收到普通用户名 → 预检拒绝', loginPrecheck('bob', true, roleOf, on).allowed, false)
  check('E4 已配置：主站普通用户名放行', loginPrecheck('bob', false, roleOf, on).allowed, true)
  check('E5 已配置：管理域 superadmin 放行', loginPrecheck('admin', true, roleOf, on).allowed, true)
  check('E6 未知用户名放行（交给 verifyLogin 正常 401，不暴露存在性）', loginPrecheck('nobody', false, roleOf, on).allowed, true)
  check('E7 预检确实执行了角色查询（roleOf 被调用 5 次：E2-E6 各一次）', calls, 5)
  // 结构性保证：loginPrecheck 签名不含密码参数——密码校验在预检拒绝路径上不可能发生；
  // HTTP 层的「scrypt 未执行」证据由 login-regression 的 R4b 日志断言钉住
}

// 失败退出必须放在全部测试组（含 D/E 组登录策略）之后：此前检查位于 D 组之前，
// D 组失败不会非零退出、release gate 拦不住这类回归（2026-10-21 审查 P2）
if (failed > 0) {
  console.error(`\n管理端域名门禁自测未通过 ✖（${failed} 项失败）`)
  process.exit(1)
}

console.log('\n管理端域名门禁自测全部通过 ✔（35 项）')
