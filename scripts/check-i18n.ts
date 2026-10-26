#!/usr/bin/env node
/**
 * i18n 防回归检查（方案 Part 1 §1.6）：
 * 1. 扫描 web/src 下所有 .ts/.tsx 中字符串字面量与 JSX 文本里的 CJK 字符，
 *    白名单豁免（注释、词典文件、双语术语表、服务端 fact 契约前缀匹配等），
 *    输出剩余未迁移文案清单；--strict 时非零退出（CI 用）。
 * 2. 词典一致性：zh-CN 与 en-US 同命名空间的 key 集合必须一致（缺 key 会
 *    fallback 中文不出空白，但会漏翻译——提前暴露）。
 *
 * 用法：pnpm check:i18n [-- --strict]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
// W3-S1：i18n/locales 已下沉 @biance/shared-ui，扫描覆盖两端源码根
const SCAN_ROOTS = [path.join(ROOT, 'web/src'), path.join(ROOT, 'packages/shared-ui/src')]
const WEB_SRC = SCAN_ROOTS[0]
const LOCALES = path.join(ROOT, 'packages/shared-ui/src/locales')

const strict = process.argv.includes('--strict')

/** 豁免文件（相对 web/src）：双语数据源/服务端契约匹配/装饰性图形字符场景 */
const EXEMPT_FILES = new Set([
  'brooks/terms.tsx', // 双语术语词典本体（zh key 索引 + 双语字段）
  'locales', // 词典目录（整目录豁免）
])

/** 豁免的行内模式（服务端 fact 契约前缀匹配等，中文为协议常量而非 UI 文案） */
const EXEMPT_LINE_RE: RegExp[] = [
  // 「常量即词典 key」声明行（admin 词典策略）：`键: '中文值',` 的纯常量赋值——
  // 值是 t() 的 key 数据源（渲染处 t(META[k].label) 包裹），不是待迁移 UI 文案
  /^\s*[A-Za-z_][\w]*\s*:\s*\{?\s*(label|hint|title|desc|sourceNote|placeholder)?\s*:?\s*'[^']*\u4e00-\u9fa5[^']*'\s*(,\s*\}\s*)?,?\s*$/,
  /周期冲突/, // 服务端 structure fact 的前缀匹配契约（ResearchPage mtf 条）
  /：状态 /, // 同上：服务端 fact 文本结构匹配
  /term="[^"]*[\u4e00-\u9fff][^"]*"/, // BrooksTerm 的 term prop：BROOKS_TERMS 中文索引 key（数据，非显示文案）
]

const CJK_RE = /[\u4e00-\u9fff]/

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (/\.(ts|tsx)$/.test(name)) yield full
  }
}

/** 粗剥离注释：块注释/行注释整行剔除后仍含 CJK 才算文案 */
function stripComments(src: string): string[] {
  const out: string[] = []
  let inBlock = false
  for (const raw of src.split('\n')) {
    let line = raw
    if (inBlock) {
      const end = line.indexOf('*/')
      if (end === -1) continue
      line = line.slice(end + 2)
      inBlock = false
    }
    // 残余块注释头
    line = line.replace(/\/\*[\s\S]*?\*\//g, '')
    if (line.includes('/*')) {
      inBlock = true
      line = line.slice(0, line.indexOf('/*'))
    }
    line = line.replace(/(^|[^:])\/\/.*$/, '$1')
    if (line.trim() !== '') out.push(line)
  }
  return out
}

let total = 0
for (const root of SCAN_ROOTS) {
  for (const file of walk(root)) {
    const rel = path.relative(root, file)
    const display = path.relative(ROOT, path.join(root, rel))
    if (EXEMPT_FILES.has(rel) || rel.startsWith('locales') || rel.startsWith('i18n')) continue
    const lines = stripComments(readFileSync(file, 'utf8'))
    const hits: string[] = []
    lines.forEach((line, i) => {
      // 中文即 key（admin 词典策略）：t('..中文..') 调用内的中文是词典 key，视为已迁移
      const stripped = line.replace(/\bt{1,2}\('[^']*'/g, '').replace(/\bt{1,2}\("[^"]*"/g, '')
      if (!CJK_RE.test(stripped)) return
      if (EXEMPT_LINE_RE.some((re) => re.test(line))) return
      hits.push(`  ${display}:${i + 1}: ${line.trim().slice(0, 100)}`)
    })
    if (hits.length > 0) {
      total += hits.length
      console.log(hits.join('\n'))
    }
  }
}

// ---- 词典一致性 ----
function flatKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix === '' ? k : `${prefix}.${k}`
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) keys.push(...flatKeys(v as Record<string, unknown>, key))
    else keys.push(key)
  }
  return keys
}

