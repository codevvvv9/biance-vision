/**
 * 可信代理与客户端 IP 单点（P0-2）：
 * - BV_TRUSTED_PROXIES：空 = 不信任任何转发头（req.ip 即 socket 对端，客户端
 *   伪造 XFF/X-Real-IP 一律无效）；逗号分隔 IP/CIDR 列表 = 经 Fastify(proxy-addr)
 *   按信任链解析 XFF 末段。
 *   生产链路「宿主 Caddy → Docker 容器」对端是网桥网关：compose 注入
 *   BV_TRUSTED_PROXIES=172.16.0.0/12（覆盖默认网桥池），不硬编码 127.0.0.1
 *   （同机 ≠ 回环），也不信任全部私网。本地脚本从回环注入 XFF 模拟 IP 测试，
 *   测试进程注入 BV_TRUSTED_PROXIES=127.0.0.1。
 * - 禁止 trustProxy:true（反射任意来源的伪造 XFF——限速/锁定/地域全被伪造头绕过）。
 * - clientIp：信任链解析后的规范化结果；IPv4-mapped IPv6（::ffff:1.2.3.4）归一为
 *   IPv4，避免同一客户端按两种写法分裂计数。精确地址用于配额；不在本层做 IPv6 /64
 *   聚合（那是异常分析信号，见方案 §3.1）。
 */
import type { FastifyRequest } from 'fastify'

export function trustedProxies(): string[] {
  return (process.env.BV_TRUSTED_PROXIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Fastify 构造参数：空列表 = false（不信任），否则精确列表 */
export function trustProxyOption(): boolean | string[] {
  const list = trustedProxies()
  return list.length > 0 ? list : false
}

export function normalizeIp(ip: string): string {
  let v = ip.trim()
  if (v.startsWith('::ffff:') && v.includes('.')) v = v.slice(7)
  return v.slice(0, 64)
}

/** 统一客户端 IP：全部限速/锁定/审计/地域判断共用（口径漂移 = 计数分裂，实测踩坑） */
export function clientIp(req: FastifyRequest): string {
  return normalizeIp(String(req.ip ?? ''))
}
