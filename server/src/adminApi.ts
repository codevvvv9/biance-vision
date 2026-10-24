/**
 * 管理 API 独立入口（W3-S3，docs/admin-isolation-plan.md §3.2/§3.1 apps/admin-api）：
 * 与 user-api（index.ts）同镜像不同进程——只注册管理能力，不注册任何用户路由
 * （行情/研究/AI 聊天/WS 均物理不存在）。
 *
 * - 部署：compose admin-api 服务（127.0.0.1:3201 → 容器 3200），Caddy admin 域名反代至此；
 *   Basic Auth（Caddy）→ 本进程登录（恒管理入口：普通账号被拒）→ 超管会话；
 * - 会话用途标记（W3-S2）：本进程只认 purpose='admin' 的会话；
 * - 托管 dist-admin（管理端独立前端，base /admin/）；根路径 302 /admin；
 * - 与 user-api 共享：PostgreSQL（users/auth_sessions/login_guards）、pg-boss（知识库
 *   解析入队）、共享卷（ai-config.json，mtime+版本号跨进程刷新契约）；
 * - geoBlock 不注册（admin 域名豁免语义延续：Caddy Basic Auth 在前）。
 */
import './env.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import type { FastifyRequest } from 'fastify'
import { buildApp } from './fastifyApp.js'
import { clientIpOf, registerAuthRoutes, unauthorized } from './authRoutes.js'
import { initDb, isDbAvailable } from './db.js'
import { initUsers, initSessions, readSessionToken, findSession } from './users.js'
import type { SessionRecord } from './users.js'
import { initAudit, recordAudit } from './audit.js'
import { kv, log, fmtMs, briefUa } from './logger.js'
import { startQueue } from './queue.js'
import { registerKnowledgeRoutes } from './knowledge/routes.js'
import { registerAdminRoutes } from './admin/routes.js'
import { registerWebsiteSettingsRoutes } from './admin/websiteSettings.js'
import { registerProvisionUserRoutes } from './admin/provisionUsers.js'
import { refreshCapabilities } from './admin/capabilities.js'
import {
  aiModelName,
  aiProfileByName,
  buildSystemPrompt,
  clearAiConfig,
  clearAiProfile,
  getAiProfilesMasked,
  isAiConfigured,
  listAiModels,
  resolveApiKey,
  saveAiProfiles,
  testAiConnection,
} from './ai.js'
import { probeVectorSupport } from './knowledge/vector.js'

const PORT = Number(process.env.PORT ?? 3200)
const HOST = process.env.HOST ?? '0.0.0.0'
const ADMIN_DIST = process.env.BV_ADMIN_DIST || fileURLToPath(new URL('../../web/dist-admin', import.meta.url))

// ---------------------------------------------------------------------------
// 存储：与 user-api 同源（迁移由 compose migrate 容器先行；BV_AUTO_MIGRATE 缺省仍自动）
// ---------------------------------------------------------------------------
await initDb({ migrate: process.env.BV_AUTO_MIGRATE !== '0' })
await initUsers()
await initSessions()
await initAudit()

const app = buildApp({ cors: false })

// 客户端 IP：与 user-api 同口径（共享实现 clientIpOf——口径漂移=限速计数分裂）
const clientIp = clientIpOf

// ---------------------------------------------------------------------------
// 认证（恒管理入口）+ API 鉴权钩子（登录/健康白名单，其余 /api/* 要求 admin 会话）
// ---------------------------------------------------------------------------
const auth = registerAuthRoutes(app, { entryKind: 'admin', clientIp })
const requireSuperadmin = (req: { headers: { cookie?: string } }): SessionRecord => {
  const session = auth.requireSession(req as never)
  if (session.role !== 'superadmin') throw Object.assign(new Error('需要超级管理员权限'), { statusCode: 403 })
  return session
}

app.addHook('preHandler', async (req, reply) => {
  const url = req.url.split('?')[0]
  if (!url.startsWith('/api/')) return
  if (url === '/api/health' || url.startsWith('/api/auth/')) return
  try {
    await auth.requireLiveSession(req)
  } catch (err) {
    const e = err as { statusCode?: number }
    reply.code(e.statusCode ?? 401).send({ message: (err as Error).message })
  }
})

// HTTP 访问日志（管理端低频，全量记录）
app.addHook('onResponse', (req, reply, done) => {
  const url = req.url.split('?')[0]
  if (url.startsWith('/api/') && url !== '/api/health') {
    const status = reply.statusCode
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
    const user = findSession(readSessionToken(req.headers.cookie), 'admin')?.username
    log[level]('http', `${req.method} ${req.url} → ${status}`, kv({
      耗时: fmtMs(reply.elapsedTime ?? 0),
      用户: user,
      入口: 'admin-api',
      ip: clientIp(req),
    }))
  }
  done()
})

app.get('/api/health', async () => ({
  ok: true,
  entry: 'admin-api',
  storage: isDbAvailable() ? 'postgres' : 'unavailable',
  uptime: Math.floor(process.uptime()),
}))

/** 管理端前端的 AI Provider 只读状态（AiSettingsModal/AiContext；user-api 的 /api/ai/* 不在本进程） */
app.get('/api/ai/status', async () => ({ configured: isAiConfigured(), model: aiModelName() }))

