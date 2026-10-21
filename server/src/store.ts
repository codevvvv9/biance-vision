import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 数据目录可经 BV_DATA_DIR 覆盖：scripts/login-regression.ts 注入临时目录隔离
// users/sessions 等文件态数据（不与开发服务的 server/data 互写）；默认与历史一致
export const DATA_DIR = process.env.BV_DATA_DIR || path.join(__dirname, '..', 'data')

export function loadJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')) as T
  } catch {
    return fallback
  }
}

export function saveJson(file: string, data: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const target = path.join(DATA_DIR, file)
  const tmp = `${target}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, target)
  } catch (err) {
    log.error('store', `写入 ${file} 失败：`, err)
    throw err
  }
}
