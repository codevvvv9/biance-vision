/**
 * 地域封锁（应用层 GeoIP）：站点面向海外运营，默认屏蔽中国大陆来源 IPv4。
 *
 * - 名单文件：server/data/cn-ip-list.txt（17mon/china_ip_list，一行一个 CIDR；
 *   用 pnpm geo:update 或 deploy/oracle 与 deploy/vps 两份 README「地域封锁」一节的 curl 命令获取/更新）
 * - 名单缺失或加载失败 → 放行全部 + 显著告警（fail-open，绝不把运营者锁在门外）；
 *   实际状态看 /api/health 的 geoBlock 字段
 * - 热更新：每 60s 检查文件 mtime，变化即重载，无需重启进程
 * - 环境变量：
 *     GEO_BLOCK_CN=off        关闭封锁（默认 on）
 *     GEO_BLOCK_ALLOW=ip,cidr 白名单（逗号分隔，运营者自用出口 IP）
 *     GEO_BLOCK_CN_LIST=path  名单文件路径覆盖（默认 server/data/cn-ip-list.txt）
 * - 仅匹配 IPv4；IPv6 不在名单语义内（站点无 AAAA 记录时 IPv6 天然不可达，
 *   后续若开启 IPv6 需同步 v6 名单再扩展）
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { kv, log } from './logger.js'

type Range = [number, number]

const LIST_FILE =
  process.env.GEO_BLOCK_CN_LIST ||
  fileURLToPath(new URL('../data/cn-ip-list.txt', import.meta.url))
const RELOAD_POLL_MS = 60_000
/** 名单条目数下限：低于此值认为文件损坏/源异常，拒绝启用（防半空名单误伤或漏拦） */
const MIN_RANGES = 1000

const ENABLED = !['off', '0', 'false', 'no'].includes(
  (process.env.GEO_BLOCK_CN ?? 'on').trim().toLowerCase(),
)

/** IPv4 点分十进制 → 32 位无符号数（用乘法而非位运算，避免有符号溢出） */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** "1.2.3.0/24" 或裸 IP（按 /32）→ [起始, 结束] */
function parseCidr(line: string): Range | null {
  const [ipPart, prefixPart] = line.split('/')
  const base = ipv4ToInt((ipPart ?? '').trim())
  if (base === null) return null
  const bits = prefixPart === undefined ? 32 : Number(prefixPart.trim())
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null
  const size = 2 ** (32 - bits)
  const start = base - (base % size)
  return [start, start + size - 1]
}

/** 排序 + 合并重叠/相邻区间，供二分查找 */
function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0])
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

function inRanges(ranges: Range[], ip: number): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (ip < r[0]) hi = mid - 1
    else if (ip > r[1]) lo = mid + 1
    else return true
  }
  return false
}

function parseList(text: string): Range[] {
  const out: Range[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const r = parseCidr(t)
    if (r) out.push(r)
  }
  return out
}

/** 回环/内网段恒放行（健康检查、反代、容器网络都依赖它们） */
const PRIVATE_RANGES = mergeRanges(
  ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']
    .map(parseCidr)
    .filter((r): r is Range => r !== null),
)

let cnRanges: Range[] = []
let allowRanges: Range[] = []
let listLoadedAt: number | null = null
let listMtimeMs = 0

function loadFromDisk(): void {
  const text = fs.readFileSync(LIST_FILE, 'utf8')
  const parsed = parseList(text)
  if (parsed.length < MIN_RANGES) {
    throw new Error(`名单条目异常（${parsed.length} 条 < ${MIN_RANGES}），疑似文件损坏`)
  }
  cnRanges = mergeRanges(parsed)
  listMtimeMs = fs.statSync(LIST_FILE).mtimeMs
  listLoadedAt = Date.now()
  log.ok('geo', '中国大陆 IP 名单已加载', kv({ 区间数: cnRanges.length, 文件: LIST_FILE }))
}

/** 启动初始化：读白名单 → 读名单（失败 fail-open）→ 起 mtime 轮询热更新 */
export function initGeoBlock(): void {
  allowRanges = mergeRanges(parseList((process.env.GEO_BLOCK_ALLOW ?? '').split(',').join('\n')))
  if (!ENABLED) {
    log.warn('geo', '地域封锁已由 GEO_BLOCK_CN=off 关闭')
    return
  }
  try {
    loadFromDisk()
  } catch (err) {
    log.error(
      'geo',
      '中国大陆 IP 名单不可用，地域封锁暂停（全部放行）——请执行 pnpm geo:update 生成名单',
      err,
    )
  }
  setInterval(() => {
    try {
      const mtime = fs.statSync(LIST_FILE).mtimeMs
      if (mtime !== listMtimeMs) {
        loadFromDisk()
        log.info('geo', '名单文件已变化，热更新完成')
      }
    } catch {
      /* 文件暂时缺失：维持旧名单，下轮再试 */
    }
  }, RELOAD_POLL_MS).unref()
}

/** 命中封锁策略？（白名单与内网段优先放行） */
export function isRegionBlocked(ip: string): boolean {
  if (!ENABLED || cnRanges.length === 0) return false
  const n = ipv4ToInt(ip)
  if (n === null) return false
  if (inRanges(PRIVATE_RANGES, n)) return false
  if (allowRanges.length > 0 && inRanges(allowRanges, n)) return false
  return inRanges(cnRanges, n)
}

export function geoBlockStatus(): {
  enabled: boolean
  active: boolean
  ranges: number
  loadedAt: number | null
  allowlist: number
} {
  return {
    enabled: ENABLED,
    active: ENABLED && cnRanges.length > 0,
    ranges: cnRanges.length,
    loadedAt: listLoadedAt,
    allowlist: allowRanges.length,
  }
}

// 拦截日志聚合：大陆扫描流量可能很密，按分钟汇总一条，避免刷屏
let blockedCount = 0
let lastBlockedIp = ''
setInterval(() => {
  if (blockedCount === 0) return
  log.warn('geo', '已拦截中国大陆来源请求', kv({ 次数: blockedCount, 最近来源: lastBlockedIp }))
  blockedCount = 0
}, 60_000).unref()

const BLOCK_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>该地区暂不支持访问</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;background:#0b0e14;color:#dbe4f0;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="text-align:center;max-width:520px;padding:24px;line-height:1.9">
<h1 style="font-size:20px;margin:0 0 12px">该地区暂不支持访问 · Not available in your region</h1>
<p style="color:#8b98ab;font-size:14px;margin:0">本服务仅面向海外地区开放。<br>This service is only available in supported regions outside mainland China.</p>
</div></body></html>`

function replyBlocked(ip: string, req: FastifyRequest, reply: FastifyReply): void {
  blockedCount++
  lastBlockedIp = ip
  const wantsHtml = req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')
  if (wantsHtml) {
    void reply.code(403).header('content-type', 'text/html; charset=utf-8').send(BLOCK_HTML)
  } else {
    void reply.code(403).send({
      statusCode: 403,
      error: 'Forbidden',
      message: '该地区暂不支持访问 / Not available in your region',
      code: 'region_blocked',
    })
  }
}

/**
 * 注册全局拦截钩子（onRequest 阶段，早于鉴权）。
 * ipOf 复用 index.ts 的 clientIp（取 XFF 末段，防伪造语义与限速/审计一致）。
 */
export function registerGeoBlock(
  app: FastifyInstance,
  ipOf: (req: FastifyRequest) => string,
): void {
  app.addHook('onRequest', async (req, reply) => {
    const ip = ipOf(req)
    if (isRegionBlocked(ip)) replyBlocked(ip, req, reply)
  })
}
