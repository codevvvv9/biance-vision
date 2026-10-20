/**
 * 会话评测基线 runner（P0-1，vertical-agent-architecture.md §6）：
 * 加载 scripts/evals/conversations-baseline.json（受版本控制），按六类场景执行确定性断言，
 * 产出结构化报告（通过率/分类指标）。
 *
 * 运行：pnpm eval:conversations [-- --tag baseline] [-- --against <report.json>]
 * - 默认写 server/data/evals/report-<yyyyMMdd-HHmmss>.json；--tag baseline 写 baseline-<date>.json
 * - --against 逐类别对比通过率：任何类别下降 → exit 1（回归门禁）
 * - 标注 baselineExpectFail 的用例钉住未落地目标行为（P0-3/P0-5）：基线阶段 FAIL 属预期，
 *   记录为 expected_fail（不计入回归）；落地后转 PASS 即指标提升。
 * - requires:'db' 的 e2e 用例在 DATABASE_URL 未配置时跳过并记录。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { classifyIntent, parseReplayAsOf, extractPositionDraft, missingPositionFields } from '../server/src/research/runs/conversation.js'
import { assembleTrustedReply } from '../server/src/research/runs/replyAssembler.js'
import type { ReplyTemplateKey } from '../server/src/research/runs/replyAssembler.js'
import { bindCounterEvidence } from '../server/src/research/runs/countercaseParse.js'
import { validateResearch } from '../server/src/services/validator.js'
import type { ValidationCode } from '../server/src/services/validator.js'
import { isPositionStale } from '../server/src/research/runs/stages.js'
import { buildSynthesis } from '../server/src/research/runs/synthesis.js'
import { resolveScene } from '../server/src/research/scenes.js'
import { analyzeEvent } from '../server/src/services/eventAnalyzer.js'
import type { EventQuoteInput } from '../server/src/services/eventAnalyzer.js'
import { decideEventSubmitted } from '../server/src/services/decisionPolicy.js'
import { hashFrozenConfig } from '../server/src/research/runs/store.js'
import { runPipeline } from '../server/src/research/orchestrator/pipeline.js'
import { ValidationRejected } from '../server/src/research/orchestrator/pipeline.js'
import { RunCancelled, LeaseLostError } from '../server/src/research/orchestrator/types.js'
import type { RunContext, RunStore, Stage, StageName } from '../server/src/research/orchestrator/types.js'

interface EvalItem {
  id: string
  category: string
  kind: string
  input: Record<string, unknown>
  expect: Record<string, unknown>
  requires?: string
  baselineExpectFail?: boolean
  note?: string
}

interface ItemResult {
  id: string
  category: string
  status: 'pass' | 'fail' | 'expected_fail' | 'skip'
  reason?: string
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 评测输入受版本控制（2026-10-20 评审 #8：原放被整体忽略的 server/data/ 下，新 clone/CI
// 缺文件直接退出——输入随仓库交付，运行报告仍写 server/data/evals/）
const suitePath = join(root, 'scripts/evals/conversations-baseline.json')
const suite = JSON.parse(readFileSync(suitePath, 'utf8')) as { items: EvalItem[]; fixedNow: number }

const args = process.argv.slice(2)
const tagIdx = args.indexOf('--tag')
const againstIdx = args.indexOf('--against')

// ---- 断言基建 ----

class CheckError extends Error {}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new CheckError(msg)
}

function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CheckError(`期望数字，得到 ${JSON.stringify(v)}`)
  return v
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new CheckError(`期望字符串，得到 ${JSON.stringify(v)}`)
  return v
}

// ---- E 类：runPipeline mock 场景 ----

function mkCtx(frozenBudgets?: Record<string, number>): RunContext {
  return {
    runId: 'run-eval', userId: 'u-eval', product: 'teaching', symbol: 'BTCUSDT', marketType: 'usdm_perp', horizon: '1h',
    question: null, positionId: null, quoteId: null, asOf: Date.now(), snapshotId: null, configVersion: null,
    knowledgeVersion: null, ruleVersion: null, modelVersion: null,
    frozenConfig: frozenBudgets === undefined ? null : ({ budgets: frozenBudgets } as RunContext['frozenConfig']),
    qualityIssues: [], snapshotPack: null, plan: null, structures: null, retrieval: null, productPayload: null,
    claims: [], counterClaims: [], decision: null, result: null, validationFeedback: null,
    usage: { llmCalls: 0, tokens: 0, searchCalls: 0, toolCalls: 0, costUsd: 0 },
    runStartedAt: Date.now() - (frozenBudgets?.maxRuntimeMs !== undefined ? 10_000 : 0),
  } as unknown as RunContext
}

interface PipelineOutcome {
  published: boolean
  failed: string | null
  cancelled: boolean
  result: Record<string, unknown> | null
  events: string[]
  /** 结束后的 ctx 快照（断言降级剔除语义用） */
  postCtx?: RunContext
  /** completeStage 收到的检查点（断言降级状态入检查点用） */
  checkpoint?: Record<string, unknown> | null
}

