/**
 * 评测执行器（docs/specs/evaluation-deployment.md，pg-boss 任务 eval:run 消费）：
 * - rag：逐条跑混合检索 → hit@k / MRR（期望 docTitle 关键词命中）
 * - structure：库内窗口因果回放（前缀分析 == 全量分析按 knownAt<=t 截断）通过率
 * - dialog：真实跑研究运行（教学场景）→ 完成率 / 伪造数值违规数（概率块未启用时
 *   声明不得含「概率/胜率=数字%」）/ 必需步骤完成率
 * - replay：历史 asOf 端到端重放 → 发布率 / 未来泄漏数（结构事件 knownAtTime<=asOf）
 */
import { eq, sql } from 'drizzle-orm'
import { analyzeBrooks } from 'biance-vision-brooks'
import { getDb } from '../db.js'
import { evalDatasets, evalRuns, structureEvents } from '../models.js'
import type { EvalDatasetRow } from '../models.js'
import { readCandles } from '../market/read.js'
import { searchHybrid } from '../knowledge/retrieval.js'
import { createRun, getRun } from './runs/store.js'
import { executeRun } from './runs/runner.js'
import { kv, log } from '../logger.js'

interface DialogItem {
  product?: 'perp' | 'event' | 'teaching'
  symbol: string
  marketType?: 'spot' | 'usdm_perp'
  horizon?: '10m' | '30m' | '1h' | '1d' | '1w'
  question?: string
}

interface ReplayItem {
  symbol: string
  marketType?: 'spot' | 'usdm_perp'
  horizon?: '10m' | '30m' | '1h' | '1d' | '1w'
  asOf: number
}

interface RagItem {
  query: string
  /** 期望命中的文档标题关键词（小写包含匹配） */
  expectDocTitle?: string
}

interface StructureItem {
  symbol: string
  marketType: 'spot' | 'usdm_perp'
  interval: string
  from?: number
  to?: number
}

async function evalRag(items: RagItem[]): Promise<{ metrics: Record<string, number>; report: Record<string, unknown> }> {
  const k = 5
  let hits = 0
  let mrrSum = 0
  const details: { query: string; rank: number | null; topTitle: string }[] = []
  for (const item of items) {
    const outcome = await searchHybrid(item.query, { finalLimit: k })
    const titles = outcome.hits.map((h) => h.docTitle.toLowerCase())
    let rank: number | null = null
    if (item.expectDocTitle !== undefined) {
      const idx = titles.findIndex((t) => t.includes(item.expectDocTitle!.toLowerCase()))
      rank = idx >= 0 ? idx + 1 : null
    } else {
      rank = titles.length > 0 ? 1 : null
    }
    if (rank !== null) {
      hits++
      mrrSum += 1 / rank
    }
    details.push({ query: item.query, rank, topTitle: outcome.hits[0]?.docTitle ?? '' })
  }
  const n = Math.max(1, items.length)
  return {
    metrics: { hitAtK: Number((hits / n).toFixed(4)), mrr: Number((mrrSum / n).toFixed(4)), sampleSize: items.length },
    report: { k, details },
  }
}

