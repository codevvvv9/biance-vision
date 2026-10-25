/**
 * 请求来源判定单点（P0-2b 修订，2026-10-25 线上事故根因收敛）：
 * 「浏览器 Origin 是否与本服务同源」只允许在这一处判定——写来源守卫
 * （sourceGuard）、WS 握手（index.ts）、管理突变（admin/mutationGuard）
 * 三处消费同一语义，禁止再各自手写比较。
 *
 * 语义（与部署形态解耦，不写死任何域名/端口）：
 * - 请求自身 origin = `${req.protocol}://${Host 头}`。协议取 Fastify 在信任链
 *   （BV_TRUSTED_PROXIES → trustProxy）下解析的 req.protocol：可信代理时自动
 *   采信 X-Forwarded-Proto（Caddy 反代默认携带），直连时为 socket 协议——
 *   未配置信任链时 XFP 不被采信，HTTPS Origin 判 foreign（fail-closed）。
 *   Host 尊重反代透传（Caddy 默认保留原始 Host，含显式非默认端口）。
 * - 端口归一对称（RFC 3986 §6.2.3 语法归一）：Origin 侧与请求侧都按各自
 *   scheme 的默认端口折叠后再比较。默认端口表是 URL 规范事实，不是部署
 *   形态假设——原缺陷正是「Origin 侧归一 443、Host 侧写死 80」的不对称，
 *   导致 TLS 终止在反代的 HTTPS 默认端口部署（生产标准拓扑）必被误判跨源。
 * - 白名单（BV_ALLOWED_ORIGINS，精确 origin）优先命中即 same，覆盖「前后端
 *   确实分域」的部署；'null' 与畸形 Origin 一律 foreign；无 Origin 头判
 *   absent（非浏览器客户端，放行与否由调用方语义决定，鉴权仍兜底）。
 * - 残余信任边界：Fastify 信任链只对 ip/hostname 校验对端，protocol getter
 *   对已配置 trustProxy 的进程恒读 XFP；本服务生产端口仅回环暴露、Caddy
 *   是唯一公网路径且会正确覆盖 XFP，故该残余面等价于「能直连容器者已在
 *   信任域」（与 P0-2a 的既有结论一致）。
 */
import type { FastifyRequest } from 'fastify'

export type OriginVerdict = 'absent' | 'same' | 'foreign'

/** scheme（不带冒号）→ 默认端口；仅 http(s) 有同源语义 */
const DEFAULT_PORTS: Readonly<Record<string, string>> = { http: '80', https: '443' }

/** 归一化 origin 字符串：小写 scheme/host、按 scheme 折叠默认端口；非法返回 null */
function canonicalOrigin(scheme: string, hostname: string, port: string): string | null {
  const def = DEFAULT_PORTS[scheme.toLowerCase()]
  if (def === undefined || hostname === '') return null
  if (port !== '' && port !== def && !/^\d+$/.test(port)) return null
  const p = port === '' || port === def ? '' : `:${port}`
  return `${scheme.toLowerCase()}://${hostname.toLowerCase()}${p}`
}

/** 解析 Host 头（host[:port]；IPv6 须 [::1]:port 括号形式，裸多冒号非法） */
function splitHostHeader(host: string): { hostname: string; port: string } | null {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end === -1) return null
    const rest = host.slice(end + 1)
    if (rest !== '' && !rest.startsWith(':')) return null
    return { hostname: host.slice(0, end + 1), port: rest === '' ? '' : rest.slice(1) }
  }
  const i = host.indexOf(':')
  if (i === -1) return { hostname: host, port: '' }
  const port = host.slice(i + 1)
  if (port === '' || host.indexOf(':', i + 1) !== -1) return null
  return { hostname: host.slice(0, i), port }
}

/** 解析 Origin 头为归一化 origin；非 origin 形态（带路径/凭据/查询/碎片）判非法 */
function parseBrowserOrigin(origin: string): string | null {
  try {
    const u = new URL(origin)
    if (u.username !== '' || u.password !== '') return null
    if (!(u.pathname === '' || u.pathname === '/') || u.search !== '' || u.hash !== '') return null
    return canonicalOrigin(u.protocol.replace(/:$/, ''), u.hostname, u.port)
  } catch {
    return null
  }
}

/** 纯函数判定：不依赖 Fastify 实例，单测/门禁直接构造参数 */
export function classifyOrigin(
  originHeader: unknown,
  requestProto: string,
  hostHeader: string | undefined,
  allow: ReadonlySet<string>,
): OriginVerdict {
  if (typeof originHeader !== 'string' || originHeader === '') return 'absent'
  if (originHeader === 'null') return 'foreign'
  if (allow.has(originHeader)) return 'same'
  const requestHost = typeof hostHeader === 'string' && hostHeader !== '' ? splitHostHeader(hostHeader) : null
  const requestOrigin = requestHost === null ? null : canonicalOrigin(requestProto, requestHost.hostname, requestHost.port)
  const browserOrigin = parseBrowserOrigin(originHeader)
  return browserOrigin !== null && browserOrigin === requestOrigin ? 'same' : 'foreign'
}

/** 请求级判定：调用方拿 verdict 自行决定 absent 的语义 */
export function requestOriginVerdict(req: FastifyRequest, allow: ReadonlySet<string>): OriginVerdict {
  return classifyOrigin(req.headers.origin, req.protocol, req.headers.host, allow)
}

/** absent/same 放行、foreign 拒绝——写守卫与 WS 握手共用的谓词（非浏览器无 Origin 放行，鉴权兜底） */
export function requestOriginAllowed(req: FastifyRequest, allow: ReadonlySet<string>): boolean {
  return requestOriginVerdict(req, allow) !== 'foreign'
}