/** 拒绝模式：once=首跑拒一次后通过；always=始终拒（不可降级硬红线）；llmOnly=存在 LLM 反证才拒（剔除后可通过 → 降级） */
type RejectMode = 'once' | 'always' | 'llmOnly'

async function runRepairScenario(mode: RejectMode): Promise<PipelineOutcome> {
  let rejects = 0
  const events: string[] = []
  const out: PipelineOutcome = { published: false, failed: null, cancelled: false, result: null, events }
  const mkStage = (name: StageName): Stage => ({
    name,
    async run(ctx: RunContext): Promise<void> {
      if (name === 'countercase') {
        // 造一条 LLM 反证 + 一条模板反证（llmOnly 模式的剔除对象；真实链路由 countercase 产生）
        if (ctx.counterClaims.length === 0) {
          ctx.counterClaims = [
            { text: 'LLM 归纳反证（数据不足时不适用 80% 规则族先验）', evidenceIds: [], origin: 'llm' },
            { text: '模板规则反证：交易区间假突破频发', evidenceIds: [], origin: 'template' },
          ]
        }
        return
      }
      if (name === 'validate') {
        const shouldReject =
          mode === 'always'
            ? true
            : mode === 'llmOnly'
              ? ctx.counterClaims.some((c) => c.origin === 'llm')
              : rejects < 1
        if (shouldReject) {
          rejects++
          throw new ValidationRejected([`eval: 拒绝 #${rejects}`])
        }
        return
      }
      if (name === 'publish') {
        // 降级语义由 publish 装配（P0-5）：mock 只设置最小 result 形状
        ctx.result = ((ctx as unknown as { degradedPublish?: unknown }).degradedPublish !== undefined
          ? { schemaVersion: 2, degraded: true, degradedReasons: ['eval'] }
          : { schemaVersion: 2 }) as unknown as RunContext['result']
      }
    },
  })
  const store: RunStore = {
    async transition() {},
    async stepStarted() {},
    async stepCompleted() {},
    async completeStage(_id, _step, _at, _cost, ctxState) {
      out.checkpoint = ctxState
    },
    async stepFailed(_id, step, _at, error) {
      out.failed = `${step}: ${error}`
    },
    async publish(_id, result) {
      out.published = true
      out.result = result as Record<string, unknown>
    },
    async fail(_id, error) {
      out.failed = (out.failed ?? '') + `|fail:${error}`
    },
    async isCancelled() {
      return false
    },
  }
  const bus = {
    emit(_runId: string, event: { type: string }): void {
      events.push(event.type)
    },
  }
  try {
    const ctx = mkCtx()
    const stages = (['plan', 'snapshot', 'structures', 'retrieve', 'product_analysis', 'countercase', 'synthesis', 'validate', 'publish'] as const).map(mkStage)
    await runPipeline(ctx, stages, store, bus, {
      leaseOwner: 'eval',
      // 与 runner.runCheckpointOf 同口径的最小检查点（断言降级状态随检查点持久化）
      checkpointOf: (c) => ({ counterClaims: c.counterClaims, degradedPublish: c.degradedPublish, result: c.result }),
    })
    out.result = ctx.result as Record<string, unknown> | null
    out.postCtx = ctx
  } catch (err) {
    if (err instanceof RunCancelled) out.cancelled = true
    else if (err instanceof LeaseLostError) out.failed = 'lease_lost'
    // 其余错误已由 store.stepFailed/fail 记录
  }
  return out
}

const NOOP_STAGES: Stage[] = (['plan', 'snapshot', 'structures', 'retrieve', 'product_analysis', 'countercase', 'synthesis', 'validate', 'publish'] as const).map(
  (name) => ({ name, async run() {} }),
)

