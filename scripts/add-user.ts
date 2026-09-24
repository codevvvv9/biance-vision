/**
 * 新增登录用户（写入 users.json 镜像 + PostgreSQL，正在运行的服务会热加载，无需重启）
 *
 * 用法：
 *   pnpm user:add <用户名> [密码] [--super]
 *
 * - 密码省略时自动生成 12 位随机密码并打印（仅此一次，请妥善保存）
 * - --super 创建超级管理员，默认为普通用户
 */
import crypto from 'node:crypto'
import { createUser, initUsers } from '../server/src/users.js'
import type { UserRole } from '../server/src/users.js'

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const superFlag = args.some((a) => a === '--super' || a === '--superadmin')
const username = positional[0]
const password = positional[1]

function usage(): never {
  console.log('用法：pnpm user:add <用户名> [密码] [--super]')
  console.log('  --super   创建超级管理员（默认普通用户）')
  console.log('  密码省略时自动生成 12 位随机密码')
  process.exit(1)
}

if (!username || username.startsWith('--')) usage()

const role: UserRole = superFlag ? 'superadmin' : 'user'
const finalPassword = password ?? crypto.randomBytes(9).toString('base64url')

try {
  await initUsers()
  createUser(username, finalPassword, role)
} catch (err) {
  console.error(`✗ 添加失败：${(err as Error).message}`)
  process.exit(1)
}

console.log(`✓ 用户已创建：${username}（${role === 'superadmin' ? '超级管理员' : '普通用户'}）`)
if (!password) console.log(`  初始密码：${finalPassword}（仅显示这一次，请妥善保存）`)
console.log('  已写入 server/data/users.json（PostgreSQL 可用时同步写入），正在运行的服务会自动热加载，无需重启。')
