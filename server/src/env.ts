/**
 * server/.env 加载（本地源码进程用；容器内经 compose environment 注入、无此文件，自动跳过）。
 * 逐行 KEY=VALUE 解析（支持引号与 export 前缀），不覆盖已有环境变量——显式 shell / 容器注入优先。
 * 必须保持在入口文件 import 列表的第一位：其余模块在模块顶层读取 process.env 前已生效。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
try {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || process.env[m[1]] !== undefined) continue
    const raw = m[2]
    const quoted =
      raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    process.env[m[1]] = quoted ? raw.slice(1, -1) : raw
  }
} catch {
  /* .env 不存在（容器 / 最小部署）：仅用进程环境变量 */
}
