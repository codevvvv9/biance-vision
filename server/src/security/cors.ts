/**
 * CORS 单点配置（Q-3）：废除 origin:true 反射（任意来源都能拿到跨域响应头）。
 * - 默认（未配置）：同源部署不反射——浏览器同源请求不需要 CORS 头，跨源一律不加；
 * - BV_ALLOWED_ORIGINS：显式精确列举（scheme://host[:port]，逗号分隔）才对对应来源
 *   放行跨域；未列举来源 / null / 缺失 Origin 不产生 CORS 头（浏览器按同源策略拦截）。
 * 开发链路走 Vite 代理（同源）与隧道同域名（同源），均不依赖跨域放行。
 * 非浏览器客户端（curl 等）不发 Origin 头，不受 CORS 影响——CORS 只约束浏览器。
 */
import type { FastifyCorsOptions } from '@fastify/cors'

export function allowedOrigins(): string[] {
  return (process.env.BV_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function corsOptions(): FastifyCorsOptions {
  const allow = new Set(allowedOrigins())
  return {
    credentials: true,
    origin: (origin, cb) => {
      if (typeof origin === 'string' && allow.has(origin)) return cb(null, true)
      return cb(null, false)
    },
  }
}
