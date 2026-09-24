/**
 * 修改登录用户密码（写入 users.json 镜像 + PostgreSQL，热加载无需重启）
 *
 * 用法：
 *   pnpm user:passwd <用户名> [新密码]
 *
 * - 新密码省略时自动生成 12 位随机密码并打印（仅此一次，请妥善保存）
 * - 修改成功后该用户的所有登录会话立即失效，需要用新密码重新登录
 */
import crypto from 'node:crypto'
import { initUsers, updatePassword } from '../server/src/users.js'

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const username = positional[0]
const password = positional[1]

function usage(): never {
  console.log('用法：pnpm user:passwd <用户名> [新密码]')
  console.log('  新密码省略时自动生成 12 位随机密码')
  process.exit(1)
}

if (!username || username.startsWith('--')) usage()

const finalPassword = password ?? crypto.randomBytes(9).toString('base64url')

try {
  await initUsers()
  updatePassword(username, finalPassword)
} catch (err) {
  console.error(`✗ 修改失败：${(err as Error).message}`)
  process.exit(1)
}

console.log(`✓ 已修改用户 ${username} 的密码`)
if (!password) console.log(`  新密码：${finalPassword}（仅显示这一次，请妥善保存）`)
console.log('  已写入 server/data/users.json（PostgreSQL 可用时同步写入）。')
console.log('  该用户的所有登录会话已失效，需用新密码重新登录；正在运行的服务无需重启。')
