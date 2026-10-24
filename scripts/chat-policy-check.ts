/**
 * 用户级聊天管控（chatPolicy）的锚定校验：
 * - normalizeChatPolicy 归一（缺省 / 非法 dailyLimit / 正常值）
 * - checkChatAllowed 纯决策（禁用 403 chat_disabled / 超限 429 chat_limit_exceeded / 放行）
 * - rollUsage 跨天滚动（纯函数；存储层自 v0.16.2 起入 PG app_settings，
 *   PG 往返由登录回归/双入口自测在真实链路覆盖，本脚本只锚定决策与滚动语义）
 * 运行：pnpm chat:policy-check
 */
import { checkChatAllowed, normalizeChatPolicy, rollUsage } from '../server/src/chatPolicy.js'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
    console.log(`  ✅ PASS  ${msg}`)
  } else {
    failed++
    console.error(`  ❌ FAIL  ${msg}`)
  }
}

function expectThrow(fn: () => void, status: number, code: string, msg: string): void {
  try {
    fn()
    assert(false, `${msg}（未抛出）`)
  } catch (e) {
    const err = e as { statusCode?: number; code?: string }
    assert(err.statusCode === status && err.code === code, msg)
  }
}

console.log('[chatPolicy] normalizeChatPolicy 归一')
{
  const d = normalizeChatPolicy(undefined)
  assert(d.disabled === false && d.dailyLimit === null, '缺省 = 不禁不限')
  const bad = normalizeChatPolicy({ chatPolicy: { disabled: false, dailyLimit: -3 } })
  assert(bad.dailyLimit === null, '非法 dailyLimit(-3) → null（不限）')
  const ok = normalizeChatPolicy({ chatPolicy: { disabled: true, dailyLimit: 5 } })
  assert(ok.disabled === true && ok.dailyLimit === 5, '正常值原样保留')
}

console.log('\n[chatPolicy] checkChatAllowed 纯决策')
{
  expectThrow(() => checkChatAllowed({ disabled: true, dailyLimit: null }, 0), 403, 'chat_disabled', '禁用 → 403 chat_disabled')
  expectThrow(() => checkChatAllowed({ disabled: false, dailyLimit: 5 }, 5), 429, 'chat_limit_exceeded', '达上限 → 429 chat_limit_exceeded')
  checkChatAllowed({ disabled: false, dailyLimit: 5 }, 4)
  assert(true, '未达上限 → 放行')
  checkChatAllowed({ disabled: false, dailyLimit: null }, 99999)
  assert(true, '不限额 → 任意次数放行')
  expectThrow(() => checkChatAllowed({ disabled: true, dailyLimit: 1 }, 99), 403, 'chat_disabled', '禁用且超限 → 403 优先于 429')
}

console.log('\n[chatPolicy] rollUsage 跨天滚动（纯函数）')
{
  const yesterday = { date: '2000-01-01', counts: { u: 7 } }
  const rolled = rollUsage(yesterday, '2000-01-02')
  assert(rolled.date === '2000-01-02' && Object.keys(rolled.counts).length === 0, '非当日 → 整体归零（跨天重置）')
  const same = rollUsage({ date: '2000-01-02', counts: { u: 3 } }, '2000-01-02')
  assert(same.counts.u === 3, '同日 → 计数保留（同日追加语义）')
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
