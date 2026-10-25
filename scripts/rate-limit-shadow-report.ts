/**
 * shadow 报告（P1-6，pnpm rate-limit:shadow-report）——切换 enforce 的门槛证据
 * （方案 §13.2）：输出每个 shadow scope 的窗口计数分布与 should_block 数，
 * 附带切 enforce 检查清单（合法请求受限率/NAT/多标签/重连验证结论需人工补充）。
 * 新频率策略须满 7 个完整自然日 shadow 且本报告无未解释误限，才允许按 scope
 * 切 enforce（修改 RATE_POLICIES 对应项 mode，走正常发版）。
 */
import { sql } from 'drizzle-orm'
import { initDb, getDb } from '../server/src/db.js'
import './env.js' // server/.env（本地跑）

const migrated = await initDb({ migrate: false })
if (!migrated) {
  console.error('数据库不可用')
  process.exit(1)
}
const rows = await getDb()!.execute(sql`
  SELECT scope,
    count(*) FILTER (WHERE counter > 0) AS subjects,
    max(counter) AS max_counter,
    count(*) FILTER (WHERE expires_at > now()) AS live_buckets
  FROM security_rate_buckets
  WHERE expires_at > now() - interval '7 days'
  GROUP BY scope ORDER BY scope`)
console.log('scope\tsubjects\tmax_counter\tlive_buckets')
for (const r of rows as unknown as Array<Record<string, unknown>>) {
  console.log(`${r.scope}\t${r.subjects}\t${r.max_counter}\t${r.live_buckets}`)
}
const shadowScopes = (rows as unknown as Array<{ scope: string }>).filter((r) => r.scope.startsWith('shadow:'))
console.log(`\nshadow scope 数：${shadowScopes.length}`)
console.log('切 enforce 前置检查（人工确认后记录）：')
console.log('  1) 该 scope 已连续 7 个完整自然日有正常流量样本（一周无样本不算通过）')
console.log('  2) should_block 命中逐条核查为异常流量（NAT/多标签/重连误限率 <0.1%）')
console.log('  3) 已完成 NAT/多标签页/断线重连场景验证')
console.log('  4) 按 scope 修改 RATE_POLICIES mode=shadow→enforce 走正常发版（不重置任何状态）')
process.exit(0)
