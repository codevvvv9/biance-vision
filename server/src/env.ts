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

// ---- 启动期配置校验（必须在 .env 合并之后、所有业务模块副作用之前）----
// 放在这里而非 index.ts 主体：本模块是入口 import 列表第一位，先于 alerts.ts 等
// 在模块顶层写文件的依赖执行——非法配置在触碰任何数据前就拒绝启动。
// ❗必须为正整数：Number('abc')=NaN 会让阈值比较恒为假，限速/锁定被静默关闭。
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const v = Number(raw)
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`环境变量 ${name} 非法（"${raw}"）：必须为正整数——安全阈值不允许静默失效，拒绝启动`)
  }
  return v
}

/** 登录限速：每分钟失败上限 / 锁定阈值（env 可覆盖；scripts/login-regression.ts 注入小值） */
export const LOGIN_MAX_PER_WINDOW = positiveIntEnv('LOGIN_MAX_PER_WINDOW', 5)
export const LOGIN_LOCK_FAILS = positiveIntEnv('LOGIN_LOCK_FAILS', 10)
