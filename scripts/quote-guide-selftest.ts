/**
 * 缺输入引导闭环自测（2026-10-19 A/B/C 三层修复）：
 * - A 路由：纯结构问句不落 event 产品线（isStructureOnlyQuestion）
 * - B 追问：口述报价提取/槽位缺项判定 + quote_missing/quote_recorded 模板经组装器不降级
 * - C 兜底：QUOTE_GUIDANCE 四条挂在 missing_quote 载荷（契约层由 typecheck 保证）
 * 纯函数级验证，不连库不起服务。用法：pnpm quote-guide:selftest
 */
import { classifyIntent, extractQuoteDraft, missingQuoteFields, isStructureOnlyQuestion } from '../server/src/research/runs/conversation.js'
import { assembleTrustedReply } from '../server/src/research/runs/replyAssembler.js'

let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${name}${detail !== '' ? ` —— ${detail}` : ''}`)
  }
}

console.log('== A 路由修正：纯结构问句判定 ==')
check('截图 case：结构偏向问句 = 纯结构', isStructureOnlyQuestion('BTC 未来 10 分钟的结构偏向是什么？'))
check('当前结构如何 = 纯结构', isStructureOnlyQuestion('BTC 现在结构如何'))
check('含事件词不算纯结构（高于）', !isStructureOnlyQuestion('BTC 高于 60000 的概率？结构怎么样'))
check('含事件词不算纯结构（报价）', !isStructureOnlyQuestion('引用报价看看结构'))
check('确定性判 event 的不算纯结构', !isStructureOnlyQuestion('BTC 10 分钟内涨跌的结构面'))
check('不含「结构」二字不算', !isStructureOnlyQuestion('BTC 现在能买吗'))

console.log('== B 追问闭环：口述报价提取 ==')
const full = extractQuoteDraft('BTC 高于 60000，投入 10 返还 17，10 分钟')
check('完整口述五槽位提取', missingQuoteFields(full).length === 0, JSON.stringify(full))
check('方向 above', full.direction === 'above')
check('执行价 60000', full.strikePrice === 60000)
check('投入 10', full.stake === 10)
check('返还 17', full.totalPayout === 17)
check('期限 10m', full.horizon === '10m')
const below = extractQuoteDraft('ETH 低于 3000，投 5 USDT 得 9，1 小时')
check('低于→below', below.direction === 'below')
check('USDT 措辞提取', below.stake === 5 && below.totalPayout === 9, JSON.stringify(below))
const partial = extractQuoteDraft('BTC 高于 60000')
check('只给方向+执行价时缺三项', missingQuoteFields(partial).join(',') === 'stake,totalPayout,horizon', JSON.stringify(partial))
const merged = { ...partial, ...extractQuoteDraft('投 10 返 17') } as ReturnType<typeof extractQuoteDraft>
check('分条消息合并后仍缺期限', missingQuoteFields(merged).join(',') === 'horizon', JSON.stringify(merged))

console.log('== B 追问闭环：模板经可信组装器 ==')
const missingReply = assembleTrustedReply({ key: 'quote_missing', facts: { missingLabels: '投入金额、含本金总返还' } })
check('quote_missing 不降级', !missingReply.degraded, missingReply.checkNotes.join(';'))
check('quote_missing 含缺项与三种继续方式', missingReply.content.includes('投入金额') && missingReply.content.includes('只要结构') && missingReply.content.includes('表单'))
const recordedReply = assembleTrustedReply({
  key: 'quote_recorded',
  facts: { quoteSummary: '高于 60000 / 投入 10 / 返还 17 / 10 分钟到期' },
})
check('quote_recorded 动态数字走 facts 白名单不降级', !recordedReply.degraded, recordedReply.checkNotes.join(';'))
check('quote_recorded 含核对与作废提示', recordedReply.content.includes('作废报价'))
const invalidReply = assembleTrustedReply({ key: 'quote_invalid', facts: { reason: '含本金总返还小于投入金额' } })
check('quote_invalid 不降级且不残留占位', !invalidReply.degraded && !invalidReply.content.includes('{{'), invalidReply.checkNotes.join(';'))

console.log('== 意图分类回归（不破坏现有路由） ==')
check('「预测 BTC 一周涨跌」仍判 structure（方向研究）', classifyIntent('预测 BTCUSDT 一周涨跌') === 'structure')
check('「什么是内包线」仍判 concept', classifyIntent('什么是内包线') === 'concept')
check('「我的多单要止损吗」确定性判 structure（perp 由 LLM 纠偏层负责，自测不连 LLM）', classifyIntent('我的多单要止损吗') === 'structure')
check('「复盘昨天 BTC」仍判 replay', classifyIntent('复盘昨天 BTC 的走势') === 'replay')
check('「高于 60000 值不值」仍判 event', classifyIntent('BTC 高于 60000 值不值得参与') === 'event')

console.log('== 组装器回归（既有模板不受影响） ==')
const started = assembleTrustedReply({
  key: 'run_started',
  facts: { intentLabel: '当前结构', symbol: 'BTCUSDT', horizon: '10m', asOfNote: '', directionNote: '' },
})
check('run_started 仍正常', !started.degraded && started.content.includes('BTCUSDT'), started.checkNotes.join(';'))
const pending = assembleTrustedReply({ key: 'draft_pending', facts: { missingLabels: '数量、开仓价' } })
check('draft_pending 仍正常', !pending.degraded && pending.content.includes('数量'), pending.checkNotes.join(';'))

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
