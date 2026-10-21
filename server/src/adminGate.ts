/**
 * 管理端域名门禁（纵深防御的 server 层第二刀；第一刀是 Caddy 主域名 404 屏蔽，
 * 第三刀是各管理路由自身的 requireSuperadmin）。
 *
 * 环境变量 ADMIN_HOSTS：逗号分隔的 host 列表（如 "admin.example.com"），管理端
 * 页面（/admin*）与管理 API（/api/admin/*）只对这些 Host 开放。
 * - 未配置（默认）：门禁关闭，行为与历史版本完全一致——本地开发、未升级部署零影响；
 * - 已配置：其余 Host 访问上述路径一律 404；/admin 前端路径必须在 onRequest 直接
 *   短路，绝不能落到 SPA 回退（setNotFoundHandler 会回退 index.html，等于把
 *   admin 前端壳发给爬虫）。
 * host 匹配忽略大小写与端口（Host: admin.example.com:443 视同 admin.example.com）。
 *
 * 登录入口分离（loginEntryPolicy）：已配置管理域名时，superadmin 账号只能在管理
 * 域名签发会话、普通用户只能在用户域名——管理员密码的验证入口不暴露给用户端爆破，
 * 两类会话用途在签发时即分离（存量跨域会话由门禁拦截管理路径兜底，自然过期）。
 */
import type { FastifyInstance } from 'fastify'
import { kv, log } from './logger.js'

export interface AdminGate {
  readonly enabled: boolean
  readonly hosts: readonly string[]
  isAdminHost(host: string | undefined): boolean
  register(app: FastifyInstance): void
}

function normalizeHost(host: string | undefined): string {
  const h = (host ?? '').trim().toLowerCase()
  // 剥端口（域名场景；IPv6 字面量不在本门禁的使用语义内）
  const i = h.lastIndexOf(':')
  return i > 0 ? h.slice(0, i) : h
}

/**
 * 门禁路径判断用的规范化：URL 解码 + 压缩重复斜杠，循环至稳定（限次防双重编码
 * 如 %2561）。路由匹配（find-my-way）按解码后的路径命中，门禁若只看原始字符串，
 * /api/%61dmin/users 这类编码路径就能绕过前缀判断——判断与匹配必须在同一规范化层。
 * 解码失败（畸形百分号）时停止并按剩余原始串判断（保守拒绝由前缀不匹配自然发生）。
 */
export function gatePath(rawUrl: string): string {
  let p = rawUrl.split('?')[0]
  for (let i = 0; i < 3; i += 1) {
    let next: string
    try {
      next = decodeURIComponent(p)
    } catch {
      break
    }
    next = next.replace(/\/{2,}/g, '/')
    if (next === p) break
    p = next
  }
  return p.replace(/\/{2,}/g, '/')
}

export function createAdminGate(hostsCsv: string): AdminGate {
  const hosts = hostsCsv.split(',').map(normalizeHost).filter(Boolean)

  const gate: AdminGate = {
    enabled: hosts.length > 0,
    hosts,
    isAdminHost(host) {
      return gate.enabled && hosts.includes(normalizeHost(host))
    },
    register(app) {
      if (!gate.enabled) return
      app.addHook('onRequest', async (req, reply) => {
        if (gate.isAdminHost(req.headers.host)) return
        const p = gatePath(req.url)
        if (
          p === '/api/admin' ||
          p.startsWith('/api/admin/') ||
          p === '/admin' ||
          p.startsWith('/admin/')
        ) {
          return reply.code(404).send({ statusCode: 404, message: 'Not Found' })
        }
      })
      log.ok('server', '管理端域名门禁已启用', kv({ hosts: hosts.join(',') }))
    },
  }
  return gate
}

/**
 * 登录入口策略：superadmin 只能从管理域名签发会话，普通用户只能从用户域名。
 * gate 未启用（ADMIN_HOSTS 未配置，本地开发/未拆分部署）时不设限。
 * gate 参数仅供注入测试用的已启用实例，生产调用走默认实例。
 */
export function loginEntryPolicy(
  role: 'user' | 'superadmin',
  adminEntry: boolean,
  gate: Pick<AdminGate, 'enabled'> = adminGate,
): { ok: boolean; message?: string } {
  if (!gate.enabled) return { ok: true }
  if (role === 'superadmin' && !adminEntry) {
    return { ok: false, message: '管理员账号请从管理域名登录' }
  }
  if (role !== 'superadmin' && adminEntry) {
    return { ok: false, message: '管理域名仅供管理员账号使用，普通账号请在主站登录' }
  }
  return { ok: true }
}

/** 进程默认门禁（读 ADMIN_HOSTS，模块加载时定值；未配置=关闭） */
export const adminGate = createAdminGate(process.env.ADMIN_HOSTS ?? '')

export function isAdminHost(host: string | undefined): boolean {
  return adminGate.isAdminHost(host)
}

export function registerAdminGate(app: FastifyInstance): void {
  adminGate.register(app)
}