let keyMismatch = 0
for (const ns of readdirSync(path.join(LOCALES, 'zh-CN'))) {
  const zh = JSON.parse(readFileSync(path.join(LOCALES, 'zh-CN', ns), 'utf8'))
  const enPath = path.join(LOCALES, 'en-US', ns)
  if (!existsSync(enPath)) {
    console.log(`[dict] en-US 缺少命名空间文件: ${ns}`)
    keyMismatch++
    continue
  }
  const en = JSON.parse(readFileSync(enPath, 'utf8'))
  const zhKeys = new Set(flatKeys(zh))
  const enKeys = new Set(flatKeys(en))
  const missingEn = [...zhKeys].filter((k) => !enKeys.has(k))
  const missingZh = [...enKeys].filter((k) => !zhKeys.has(k))
  if (missingEn.length > 0) {
    console.log(`[dict] ${ns}: en-US 缺 key → ${missingEn.join(', ')}`)
    keyMismatch += missingEn.length
  }
  if (missingZh.length > 0) {
    console.log(`[dict] ${ns}: zh-CN 缺 key → ${missingZh.join(', ')}`)
    keyMismatch += missingZh.length
  }
}

// ---- admin key 存在性（v0.18.2 后加：2026-10-26 队列页词条漏录，线上满屏回显 ui.colQueue）----
// 扫 admin 目录三种字面量用法，逐一校验 zh-CN admin 词典存在（en 一致性已由上一节覆盖）：
//   text("k")        → ui.k          （useAdminText 封装）
//   t("group.k")     → group.k       （group 须为 admin 词典顶层组）
//   "menu.k" 字面量  → menu.k        （routes.tsx labelKey/hintKey）
// 非字面量（动态拼接）无法静态断言，跳过；key 缺失属线上可见 bug，硬失败。
let missingKeys = 0
{
  const adminDir = path.join(WEB_SRC, 'admin')
  const zhAdmin = JSON.parse(readFileSync(path.join(LOCALES, 'zh-CN', 'admin.json'), 'utf8'))
  const known = new Set(flatKeys(zhAdmin))
  const groups = new Set(Object.keys(zhAdmin))
  for (const file of walk(adminDir)) {
    const display = path.relative(ROOT, file)
    const src = readFileSync(file, 'utf8')
    const used: string[] = []
    for (const m of src.matchAll(/\btext\(\s*(['"])([A-Za-z][A-Za-z0-9_]*)\1\s*[,)]/g)) used.push(`ui.${m[2]}`)
    for (const m of src.matchAll(/\bt\(\s*(['"])([a-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]+)\1\s*[,)]/g))
      if (groups.has(m[2])) used.push(`${m[2]}.${m[3]}`)
    for (const m of src.matchAll(/(['"])menu\.([A-Za-z0-9_]+)\1/g)) used.push(`menu.${m[2]}`)
    for (const key of used)
      if (!known.has(key)) {
        console.log(`[admin-key] ${display}: 词典缺 key → ${key}`)
        missingKeys++
      }
  }
}

console.log('---')
console.log(`未迁移文案行: ${total}（波次4 admin/AiSettingsModal 管理面按方案允许最后迁移）`)
console.log(`词典 key 不一致: ${keyMismatch}`)
console.log(`admin 词典缺 key: ${missingKeys}`)
if (keyMismatch > 0 || missingKeys > 0) process.exit(1)
if (strict && total > 0) process.exit(1)