// ---------------------------------------------------------------------------
// 管理端路由（原 user-api 上的物理收口：admin 核心 + agents/evals/models/users/audit/ai overview）
// ---------------------------------------------------------------------------
registerAdminRoutes(app, { requireSuperadmin })
registerWebsiteSettingsRoutes(app, { requireSuperadmin })
registerProvisionUserRoutes(app, { requireSuperadmin })

// 知识库（multipart 上传；解析入队由共享 pg-boss 交给 worker 消费）
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 20 } })
registerKnowledgeRoutes(app, { requireSuperadmin })
await refreshCapabilities()
void probeVectorSupport().catch(() => {})

// ---------------------------------------------------------------------------
// AI 配置管理（自 index.ts 物理迁入，语义不变）——/api/admin/ai/* 命名空间
// ---------------------------------------------------------------------------
const badRequest = (msg: string): Error => Object.assign(new Error(msg), { statusCode: 400 })

app.get('/api/admin/ai/config', async (req) => {
  requireSuperadmin(req)
  return { profiles: getAiProfilesMasked() }
})

app.put('/api/admin/ai/config', async (req) => {
  const session = requireSuperadmin(req)
  saveAiProfiles((req.body ?? {}) as Record<string, unknown>, session.username)
  recordAudit(session, {
    action: 'settings_update',
    target: 'ai',
    detail: `AI 配置档案（${Object.keys(getAiProfilesMasked()).join('、')}）`,
  })
  return { ok: true, profiles: getAiProfilesMasked() }
})

// 删除：?name=xxx 删单个档案（default 不可删）；不带 name 清空全部
app.delete('/api/admin/ai/config', async (req) => {
  const session = requireSuperadmin(req)
  const name = (req.query as { name?: string }).name
  if (name) {
    clearAiProfile(name, session.username)
    recordAudit(session, { action: 'settings_update', target: 'ai', detail: `删除 AI 档案「${name}」` })
  } else {
    clearAiConfig(session.username)
    recordAudit(session, { action: 'settings_update', target: 'ai', detail: '清除全部 AI 配置' })
  }
  return { ok: true }
})

app.post('/api/admin/ai/test', async (req) => {
  const session = requireSuperadmin(req)
  const body = (req.body ?? {}) as Record<string, unknown>
  const baseUrl = String(body.baseUrl ?? '').trim().replace(/\/+$/, '')
  const apiKey = String(body.apiKey ?? '').trim()
  const model = String(body.model ?? '').trim()
  const profileName = (req.query as { name?: string }).name
  if (!/^https?:\/\//.test(baseUrl) || !apiKey || !model) throw badRequest('请先填写完整的 baseUrl / apiKey / model')
  const startedAt = Date.now()
  const result = await testAiConnection({ baseUrl, apiKey: resolveApiKey(apiKey, aiProfileByName(profileName)?.apiKey), model })
  const host = (() => {
    try {
      return new URL(baseUrl).host
    } catch {
      return '无效地址'
    }
  })()
  log.info('ai', '连通性测试', kv({
    操作者: session.username,
    接口: host,
    模型: model,
    结果: result === 'ok' ? '成功' : result,
    耗时: fmtMs(Date.now() - startedAt),
  }))
  return { ok: result === 'ok', message: result === 'ok' ? '连接成功' : result }
})

/** 指定档案当前生效的完整系统提示词（内置 + 追加 + 实时快照示例），设置弹窗"❗"查看 */
app.get('/api/admin/ai/prompt', async (req) => {
  requireSuperadmin(req)
  const profile = aiProfileByName((req.query as { name?: string }).name)
  if (!profile) throw badRequest('档案不存在或未配置完整')
  return { prompt: buildSystemPrompt(profile) }
})

/** 指定档案服务的可用模型列表（设置弹窗模型输入框候选） */
app.get('/api/admin/ai/models', async (req) => {
  requireSuperadmin(req)
  return { models: await listAiModels((req.query as { name?: string }).name) }
})

// ---------------------------------------------------------------------------
// 静态托管：仅管理端产物（dist-admin，base /admin/）；根路径 302 /admin；
// SPA 回退全部回 admin.html（本进程没有用户端前端）
// ---------------------------------------------------------------------------
if (fs.existsSync(ADMIN_DIST)) {
  await app.register(fastifyStatic, { root: path.resolve(ADMIN_DIST), prefix: '/admin/', index: 'admin.html' })
  app.setNotFoundHandler((req, reply) => {
    const p = req.url.split('?')[0]
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      if (p === '/') return reply.redirect('/admin')
      return reply.sendFile('admin.html', path.resolve(ADMIN_DIST))
    }
    reply.code(404).send({ message: 'Not Found' })
  })
  log.ok('server', `管理端静态资源：${ADMIN_DIST}（/admin）`)
} else {
  log.warn('server', 'web/dist-admin 不存在（开发模式由 Vite dev:admin 提供）')
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ message: 'Not Found' }))
}

// pg-boss：管理动作入队（知识库解析），worker 消费
await startQueue()

await app.listen({ port: PORT, host: HOST })
log.ok('server', `admin-api listening on http://${HOST}:${PORT}（仅管理能力；用户路由不注册）`)