async function evalStructure(items: StructureItem[]): Promise<{ metrics: Record<string, number>; report: Record<string, unknown> }> {
  let passed = 0
  let checked = 0
  const details: { series: string; ok: boolean; error?: string }[] = []
  for (const item of items) {
    try {
      const candles = await readCandles({
        marketType: item.marketType,
        priceType: 'trade',
        symbol: item.symbol,
        interval: item.interval as '1m',
        from: item.from,
        to: item.to,
        limit: 500,
      })
      const bars = candles.map((c) => ({
        time: c.openTime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: c.volume === null ? undefined : Number(c.volume),
        closed: c.isClosed,
        closeTime: c.closeTime,
      }))
      const full = analyzeBrooks(bars, { swingK: 3 })
      if (full === null) throw new Error('数据不足')
      // 因果回放（对齐 scripts/causality-check.ts [2]）：前缀 [0..t] 的分析
      // 与全量分析按 knownAt<=t 截断逐项相等；抽 5 个锚点，统计通过率
      const anchors = [0.5, 0.6, 0.7, 0.8, 0.9].map((r) => Math.floor(bars.length * r))
      let ok = true
      for (const t of anchors) {
        const prefix = analyzeBrooks(bars.slice(0, t + 1), { swingK: 3 })
        if (prefix === null) continue
        checked++
        const keyOf = (list: unknown[]): string => JSON.stringify(list.sort())
        const truncated = full.events
          .filter((e) => e.knownAtIndex !== null && e.knownAtIndex <= t)
          .map((e) => [e.kind, e.ruleId, e.atIndex, e.knownAtIndex, e.direction ?? null])
        const prefixEvents = prefix.events
          .filter((e) => e.knownAtIndex !== null)
          .map((e) => [e.kind, e.ruleId, e.atIndex, e.knownAtIndex, e.direction ?? null])
        const regimeEq = prefix.regimeAt.every((r2, i) => full.regimeAt[i] === r2)
        if (keyOf(truncated) !== keyOf(prefixEvents) || !regimeEq) {
          ok = false
        }
      }
      if (ok) passed++
      details.push({ series: `${item.symbol}/${item.interval}`, ok })
    } catch (err) {
      details.push({ series: `${item.symbol}/${item.interval}`, ok: false, error: (err as Error).message })
    }
  }
  const n = Math.max(1, items.length)
  return {
    metrics: { seriesConsistency: Number((passed / n).toFixed(4)), anchorChecks: checked, sampleSize: items.length },
    report: { details },
  }
}

/** 对话评测：真实执行研究运行，校验流水线完成、无伪造概率表述 */
async function evalDialog(items: DialogItem[]): Promise<{ metrics: Record<string, number>; report: Record<string, unknown> }> {
  let published = 0
  let fabrication = 0
  let stepsComplete = 0
  const details: { question: string; status: string; claims: number; issue?: string }[] = []
  const fabRe = /(概率|胜率|probability|win rate)\s*[==:：是]?\s*\d+(?:\.\d+)?\s*%/i
  for (const item of items) {
    const run = await createRun({
      userId: 'eval-dialog',
      create: {
        product: item.product ?? 'teaching',
        symbol: item.symbol,
        marketType: item.marketType ?? 'usdm_perp',
        horizon: item.horizon ?? '1h',
        question: item.question,
      },
    })
    try {
      await executeRun(run.id)
    } catch {
      /* 失败计入未发布 */
    }
    const after = await getRun(run.id)
    const status = after?.status ?? 'failed'
    const result = (after?.result ?? null) as { claims?: { text: string; kind: string }[] } | null
    let issue: string | undefined
    if (status === 'published') {
      published++
      if (result?.claims?.some((c) => c.kind !== 'fact' && fabRe.test(c.text))) {
        fabrication++
        issue = '含未经统计模块的概率表述'
      }
      if ((result?.claims?.length ?? 0) > 0) stepsComplete++
    } else {
      issue = after?.error ?? status
    }
    details.push({ question: item.question ?? item.symbol, status, claims: result?.claims?.length ?? 0, issue })
    await cleanupEvalRun(run.id, after?.snapshotId ?? null)
  }
  const n = Math.max(1, items.length)
  return {
    metrics: {
      publishedRate: Number((published / n).toFixed(4)),
      fabricationViolations: fabrication,
      claimsCoverage: Number((stepsComplete / n).toFixed(4)),
      sampleSize: items.length,
    },
    report: { details },
  }
}

