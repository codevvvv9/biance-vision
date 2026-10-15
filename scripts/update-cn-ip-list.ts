/**
 * 拉取最新中国大陆 IPv4 名单，原子写入 server/data/cn-ip-list.txt（地域封锁的数据源）
 *
 * 用法：
 *   pnpm geo:update
 *
 * - 主源 GitHub raw，失败自动回退 jsdelivr 镜像（国内本机执行时更稳）
 * - 条目数 < 1000 视为源异常，拒绝覆盖现有名单
 * - 服务器上没有 node：用 deploy/oracle 与 deploy/vps 两份 README「地域封锁」一节的 cron + curl 等价命令；
 *   app 进程每 60s 检测文件 mtime，更新后自动热加载，无需重启
 */
import fs from 'node:fs'
import path from 'node:path'

const SOURCES = [
  'https://raw.githubusercontent.com/17mon/china_ip_list/master/china_ip_list.txt',
  'https://cdn.jsdelivr.net/gh/17mon/china_ip_list@master/china_ip_list.txt',
]
const OUT = path.resolve('server/data/cn-ip-list.txt')
const MIN_ENTRIES = 1000
const CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/

async function main(): Promise<void> {
  for (const url of SOURCES) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
      const valid = lines.filter((l) => CIDR_RE.test(l))
      if (valid.length < MIN_ENTRIES) {
        throw new Error(`有效条目过少（${valid.length}/${lines.length}），疑似源异常`)
      }
      fs.mkdirSync(path.dirname(OUT), { recursive: true })
      const tmp = `${OUT}.tmp`
      fs.writeFileSync(tmp, `${valid.join('\n')}\n`)
      fs.renameSync(tmp, OUT)
      console.log(`✓ 已更新 ${OUT}：${valid.length} 条 CIDR（来源 ${url}）`)
      return
    } catch (err) {
      console.warn(`✗ ${url} 失败：${(err as Error).message}`)
    }
  }
  console.error('全部来源失败，保留现有名单不变')
  process.exit(1)
}

await main()
