/**
 * 用户级聊天管控（chatPolicy）的锚定校验：
 * - normalizeChatPolicy 归一（缺省 / 非法 dailyLimit / 正常值）
 * - checkChatAllowed 纯决策（禁用 403 chat_disabled / 超限 429 chat_limit_exceeded / 放行）
 * - recordChatMessage ↔ getChatUsageToday 跨天归零（预置昨日计数文件，今日读取应为 0）
 *
 * chatPolicy 模块在 import 时 loadJson 读取 server/data/chat-usage.json——
 * 本脚本先备份原文件、写入昨日假数据，再动态 import；结束时 finally 恢复原文件，不污染真实数据。
 * 运行：pnpm chat:policy-check
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const USAGE_FILE = path.join(__dirname, '..', 'server', 'data', 'chat-usage.json')

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

function expectThrow(fn: () => void, statusCode: number, code: string, msg: string): void {
  try {
    fn()
    assert(false, `${msg}（未抛错）`)
  } catch (err) {
    const e = err as { statusCode?: number; code?: string }
    assert(e.statusCode === statusCode && e.code === code, `${msg}（${statusCode} ${code}）`)
  }
}

// 备份原文件（不存在记 null，结束时删除脚本产生的文件）
const original = fs.existsSync(USAGE_FILE) ? fs.readFileSync(USAGE_FILE) : null
// 预置「昨日」计数：跨天读取必须归零（北京时间自然日口径）
fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true })
fs.writeFileSync(USAGE_FILE, JSON.stringify({ date: '2000-01-01', counts: { __check_user__: 7 } }))

try {
  const { normalizeChatPolicy, checkChatAllowed, assertChatAllowed, getChatUsageToday, recordChatMessage } = await import(
    '../server/src/chatPolicy.js'
  )

  console.log('\n[chatPolicy] normalizeChatPolicy 归一')
  {
    const d = normalizeChatPolicy(undefined)
    assert(d.disabled === false && d.dailyLimit === null, '缺省（旧数据无字段）= 不禁不限')
    const bad = normalizeChatPolicy({ chatPolicy: { disabled: true, dailyLimit: 0 } })
    assert(bad.disabled === true && bad.dailyLimit === null, 'dailyLimit=0（非正数）归一为 null，disabled 保留')
    const neg = normalizeChatPolicy({ chatPolicy: { disabled: false, dailyLimit: -3 } })
    assert(neg.dailyLimit === null, 'dailyLimit 负数归一为 null')
    const ok = normalizeChatPolicy({ chatPolicy: { disabled: false, dailyLimit: 20 } })
    assert(ok.dailyLimit === 20, '正常正整数 dailyLimit 原样保留')
  }

  console.log('\n[chatPolicy] checkChatAllowed 纯决策')
  {
    expectThrow(() => checkChatAllowed({ disabled: true, dailyLimit: null }, 0), 403, 'chat_disabled', '禁用 → 403 chat_disabled')
    expectThrow(() => checkChatAllowed({ disabled: false, dailyLimit: 3 }, 3), 429, 'chat_limit_exceeded', '计数达上限（3/3）→ 429 chat_limit_exceeded')
    expectThrow(() => checkChatAllowed({ disabled: false, dailyLimit: 3 }, 5), 429, 'chat_limit_exceeded', '计数超上限（5/3）→ 429')
    try {
      checkChatAllowed({ disabled: false, dailyLimit: 3 }, 2)
      assert(true, '未达上限（2/3）→ 放行')
    } catch {
      assert(false, '未达上限（2/3）→ 放行（被误拦）')
    }
    try {
      checkChatAllowed({ disabled: false, dailyLimit: null }, 9999)
      assert(true, 'dailyLimit=null 不限 → 放行')
    } catch {
      assert(false, 'dailyLimit=null 不限 → 放行（被误拦）')
    }
    // 禁用优先于上限（禁用用户恒定 403，而非 429）
    expectThrow(() => checkChatAllowed({ disabled: true, dailyLimit: 1 }, 99), 403, 'chat_disabled', '禁用且超限 → 403 优先于 429')
  }

  console.log('\n[chatPolicy] 跨天归零与计数（假数据 date=2000-01-01）')
  {
    assert(getChatUsageToday('__check_user__') === 0, '昨日计数 7 今日读取 → 0（跨天归零）')
    recordChatMessage('__check_user__')
    assert(getChatUsageToday('__check_user__') === 1, 'recordChatMessage 后今日计数 = 1（同日追加）')
    recordChatMessage('__check_user__')
    assert(getChatUsageToday('__check_user__') === 2, '再次计数 = 2（单调递增）')
    // 未知用户按默认策略放行（会话层已校验用户存在）
    try {
      assertChatAllowed('__check_no_such_user__')
      assert(true, '未知用户 → 默认策略放行')
    } catch {
      assert(false, '未知用户 → 默认策略放行（被误拦）')
    }
  }
} finally {
  // 恢复原文件，不污染真实用量数据
  if (original !== null) fs.writeFileSync(USAGE_FILE, original)
  else fs.rmSync(USAGE_FILE, { force: true })
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
