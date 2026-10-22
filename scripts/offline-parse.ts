/**
 * 离线解析上传脚本（R2 多路径兜底，rag-pipeline-design §3.7）
 *
 * 在本地 Mac 上用重型解析引擎（MinerU / Docling 完整版）解析复杂 PDF，
 * 把产物转换为标准 ParsedBlock[] 后上传到线上 import-parsed 端点。
 *
 * 用法：
 *   pnpm offline:parse <本地PDF路径> [--title 标题] [--tier community] [--access public] [--engine mineru|docling]
 *
 * 环境要求：
 *   - MinerU 已安装（pip install magic-pdf[full]）或 Docling 完整版
 *   - 线上管理域名可达 + Basic Auth 凭据（BV_ADMIN_URL/BV_BASIC_USER/BV_BASIC_PASS）
 *
 * 本脚本不直接调 MinerU Python 库（避免 TS→Python 桥接复杂度），而是：
 *   1. 调用 `mineru` CLI 命令（或 python -m magic_pdf）解析 PDF → content_list.json
 *   2. 读取 content_list.json 转换为 ParsedBlock[]
 *   3. multipart 上传原文件 + blocks 到 import-parsed 端点
 */
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'

interface ParsedBlock {
  kind: 'text' | 'figure' | 'table' | 'heading'
  text?: string
  pageNo?: number
  figureId?: string
  level?: number
}

interface MinerUContentItem {
  type: 'text' | 'image' | 'table' | 'equation'
  text?: string
  page_idx?: number
  img_path?: string
  table_caption?: string
  text_level?: number
}

const args = process.argv.slice(2)
const pdfPath = args[0]
if (!pdfPath || !existsSync(pdfPath)) {
  console.error('用法: pnpm offline:parse <PDF路径> [--title 标题] [--engine mineru|docling]')
  process.exit(1)
}

const getFlag = (name: string, fallback = ''): string => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const title = getFlag('title', path.basename(pdfPath, '.pdf'))
const engine = getFlag('engine', 'mineru')
const adminUrl = process.env.BV_ADMIN_URL ?? 'https://btcpilot-admin.duckdns.org'
const basicUser = process.env.BV_BASIC_USER ?? 'bvadmin'
const basicPass = process.env.BV_BASIC_PASS

if (!basicPass) {
  console.error('缺少 BV_BASIC_PASS 环境变量（管理域名 Basic Auth 密码）')
  process.exit(1)
}

console.log(`\n━━ 离线解析上传（${engine}）`)
console.log(`  PDF: ${pdfPath}`)
console.log(`  标题: ${title}`)
console.log(`  上传: ${adminUrl}/api/admin/knowledge/documents/import-parsed\n`)

// ---- 步骤 1：解析 PDF ----
const outputDir = `/tmp/bv-offline-${Date.now()}`
let contentListPath = ''

if (engine === 'mineru') {
  console.log('  [1/3] 调用 MinerU 解析（可能需要数分钟）…')
  try {
    execSync(`mineru -p "${pdfPath}" -o "${outputDir}"`, { stdio: 'inherit', timeout: 600_000 })
    // MinerU 输出结构：{outputDir}/{md5}/auto/{name}_content_list.json
    const findJson = execSync(`find "${outputDir}" -name "*content_list.json" | head -1`).toString().trim()
    if (!findJson) throw new Error('MinerU 未产出 content_list.json')
    contentListPath = findJson
  } catch (err) {
    console.error(`  MinerU 解析失败：${(err as Error).message}`)
    console.error('  请确认已安装：pip install magic-pdf[full]')
    process.exit(1)
  }
} else {
  console.error(`  引擎 ${engine} 暂不支持（当前仅 mineru；docling 本地可用在线端点无需离线）`)
  process.exit(1)
}

// ---- 步骤 2：转换为 ParsedBlock[] ----
console.log('  [2/3] 转换为 ParsedBlock[]…')
const contentList: MinerUContentItem[] = JSON.parse(readFileSync(contentListPath, 'utf8'))
const blocks: ParsedBlock[] = contentList
  .filter((item) => item.text !== undefined || item.type === 'image')
  .map((item) => {
    if (item.type === 'image') {
      return { kind: 'figure' as const, text: undefined, pageNo: (item.page_idx ?? 0) + 1, figureId: item.img_path }
    }
    if (item.type === 'table') {
      return { kind: 'table' as const, text: item.table_caption ?? item.text, pageNo: (item.page_idx ?? 0) + 1 }
    }
    // MinerU text_level >0 表示标题层级
    if (item.text_level && item.text_level > 0) {
      return { kind: 'heading' as const, text: item.text, pageNo: (item.page_idx ?? 0) + 1, level: item.text_level }
    }
    return { kind: 'text' as const, text: item.text, pageNo: (item.page_idx ?? 0) + 1 }
  })
console.log(`  转换完成：${blocks.length} blocks（heading ${blocks.filter(b => b.kind === 'heading').length} / text ${blocks.filter(b => b.kind === 'text').length} / table ${blocks.filter(b => b.kind === 'table').length} / figure ${blocks.filter(b => b.kind === 'figure').length}）`)

// 保存 blocks 供检查
const blocksPath = `${outputDir}/blocks.json`
writeFileSync(blocksPath, JSON.stringify(blocks, null, 2))
console.log(`  blocks 已保存: ${blocksPath}（可人工检查后手动上传）`)

// ---- 步骤 3：上传到 import-parsed ----
console.log('  [3/3] 上传到 import-parsed 端点…')
// 用原生 fetch + FormData 上传 multipart（Node 22 内置）
const formData = new FormData()
const fileBuffer = readFileSync(pdfPath)
formData.append('file', new Blob([fileBuffer]), path.basename(pdfPath))
formData.append('blocks', JSON.stringify(blocks))
formData.append('parseMeta', JSON.stringify({ parser: `mineru-offline`, engine, contentListPath }))
formData.append('title', title)
formData.append('sourceTier', getFlag('tier', 'community'))
formData.append('access', getFlag('access', 'public'))

const authHeader = 'Basic ' + Buffer.from(`${basicUser}:${basicPass}`).toString('base64')
// 先登录获取 session cookie
const loginRes = await fetch(`${adminUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: authHeader },
  body: JSON.stringify({ username: process.env.BV_ADMIN_USER ?? 'admin', password: process.env.BV_ADMIN_PASS ?? 'ADMIN' }),
})
if (!loginRes.ok) {
  console.error(`  登录失败: ${loginRes.status}`)
  process.exit(1)
}
const cookies = loginRes.headers.get('set-cookie')?.split(';')[0] ?? ''

const uploadRes = await fetch(`${adminUrl}/api/admin/knowledge/documents/import-parsed`, {
  method: 'POST',
  headers: { cookie: cookies, authorization: authHeader },
  body: formData,
})
const uploadData = await uploadRes.json().catch(() => ({}))
if (!uploadRes.ok) {
  console.error(`  上传失败: ${uploadRes.status}`, JSON.stringify(uploadData))
  process.exit(1)
}
console.log(`\n✔ 离线导入成功：${JSON.stringify(uploadData)}\n`)
