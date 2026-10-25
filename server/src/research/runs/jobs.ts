/**
 * 研究运行队列任务与到期结算任务。
 * - research:run：worker 消费 → executeRun（固定流水线）
 * - event:settle：周期扫描已到期且未估算的报价 → 用库内指数价做研究估算
 *   （estimatedOutcome 与用户确认 userConfirmedOutcome 互不覆盖，分别统计）
 */
import type PgBoss from 'pg-boss'
import { and, eq, isNull, lt } from 'drizzle-orm'
import { Q_EVENT_SETTLE, Q_RESEARCH_RUN, getBoss } from '../../queue.js'
import { getDb } from '../../db.js'
import { eventQuotes, predictions } from '../../models.js'
import { readCandles } from '../../market/read.js'
import { executeRun } from './runner.js'
import { kv, log } from '../../logger.js'
import { pickExpiryClose } from '../event/calc.js'

/**
 * 队列载荷的类型化可选观测字段（P2a-2，方案 §9.3）：创建任务时 originRequestId
 * 取创建请求的 requestId（前端报障编号 → API 日志 → job → worker 日志全链同号）；
 * 旧任务缺字段时 worker 生成来源编号并标 legacy，不清空队列。
 */
export type ResearchRunJob = {
  runId: string
  observability?: { originRequestId?: string; release?: string }
}

export async function enqueueResearchRun(runId: string, observability?: ResearchRunJob['observability']): Promise<boolean> {
  const boss = getBoss()
  if (!boss) return false
  await boss.send(Q_RESEARCH_RUN, { runId, observability } satisfies ResearchRunJob, {
    singletonKey: `research-run:${runId}`,
    singletonSeconds: 300,
  })
  return true
}

/** 到期结算：估算已到期未结算报价（指数价 vs 执行价）；worker 周期调用，smoke 直接调用 */
export async function settleExpiredQuotes(): Promise<void> {
  const db = getDb()
  if (!db) return
  const rows = await db
    .select()
    .from(eventQuotes)
    .where(and(lt(eventQuotes.expiryAt, Date.now() - 60_000), isNull(eventQuotes.estimatedOutcome)))
    .limit(100)
  for (const q of rows) {
    try {
      // 事件合约结算研究估算：到期时刻的指数价 vs 执行价（永续指数价序列）
      const candles = await readCandles({
        marketType: 'usdm_perp',
        priceType: 'index',
        symbol: q.symbol,
        interval: '1m',
        to: q.expiryAt,
        asOf: q.expiryAt,
        limit: 5,
      })
      if (candles.length === 0) continue
      const price = pickExpiryClose(candles, q.expiryAt, 60_000)
      if (price === null) {
        log.warn('research', '到期分钟行情缺口，跳过估算（待补洞后重试）', kv({ 报价: q.id.slice(0, 8), 到期: q.expiryAt, 最近收盘: candles[candles.length - 1].closeTime }))
        continue
      }
      const strike = Number(q.strikePrice)
      const outcome = price > strike ? 'above' : price < strike ? 'below' : 'tie'
      await db
        .update(eventQuotes)
        .set({ estimatedOutcome: outcome, updatedAt: new Date() })
        .where(eq(eventQuotes.id, q.id))
      await db
        .update(predictions)
        .set({ estimatedOutcome: outcome, outcomeSource: 'estimated', status: 'estimated', resolvedAt: Date.now() })
        .where(and(eq(predictions.quoteId, q.id), isNull(predictions.userConfirmedOutcome)))
      log.info('research', '报价到期研究估算', kv({ 报价: q.id.slice(0, 8), 到期价: price, 执行价: strike, 结果: outcome }))
    } catch (err) {
      log.warn('research', '报价到期估算失败（下轮重试）', kv({ 报价: q.id.slice(0, 8), 错误: (err as Error).message }))
    }
  }
}

export async function registerResearchWorkers(boss: PgBoss): Promise<void> {
  await boss.work<ResearchRunJob>(Q_RESEARCH_RUN, async (jobs) => {
    for (const job of jobs) {
      // P2a-2：来源关联——payload 带 originRequestId 用之；旧任务生成 worker 来源
      // 编号并标 legacy（每任务一个编号，不与 API requestId 混用）
      const originRequestId = job.data.observability?.originRequestId ?? `legacy-${job.id.slice(0, 8)}`
      try {
        log.info('research', '研究任务开始', kv({ run: job.data.runId.slice(0, 8), 来源请求: originRequestId, jobId: job.id.slice(0, 8), 尝试: (job as unknown as { attempts?: number }).attempts !== undefined ? (job as unknown as { attempts: number }).attempts + 1 : 1 }))
        await executeRun(job.data.runId)
      } catch (err) {
        log.error('research', '研究运行失败', kv({ run: job.data.runId.slice(0, 8), 来源请求: originRequestId, jobId: job.id.slice(0, 8), 尝试: (job as unknown as { attempts?: number }).attempts !== undefined ? (job as unknown as { attempts: number }).attempts + 1 : 1, 错误: (err as Error).message }))
      }
    }
  })
  await boss.work(Q_EVENT_SETTLE, async () => {
    await settleExpiredQuotes()
  })
  await boss.schedule(Q_EVENT_SETTLE, '*/10 * * * *')
}
