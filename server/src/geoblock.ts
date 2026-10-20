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

/** 防御性转义：拦截命中的 IP 必为合法 IPv4（纯数字+点），此处仍兜底防注入 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

/**
 * 拦截页：风格对齐 web/src/styles/base.css 的暗色科技设计系统。
 * 约束：完全自包含（无外部字体/样式/脚本——被拦用户本就加载不了 CDN），
 * 诊断信息（IP/时间/规则）方便用户截图反馈误判。
 */
function blockPageHtml(ip: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark">
<title>403 · 该地区暂不支持访问 — Biance Vision</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', Roboto, sans-serif;
    background: #070b14;
    color: #e8eefc;
    display: grid;
    place-items: center;
    min-height: 100vh;
    padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  /* 环境光晕（cyan/purple，与登录页同族） */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(640px 420px at 50% -10%, rgba(0, 229, 255, 0.07), transparent 60%),
      radial-gradient(560px 420px at 100% 110%, rgba(167, 139, 250, 0.06), transparent 60%),
      radial-gradient(480px 380px at 0% 100%, rgba(0, 229, 255, 0.04), transparent 60%);
    pointer-events: none;
  }
  .card {
    position: relative;
    width: 100%;
    max-width: 560px;
    text-align: center;
    padding: 46px 40px 32px;
    border-radius: 16px;
    border: 1px solid #1a2438;
    background: linear-gradient(180deg, rgba(18, 28, 50, 0.72), rgba(10, 16, 30, 0.88));
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.45);
    animation: rise 0.5s ease-out both;
  }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  .icon {
    width: 72px;
    height: 72px;
    margin: 0 auto 20px;
    animation: breathe 6s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { filter: drop-shadow(0 0 10px rgba(0, 229, 255, 0.16)); }
    50% { filter: drop-shadow(0 0 22px rgba(0, 229, 255, 0.32)); }
  }
  .status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 11px;
    letter-spacing: 0.12em;
    color: #8ea0c2;
    border: 1px solid #24304a;
    background: rgba(11, 17, 32, 0.6);
    padding: 5px 12px;
    border-radius: 999px;
    margin-bottom: 22px;
  }
  .status .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #ff4d6a;
    box-shadow: 0 0 8px rgba(255, 77, 106, 0.8);
  }
  h1 { font-size: 22px; font-weight: 650; letter-spacing: 0.01em; margin-bottom: 6px; }
  .en { font-size: 13px; color: #8ea0c2; letter-spacing: 0.02em; margin-bottom: 20px; }
  .desc {
    font-size: 14px;
    line-height: 1.85;
    color: #c9d6ef;
    margin: 0 auto 26px;
  }
  .desc .muted { color: #8ea0c2; font-size: 13px; }
  .diag {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 12px;
    text-align: left;
    background: rgba(4, 6, 12, 0.55);
    border: 1px solid #1a2438;
    border-radius: 10px;
    padding: 12px 14px;
    margin-bottom: 24px;
    display: grid;
    gap: 6px;
  }
  .diag div { display: flex; gap: 12px; }
  .diag .k { width: 44px; flex: none; color: #5a6b8c; }
  .diag .v { color: #c9d6ef; word-break: break-all; }
  .actions {
    display: flex;
    gap: 12px;
    justify-content: center;
    flex-wrap: wrap;
    margin-bottom: 26px;
  }
  .btn {
    appearance: none;
    cursor: pointer;
    font: inherit;
    font-size: 13px;
    padding: 9px 18px;
    border-radius: 9px;
    transition: filter 0.15s, border-color 0.15s, background 0.15s, transform 0.05s;
  }
  .btn:active { transform: translateY(1px); }
  .btn-primary {
    color: #06121f;
    font-weight: 600;
    background: linear-gradient(135deg, #00e5ff, #4da3ff);
    border: none;
  }
  .btn-primary:hover { filter: brightness(1.1); }
  .btn-ghost {
    color: #c9d6ef;
    background: rgba(16, 26, 46, 0.5);
    border: 1px solid #24304a;
  }
  .btn-ghost:hover { border-color: #33436b; background: rgba(22, 34, 60, 0.6); }
  .hint { font-size: 12px; color: #5a6b8c; line-height: 1.8; }
  .brand {
    margin-top: 28px;
    padding-top: 18px;
    border-top: 1px solid #1a2438;
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    font-size: 11px;
    letter-spacing: 0.28em;
    color: #5a6b8c;
  }
  @media (max-width: 480px) {
    .card { padding: 34px 22px 26px; }
    h1 { font-size: 19px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .card, .icon { animation: none; }
  }
</style>
</head>
<body>
<main class="card">
  <svg class="icon" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <circle cx="32" cy="32" r="21" stroke="#00e5ff" stroke-opacity="0.95" stroke-width="2"/>
    <path d="M32 11a32.1 32.1 0 0 1 8.4 21 32.1 32.1 0 0 1-8.4 21 32.1 32.1 0 0 1-8.4-21 32.1 32.1 0 0 1 8.4-21Z" stroke="#00e5ff" stroke-opacity="0.55" stroke-width="2"/>
    <path d="M11 32h42" stroke="#00e5ff" stroke-opacity="0.55" stroke-width="2"/>
    <path d="M12.5 51.5 51.5 12.5" stroke="#ff4d6a" stroke-width="2.5" stroke-linecap="round"/>
  </svg>
  <div class="status"><span class="dot"></span>HTTP 403 · REGION_BLOCKED</div>
  <h1>该地区暂不支持访问</h1>
  <div class="en">Not available in your region</div>
  <p class="desc">
    因服务区域限制，本站点暂无法向您当前的网络位置提供服务。<br>
    <span class="muted">Due to regional service restrictions, this site is not available from your current location.</span>
  </p>
  <div class="diag">
    <div><span class="k">TIME</span><span class="v" id="t">—</span></div>
    <div><span class="k">IP</span><span class="v">${escapeHtml(ip)}</span></div>
    <div><span class="k">RULE</span><span class="v">geo/ipv4 · deny</span></div>
  </div>
  <div class="actions">
    <button class="btn btn-primary" onclick="location.reload()">刷新重试 · Retry</button>
    <button class="btn btn-ghost" id="copy">复制诊断信息 · Copy</button>
  </div>
  <p class="hint">
    正在旅行、或认为此拦截有误？请更换网络后重试，或截图本页并联系站点运营者。<br>
    Traveling or believe this is a mistake? Switch networks, or contact the site operator with a screenshot.
  </p>
  <div class="brand">BIANCE&nbsp;VISION</div>
</main>
<script>
(function () {
  var t = document.getElementById('t');
  if (t) t.textContent = new Date().toLocaleString('zh-CN', { hour12: false });
  var btn = document.getElementById('copy');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var lines = Array.prototype.map.call(
      document.querySelectorAll('.diag div'),
      function (row) {
        return row.querySelector('.k').textContent + ' ' + row.querySelector('.v').textContent;
      },
    );
    var text = 'BIANCE VISION · 403 region_blocked\\n' + lines.join('\\n');
    function done(ok) {
      btn.textContent = ok ? '已复制 · Copied' : '复制失败 · Failed';
      setTimeout(function () { btn.textContent = '复制诊断信息 · Copy'; }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      done(ok);
    }
  });
})();
</script>
</body>
</html>`
}

function replyBlocked(ip: string, req: FastifyRequest, reply: FastifyReply): void {
  blockedCount++
  lastBlockedIp = ip
  const wantsHtml = req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')
  if (wantsHtml) {
    void reply.code(403).header('content-type', 'text/html; charset=utf-8').send(blockPageHtml(ip))
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