function recorderStore(out: PipelineOutcome): RunStore {
  return {
    async transition() {},
    async stepStarted() {},
    async stepCompleted() {},
    async completeStage() {},
    async stepFailed(_id, step, _at, error) {
      out.failed = `${step}: ${error}`
    },
    async publish(_id, result) {
      out.published = true
      out.result = result as Record<string, unknown>
    },
    async fail(_id, error) {
      out.failed = (out.failed ?? '') + `|fail:${error}`
    },
    async isCancelled() {
      return false
    },
  }
}

async function runBudgetScenario(): Promise<PipelineOutcome> {
  const out: PipelineOutcome = { published: false, failed: null, cancelled: false, result: null, events: [] }
  try {
    // maxRuntimeMs=1ms 且 runStartedAt 已超时 → 第一步边界 budget_exceeded（八阶段齐全才进入步骤循环）
    await runPipeline(mkCtx({ maxRuntimeMs: 1 }), NOOP_STAGES, recorderStore(out), { emit() {} }, { leaseOwner: 'eval' })
  } catch {
    /* 已由 store.stepFailed/fail 记录 */
  }
  return out
}

async function runCancelScenario(): Promise<PipelineOutcome> {
  const out: PipelineOutcome = { published: false, failed: null, cancelled: false, result: null, events: [] }
  const store = recorderStore(out)
  const canceller: RunStore = {
    ...store,
    async isCancelled() {
      return true
    },
  }
  try {
    await runPipeline(mkCtx(), NOOP_STAGES, canceller, { emit(): void {} }, { leaseOwner: 'eval' })
  } catch (err) {
    if (err instanceof RunCancelled) out.cancelled = true
  }
  return out
}

// ---- 分类检查器 ----

