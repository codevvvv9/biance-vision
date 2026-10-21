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
        const p = req.url.split('?')[0]
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

/** 进程默认门禁（读 ADMIN_HOSTS，模块加载时定值；未配置=关闭） */
export const adminGate = createAdminGate(process.env.ADMIN_HOSTS ?? '')

export function isAdminHost(host: string | undefined): boolean {
  return adminGate.isAdminHost(host)
}

export function registerAdminGate(app: FastifyInstance): void {
  adminGate.register(app)
}