/** 回放评测：历史 asOf 端到端重放，检查结构事件无未来泄漏（knownAtTime<=asOf） */
async function evalReplay(items: ReplayItem[]): Promise<{ metrics: Record<string, number>; report: Record<string, unknown> }> {
  const db = getDb()
  let published = 0
  let leaks = 0
  const details: { series: string; status: string; events: number; leak?: number }[] = []
  for (const item of items) {
    const run = await createRun({
      userId: 'eval-replay',
      create: {
        product: 'teaching',
        symbol: item.symbol,
        marketType: item.marketType ?? 'usdm_perp',
        horizon: item.horizon ?? '1h',
        asOf: item.asOf,
      },
    })
    try {
      await executeRun(run.id)
    } catch {
      /* 计入未发布 */
    }
    const after = await getRun(run.id)
    const status = after?.status ?? 'failed'
    let eventCount = 0
    let leakCount = 0
    if (status === 'published' && db && after?.snapshotId) {
      published++
      const rows = await db.select().from(structureEvents).where(eq(structureEvents.snapshotId, after.snapshotId))
      eventCount = rows.length
      leakCount = rows.filter((r) => r.knownAtTime !== null && r.knownAtTime > item.asOf).length
      leaks += leakCount
    }
    details.push({ series: `${item.symbol}@${new Date(item.asOf).toISOString().slice(0, 16)}`, status, events: eventCount, leak: leakCount })
    await cleanupEvalRun(run.id, after?.snapshotId ?? null)
  }
  const n = Math.max(1, items.length)
  return {
    metrics: {
      publishedRate: Number((published / n).toFixed(4)),
      futureLeaks: leaks,
      sampleSize: items.length,
    },
    report: { details },
  }
}

/** 清理评测运行产生的行（步骤/证据→结构事件按快照→运行本体） */
async function cleanupEvalRun(runId: string, snapshotId: string | null): Promise<void> {
  const db = getDb()
  if (!db) return
  await db.execute(sql`delete from run_steps where run_id = ${runId}`)
  await db.execute(sql`delete from evidence_items where run_id = ${runId}`)
  if (snapshotId !== null) {
    await db.execute(sql`delete from structure_events where snapshot_id = ${snapshotId}`)
  }
  await db.execute(sql`delete from research_runs where id = ${runId}`)
}

export async function executeEvalRun(runId: string): Promise<void> {
  const db = getDb()
  if (!db) return
  const runRows = await db.select().from(evalRuns).where(eq(evalRuns.id, runId)).limit(1)
  const run = runRows[0]
  if (!run || run.status !== 'queued') return
  const dsRows = await db.select().from(evalDatasets).where(eq(evalDatasets.id, run.datasetId)).limit(1)
  const dataset: EvalDatasetRow | undefined = dsRows[0]
  await db.update(evalRuns).set({ status: 'running', startedAt: Date.now() }).where(eq(evalRuns.id, runId))
  try {
    if (!dataset) throw new Error(`数据集不存在：${run.datasetId}`)
    const items = dataset.items
    let result: { metrics: Record<string, number>; report: Record<string, unknown> }
    if (dataset.kind === 'rag') {
      result = await evalRag(items as RagItem[])
    } else if (dataset.kind === 'structure') {
      result = await evalStructure(items as StructureItem[])
    } else if (dataset.kind === 'dialog') {
      result = await evalDialog(items as DialogItem[])
    } else if (dataset.kind === 'replay') {
      result = await evalReplay(items as ReplayItem[])
    } else {
      throw new Error(`未知评测类型：${dataset.kind}`)
    }
    await db
      .update(evalRuns)
      .set({ status: 'completed', metrics: result.metrics, report: result.report, endedAt: Date.now() })
      .where(eq(evalRuns.id, runId))
    log.ok('eval', '评测完成', kv({ run: runId.slice(0, 8), 类型: dataset.kind, 指标: Object.keys(result.metrics).join(',') }))
  } catch (err) {
    await db
      .update(evalRuns)
      .set({ status: 'failed', error: (err as Error).message.slice(0, 500), endedAt: Date.now() })
      .where(eq(evalRuns.id, runId))
    log.warn('eval', '评测失败', kv({ run: runId.slice(0, 8), 原因: (err as Error).message }))
  }
}