async function checkItem(item: EvalItem): Promise<void> {
  const now = typeof item.input.now === 'number' ? item.input.now : suite.fixedNow
  switch (item.kind) {
    // A 类：补问与意图路由
    case 'intent': {
      const got = classifyIntent(str(item.input.message))
      check(got === item.expect.intent, `意图 ${got} ≠ 期望 ${item.expect.intent}`)
      return
    }
    case 'replay_asof': {
      const got = parseReplayAsOf(str(item.input.message), now)
      const type = str(item.expect.type)
      if (type === 'invalid') {
        check(got === 'invalid', `期望 invalid，得到 ${JSON.stringify(got)}`)
        return
      }
      check(typeof got === 'number', `期望数值，得到 ${JSON.stringify(got)}`)
      if (item.expect.exact !== undefined) check(got === item.expect.exact, `${got} ≠ 期望 ${item.expect.exact}`)
      if (item.expect.approxNow !== undefined) check(Math.abs((got as number) - num(item.expect.approxNow)) <= 1000, `${got} 偏离 ${item.expect.approxNow}`)
      return
    }
    case 'draft_slots': {
      const draft = extractPositionDraft(str(item.input.message))
      const missing = missingPositionFields(draft as never)
      const expect = (item.expect.missing as string[]) ?? []
      check(
        missing.length === expect.length && expect.every((k) => missing.includes(k)),
        `缺失槽位 ${JSON.stringify(missing)} ≠ 期望 ${JSON.stringify(expect)}`,
      )
      return
    }
    // B 类：引用支持
    case 'bind_varied': {
      const lines = item.input.lines as string[]
      const rows = item.input.rows as { id: string; text: string }[]
      const bindings = lines.map((line) => bindCounterEvidence(line, rows).evidenceIds)
      const distinct = new Set(bindings.map((b) => b.join(',')))
      check(distinct.size > 1, `各行绑定集合全部相同（${[...distinct][0] ?? '(空)'}）——未随内容变化（§3.2.7-A）`)
      return
    }
    case 'bind_cited': {
      const got = bindCounterEvidence(str(item.input.line), item.input.rows as { id: string; text: string }[])
      const expect = item.expect.evidenceIds as string[]
      check(
        got.evidenceIds.length === expect.length && expect.every((id, i) => got.evidenceIds[i] === id),
        `绑定 ${JSON.stringify(got.evidenceIds)} ≠ 期望 ${JSON.stringify(expect)}`,
      )
      return
    }
    case 'bind_zero': {
      const got = bindCounterEvidence(str(item.input.line), [])
      check(got.evidenceIds.length === 0, '空证据集合应返回空绑定')
      return
    }
    case 'validator_ref':
    case 'validator_prob': {
      const result = validateResearch({
        claims: (item.input.claims as never[]) ?? [],
        counterClaims: (item.input.counterClaims as never[]) ?? [],
        knownEvidenceIds: new Set(item.input.knownEvidenceIds as string[]),
        modelVersion: null,
        frozenConfigHash: null,
        runtimeConfigHash: null,
      })
      check(!result.ok, '期望校验拒绝，但通过了')
      if (!result.ok) {
        check(result.issues.some((i: { code: ValidationCode }) => i.code === (item.expect.code as ValidationCode)), `issues ${JSON.stringify(result.issues.map((i) => i.code))} 不含 ${item.expect.code}`)
      }
      return
    }
    // C 类：过期持仓
    case 'stale': {
      const staleAfter = num(item.input.staleAfterHours)
      const ageHours = num(item.input.ageHours)
      const at = now - ageHours * 3600_000
      const got = isPositionStale(at, staleAfter, now)
      check(got === item.expect.stale, `isPositionStale(${ageHours}h, ${staleAfter}h) = ${got} ≠ ${item.expect.stale}`)
      return
    }
    case 'stale_semantics': {
      const staleAfter = num(item.input.staleAfterHours)
      const old = isPositionStale(now - (staleAfter + 1) * 3600_000, staleAfter, now)
      const fresh = isPositionStale(now - 3600_000, staleAfter, now)
      check(old === true && fresh === false, `过期判定应锚定 confirmedAt：旧确认=${old}（应 true）、新确认=${fresh}（应 false）`)
      return
    }
    // D 类：事件剩余期限语义
    case 'action_gate': {
      const orderState = str(item.input.orderState) as 'preview' | 'submitted'
      const decision = str(item.input.decision)
      const result = validateResearch({
        claims: [],
        counterClaims: [],
        knownEvidenceIds: new Set(),
        modelVersion: null,
        event: { analysis: { orderState } as never, decision },
        frozenConfigHash: null,
        runtimeConfigHash: null,
      })
      if (result.ok) {
        check(item.expect.ok === true, `期望通过但被拒（expect.code=${String(item.expect.code)}）`)
        return
      }
      const codes = result.issues.map((i: { code: ValidationCode }) => i.code)
      check(codes.includes(item.expect.code as ValidationCode), `期望 ${String(item.expect.code)}，得到 ${JSON.stringify(codes)}`)
      return
    }
    case 'preview_ttl': {
      const quote: EventQuoteInput = {
        stake: 10, totalPayout: 19, direction: 'above',
        orderState: str(item.input.orderState) as 'preview' | 'submitted',
        strikeStatus: str(item.input.strikeStatus) as 'preview' | 'locked',
        previewAsOf: now - num(item.input.ageSec) * 1000,
        eventRiskBudget: null,
      }
      check(analyzeEvent(quote, null, null, now).previewExpired === item.expect.previewExpired, `previewExpired ≠ ${item.expect.previewExpired}`)
      return
    }
    case 'submitted_semantics': {
      const quote: EventQuoteInput = {
        stake: 10, totalPayout: 19, direction: 'above', orderState: 'submitted',
        strikeStatus: 'locked', previewAsOf: now - 3600_000, eventRiskBudget: null,
      }
      const a = analyzeEvent(quote, null, null, now)
      check(a.previewExpired === false, 'submitted 订单 previewExpired 应恒 false')
      const action = decideEventSubmitted({ expired: item.input.expired === true, settled: item.input.settled === true })
      check(action === item.expect.action, `decideEventSubmitted=${action} ≠ ${item.expect.action}`)
      return
    }
    case 'submitted_no_prob': {
      const quote: EventQuoteInput = {
        stake: 10, totalPayout: 19, direction: 'above', orderState: 'submitted',
        strikeStatus: 'locked', previewAsOf: null, eventRiskBudget: null,
      }
      const a = analyzeEvent(quote, null, null, now)
      check(a.pWin === null && a.expectedNet === null, `submitted 订单应输出固定值研究（pWin=${a.pWin}，EV=${a.expectedNet}）`)
      return
    }
    // E 类：正确降级
    case 'repair_exhausted': {
      // 2026-10-19 审查修正语义：始终拒绝=不可降级硬红线 → 阻断 failed（不再带病降级发布）
      const out = await runRepairScenario('always')
      check(out.failed !== null && out.failed.includes('validation_blocked'), `始终拒绝应阻断 validation_blocked，得到 ${out.failed}`)
      check(!out.published, '不可降级问题不得发布')
      return
    }
    case 'repair_exhausted_content': {
      // 仅 LLM 反证问题：剔除后重校验通过 → 降级发布（published+degraded+原因清单+无 LLM 残留）
      const out = await runRepairScenario('llmOnly')
      check(out.published && !out.failed, `剔除 LLM 反证后应降级发布，得到 published=${out.published} failed=${out.failed}`)
      const result = (out.result ?? {}) as Record<string, unknown>
      check(result.degraded === true, '降级发布结果应带 degraded:true')
      check(Array.isArray(result.degradedReasons) && (result.degradedReasons as string[]).length > 0, '降级结果应带 degradedReasons 清单')
      check(out.events.includes('task_degraded'), '应发出 task_degraded 事件')
      check((out.postCtx?.counterClaims ?? []).every((c) => c.origin !== 'llm'), '降级后 counterClaims 不得残留 origin=llm')
      return
    }
    case 'degraded_checkpoint_recover': {
      // 2026-10-19 审查修正（P1）：降级状态必须进检查点——validate 降级收尾的检查点含
      // degradedPublish 与剔除后的 counterClaims；恢复执行（仅 publish 阶段）按降级门控发布
      const first = await runRepairScenario('llmOnly')
      check(first.published, '前置：llmOnly 场景应降级发布')
      const ck = (first.checkpoint ?? {}) as Record<string, unknown>
      check(ck.degradedPublish !== undefined, '检查点应含 degradedPublish')
      const ckCounter = (ck.counterClaims ?? []) as { origin?: string }[]
      check(ckCounter.length > 0 && ckCounter.every((c) => c.origin !== 'llm'), '检查点 counterClaims 应为剔除 LLM 后的集合')
      // 恢复：从检查点水化新 ctx，仅提供 publish 阶段
      const recovered = mkCtx()
      recovered.counterClaims = ckCounter as RunContext['counterClaims']
      ;(recovered as unknown as { degradedPublish: unknown }).degradedPublish = ck.degradedPublish
      const out2: PipelineOutcome = { published: false, failed: null, cancelled: false, result: null, events: [] }
      const pubStage: Stage = {
        name: 'publish',
        async run(ctx: RunContext): Promise<void> {
          ctx.result = ((ctx as unknown as { degradedPublish?: unknown }).degradedPublish !== undefined
            ? { schemaVersion: 2, degraded: true, degradedReasons: ['eval'] }
            : { schemaVersion: 2 }) as unknown as RunContext['result']
        },
      }
      await runPipeline(recovered, [pubStage], recorderStore(out2), { emit() {} }, { leaseOwner: 'eval' })
      check(out2.published, '恢复执行应幂等补发布')
      check((out2.result ?? {}).degraded === true, '恢复发布仍应带 degraded:true')
      return
    }
    case 'budget_runtime': {
      const out = await runBudgetScenario()
      check(out.failed !== null && out.failed.includes('budget_exceeded'), `预算超限应 failed budget_exceeded，得到 ${out.failed}`)
      return
    }
    case 'cancelled': {
      const out = await runCancelScenario()
      check(out.cancelled, '取消应触发 RunCancelled')
      return
    }
    case 'repair_once_ok': {
      const out = await runRepairScenario('once')
      check(out.published && !out.failed, `一次拒绝后修复应正常发布，得到 published=${out.published} failed=${out.failed}`)
      const result = (out.result ?? {}) as Record<string, unknown>
      check(result.degraded !== true, '修复成功发布不应带 degraded 标记')
      return
    }
    // P0-2 统一可信回答入口
    case 'assembler_render': {
      const reply = assembleTrustedReply({
        key: item.input.key as ReplyTemplateKey,
        facts: item.input.facts as Record<string, string | number> | undefined,
        notes: item.input.notes as string[] | undefined,
        llmText: item.input.llmText as string | null | undefined,
        llmFallback: item.input.llmFallback as string | undefined,
        sourceCount: item.input.sourceCount as number | undefined,
        sections: item.input.sections as string[] | undefined,
        evidenceTexts: item.input.evidenceTexts as string[] | undefined,
      })
      check(reply.degraded === item.expect.degraded, `degraded=${reply.degraded} ≠ ${item.expect.degraded}（${reply.checkNotes.join(';')}）`)
      for (const inc of (item.expect.includes as string[]) ?? []) {
        check(reply.content.includes(inc), `渲染内容缺「${inc}」`)
      }
      for (const exc of (item.expect.excludes as string[]) ?? []) {
        check(!reply.content.includes(exc), `渲染内容不得含「${exc}」`)
      }
      return
    }
    case 'assembler_leftover': {
      const reply = assembleTrustedReply({
        key: item.input.key as ReplyTemplateKey,
        facts: item.input.facts as Record<string, string | number> | undefined,
        notes: item.input.notes as string[] | undefined,
      })
      check(reply.degraded === true, '漏传槽位应触发降级标注')
      check(!reply.content.includes('{{'), '降级回退后不得残留 {{...}} 占位')
      return
    }
    case 'assembler_cite': {
      const reply = assembleTrustedReply({
        key: item.input.key as ReplyTemplateKey,
        llmText: item.input.llmText as string | null,
        sourceCount: item.input.sourceCount as number | undefined,
        llmFallback: item.input.llmFallback as string | undefined,
        sections: item.input.sections as string[] | undefined,
      })
      check(reply.degraded === true, '引用编号越界应触发降级')
      check(!reply.content.includes('[3]'), '越界引用文本不得进入最终回复')
      return
    }
    case 'assembler_prob': {
      const reply = assembleTrustedReply({
        key: item.input.key as ReplyTemplateKey,
        llmText: item.input.llmText as string | null,
        sourceCount: item.input.sourceCount as number | undefined,
        llmFallback: item.input.llmFallback as string | undefined,
        sections: item.input.sections as string[] | undefined,
      })
      check(reply.degraded === true, '概率红线应触发降级')
      for (const inc of (item.expect.includes as string[]) ?? []) {
        check(reply.content.includes(inc), `回退内容缺「${inc}」`)
      }
      return
    }
    case 'assembler_empty_guard': {
      const reply = assembleTrustedReply({
        key: item.input.key as ReplyTemplateKey,
        llmText: item.input.llmText as string | null,
        sourceCount: item.input.sourceCount as number | undefined,
        facts: item.input.facts as Record<string, string | number> | undefined,
        notes: item.input.notes as string[] | undefined,
      })
      check(reply.degraded === true, '红线拒绝应触发降级')
      check(reply.content.trim() !== '', '兜底后内容不得为空（空回复=用户无响应）')
      return
    }
    case 'assembler_safe_template': {
      const reply = assembleTrustedReply({ key: item.input.key as ReplyTemplateKey })
      check(reply.degraded === false, '固定安全模板不应降级')
      for (const inc of (item.expect.includes as string[]) ?? []) {
        check(reply.content.includes(inc), `模板内容缺「${inc}」`)
      }
      return
    }
    // F 类：历史回放一致性
    case 'hash_stable':
    case 'hash_keyorder':
    case 'hash_sensitive': {
      const base = {
        budgets: { maxLlmCalls: 6, maxToolCalls: 20, maxSearchCalls: 2, maxRuntimeMs: 60_000 },
        knowledgeVersionId: 'kv-eval-1',
        raw: { capabilities: { chat: { enabled: true } }, retrieval: { finalLimit: 6 } },
        fees: { takerRate: 0.0005, makerRate: 0.0002, slippageRate: 0.0003 },
        stepSize: 0.001,
        minNotional: 100,
        fundingWindow: { intervalMs: 28800000, graceMs: 3600000 },
      }
      if (item.kind === 'hash_stable') {
        check(hashFrozenConfig(base as never) === hashFrozenConfig(structuredClone(base) as never), '同一配置两次哈希不一致')
        return
      }
      if (item.kind === 'hash_keyorder') {
        const reordered = {
          fundingWindow: { graceMs: 3600000, intervalMs: 28800000 },
          minNotional: 100,
          stepSize: 0.001,
          fees: { slippageRate: 0.0003, makerRate: 0.0002, takerRate: 0.0005 },
          raw: { retrieval: { finalLimit: 6 }, capabilities: { chat: { enabled: true } } },
          knowledgeVersionId: 'kv-eval-1',
          budgets: { maxRuntimeMs: 60_000, maxSearchCalls: 2, maxToolCalls: 20, maxLlmCalls: 6 },
        }
        check(hashFrozenConfig(base as never) === hashFrozenConfig(reordered as never), '键序不同（pg jsonb 重排）哈希不一致')
        return
      }
      const changed = { ...structuredClone(base), budgets: { ...base.budgets, maxLlmCalls: 7 } }
      check(hashFrozenConfig(base as never) !== hashFrozenConfig(changed as never), '预算字段变化哈希未变（version_mismatch 校验失效）')
      return
    }
    case 'rerun_e2e': {
      if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL === '') {
        throw new CheckError('skip:DATABASE_URL 未配置')
      }
      const { freezeRunConfig } = await import('../server/src/research/runs/store.js')
      const a = await freezeRunConfig()
      const b = await freezeRunConfig()
      check(a.configHash === b.configHash, '同库连续两次 freezeRunConfig 哈希不一致（配置未变时必须一致）')
      return
    }
    // G 类（P1）：语义支持校验——引用存在 ≠ 证据支持（2026-10-19 复核缺口②）
    case 'validator_support': {
      const result = validateResearch({
        claims: (item.input.claims as never[]) ?? [],
        counterClaims: (item.input.counterClaims as never[]) ?? [],
        knownEvidenceIds: new Set(item.input.knownEvidenceIds as string[]),
        evidenceTexts: new Map(Object.entries((item.input.evidenceTexts as Record<string, string>) ?? {})),
        modelVersion: null,
        frozenConfigHash: null,
        runtimeConfigHash: null,
      })
      if (item.expect.ok === true) {
        check(result.ok, `期望通过但被拒：${JSON.stringify(result.ok ? [] : result.issues.map((i) => i.code))}`)
        return
      }
      check(!result.ok, '期望校验拒绝（证据不支持该声明），但通过了')
      if (!result.ok) {
        check(
          result.issues.some((i: { code: ValidationCode }) => i.code === (item.expect.code as ValidationCode)),
          `issues ${JSON.stringify(result.issues.map((i) => i.code))} 不含 ${String(item.expect.code)}`,
        )
      }
      return
    }
    // G 类（P1-1）：意图×产品 → TaskScene 映射
    case 'scene_resolve': {
      const got = resolveScene(str(item.input.intent) as never, {
        product: (item.input.product as never) ?? null,
        hasPosition: item.input.hasPosition === true,
        replay: item.input.replay === true,
      })
      check(got === item.expect.scene, `场景 ${got} ≠ 期望 ${item.expect.scene}`)
      return
    }
    // H 类（P1-2）：受约束综合解释（可注入 mock LLM；句级校验钉住行为）
    case 'synthesis_behavior': {
      const llmSpec = item.input.llm as { kind: 'text' | 'throw' | 'none'; text?: string } | undefined
      const llm =
        llmSpec === undefined || llmSpec.kind === 'none'
          ? null
          : async () => {
              if (llmSpec.kind === 'throw') throw new Error('mock LLM 故障（评测注入）')
              return { text: llmSpec.text ?? '', usage: { promptTokens: 0, completionTokens: 0 } }
            }
      const result = await buildSynthesis(
        {
          question: (item.input.question as string) ?? null,
          symbol: 'BTCUSDT',
          horizon: '1h',
          decision: item.input.decision as never,
          claims: (item.input.claims as never[]) ?? [],
          counterClaims: (item.input.counterClaims as never[]) ?? [],
          scenarios: (item.input.scenarios as never[]) ?? [],
          evidenceTexts: (item.input.evidenceTexts as string[]) ?? [],
        },
        { llm, system: '评测用系统提示词' },
      )
      check(result.source === item.expect.source, `source=${result.source} ≠ 期望 ${item.expect.source}`)
      if (item.expect.degraded !== undefined) {
        check(result.degraded === item.expect.degraded, `degraded=${String(result.degraded)} ≠ 期望 ${String(item.expect.degraded)}`)
      }
      for (const inc of (item.expect.includes as string[]) ?? []) {
        check(result.text.includes(inc), `综合解释缺「${inc}」`)
      }
      for (const exc of (item.expect.excludes as string[]) ?? []) {
        check(!result.text.includes(exc), `综合解释不得含「${exc}」`)
      }
      return
    }
    default:
      throw new CheckError(`未知用例类型：${item.kind}`)
  }
}

// ---- 主流程 ----

// f6 修复（2026-10-19 复核）：requires:'db' 用例此前进环境变量后直接调 freezeRunConfig，
// 未初始化数据库连接（initDb 含自动迁移）——现在先 initDb；失败则全部 db 用例转 skip
const hasDbEnv = process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== ''
let dbReady = false
if (hasDbEnv && suite.items.some((i) => i.requires === 'db')) {
  const { initDb } = await import('../server/src/db.js')
  dbReady = await initDb()
}

const results: ItemResult[] = []
for (const item of suite.items) {
  if (item.requires === 'db' && (!hasDbEnv || !dbReady)) {
    results.push({ id: item.id, category: item.category, status: 'skip', reason: hasDbEnv ? 'db init failed' : 'requires db' })
    continue
  }
  try {
    await checkItem(item)
    results.push({ id: item.id, category: item.category, status: 'pass' })
  } catch (err) {
    const msg = (err as Error).message ?? String(err)
    if (msg.startsWith('skip:')) {
      results.push({ id: item.id, category: item.category, status: 'skip', reason: msg.slice(5) })
      continue
    }
    // 基线预期失败：钉住未落地目标行为（P0-3/P0-5），不算回归
    if (item.baselineExpectFail === true) {
      results.push({ id: item.id, category: item.category, status: 'expected_fail', reason: msg })
    } else {
      results.push({ id: item.id, category: item.category, status: 'fail', reason: msg })
    }
  }
}

const categories = [...new Set(suite.items.map((i) => i.category))]
const byCategory = Object.fromEntries(
  categories.map((cat) => {
    const rows = results.filter((r) => r.category === cat)
    return [
      cat,
      {
        total: rows.length,
        passed: rows.filter((r) => r.status === 'pass').length,
        failed: rows.filter((r) => r.status === 'fail').length,
        expectedFail: rows.filter((r) => r.status === 'expected_fail').length,
        skipped: rows.filter((r) => r.status === 'skip').length,
        passRate: rows.length === 0 ? 0 : Number((rows.filter((r) => r.status === 'pass').length / rows.length).toFixed(4)),
      },
    ]
  }),
)

const report = {
  suite: suitePath.replace(root + '/', ''),
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.status === 'pass').length,
  failed: results.filter((r) => r.status === 'fail').length,
  expectedFail: results.filter((r) => r.status === 'expected_fail').length,
  skipped: results.filter((r) => r.status === 'skip').length,
  byCategory,
  items: results,
}

const outDir = join(root, 'server/data/evals')
mkdirSync(outDir, { recursive: true })
const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, '-')
const outFile = tagIdx >= 0 && args[tagIdx + 1] !== undefined ? `baseline-${dateTag}.json` : `report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`
writeFileSync(join(outDir, outFile), JSON.stringify(report, null, 2) + '\n')

console.log(`评测完成：${report.passed}/${report.total} 通过（预期失败 ${report.expectedFail}，跳过 ${report.skipped}，失败 ${report.failed}）`)
for (const [cat, m] of Object.entries(byCategory)) {
  console.log(`  ${cat}: ${m.passed}/${m.total}（预期失败 ${m.expectedFail}，跳过 ${m.skipped}）`)
}
for (const r of results.filter((x) => x.status === 'fail' || x.status === 'expected_fail')) {
  console.log(`  ${r.status === 'fail' ? '❌' : '⏳'} ${r.id} [${r.category}] ${r.reason}`)
}
console.log(`报告：server/data/evals/${outFile}`)

// --against 回归对比：任何类别通过率下降 → exit 1
let regress = 0
if (againstIdx >= 0 && args[againstIdx + 1] !== undefined) {
  const prev = JSON.parse(readFileSync(join(root, args[againstIdx + 1]), 'utf8')) as { byCategory: Record<string, { passRate: number }> }
  for (const [cat, m] of Object.entries(byCategory)) {
    const before = prev.byCategory?.[cat]?.passRate
    if (before !== undefined && m.passRate < before) {
      console.error(`回归：${cat} 通过率 ${m.passRate} < 基线 ${before}`)
      regress++
    }
  }
  if (regress === 0) console.log('对比基线：无类别回退 ✅')
}
if (report.failed > 0 || regress > 0) process.exit(1)
