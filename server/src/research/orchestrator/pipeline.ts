/**
 * 固定研究流水线状态机：plan → snapshot → structures → retrieve → product_analysis
 * → countercase → validate → publish。
 *
 * - 每步持久化（可恢复）、步骤间检查取消、失败记录原因；进度经 EventBus 推送（SSE）。
 * - 校验失败可在预算内修复一次：validate 抛出 ValidationRejected 时，携带问题清单
 *   回到 product_analysis 重跑一次后再校验；仍失败则由 publish 阶段发布
 *   insufficient_evidence（缺证据也是合法结论），而不是把未通过校验的结论发出去。
 */

import { RunCancelled, LeaseLostError, STAGE_NAMES } from './types.js'
import type { EventBus, RunContext, RunStore, Stage, StageName } from './types.js'
import type { RunProgressEvent } from 'biance-vision-brooks'

export interface PipelineOptions {
  /** validate 失败后的预算内修复次数（默认 1；由 admin 预算配置覆盖） */
  maxRepairAttempts?: number
  /** 本执行持有的租约标识（阶段完成与检查点原子提交时校验续租权） */
  leaseOwner: string
  /** 每步成功后的检查点序列化（同步纯函数；与阶段状态在同一事务原子落库，不吞错误） */
  checkpointOf?: (ctx: RunContext, name: StageName) => Record<string, unknown> | null
}

/** 校验器拒绝结果时抛出（携带问题清单供修复轮使用） */
export class ValidationRejected extends Error {
  issues: string[]
  constructor(issues: string[]) {
    super(`validation rejected: ${issues.join('; ')}`)
    this.name = 'ValidationRejected'
    this.issues = issues
  }
}

const REPAIR_LOOP: readonly StageName[] = ['product_analysis', 'countercase', 'validate']

export async function runPipeline(
  ctx: RunContext,
  stages: readonly Stage[],
  store: RunStore,
  bus: EventBus,
  options: PipelineOptions,
): Promise<void> {
  const maxRepairAttempts = options.maxRepairAttempts ?? 1
  const stageByName = new Map<StageName, Stage>(stages.map((s) => [s.name, s]))
  // 断点恢复：传入 stages 可为「已完成步骤过滤后」的子集；全新运行必须八步齐全
  const provided = new Set(stages.map((s) => s.name))
  const missing = STAGE_NAMES.filter((n) => !provided.has(n))
  if (missing.length !== 0 && missing.length !== stages.filter((s) => !STAGE_NAMES.includes(s.name)).length) {
    // 允许缺阶段（恢复场景）；但缺 publish 时结果必须已存在
    if (!provided.has('publish') && ctx.result === null) {
      throw new Error(`pipeline 缺少阶段实现：${missing.join(',')}`)
    }
  }

  await store.transition(ctx.runId, 'running', options.leaseOwner)
  const emit = (type: RunProgressEvent['type'], step?: StageName, payload?: unknown): void => {
    bus.emit(ctx.runId, { type, runId: ctx.runId, step, at: Date.now(), payload } as RunProgressEvent)
  }

  const runStage = async (name: StageName, repairPass: boolean): Promise<void> => {
    const stage = stageByName.get(name)!
    const startedAt = Date.now()
    await store.stepStarted(ctx.runId, name, startedAt, options.leaseOwner)
    emit('step_started', name, repairPass ? { repairPass: true } : undefined)
    if (name === 'validate') await store.transition(ctx.runId, 'validating', options.leaseOwner)
    await stage.run(ctx)
    // 阶段状态与检查点在同一事务原子提交：崩溃时要么都可见（跳过该阶段且输出在），
    // 要么都不可见（恢复时重跑该阶段）——不存在 completed 但缺输出的窗口
    const checkpoint = options.checkpointOf?.(ctx, name) ?? null
    await store.completeStage(ctx.runId, name, Date.now(), Date.now() - startedAt, checkpoint, options.leaseOwner)
    emit('step_completed', name)
  }

  let repairs = 0
  let validationFeedback: string[] | null = null
  /** 中止运行并落失败状态；丢租约时放弃写入（接管者负责该 run，不得改成 failed） */
  const abortRun = async (name: StageName, msg: string): Promise<never> => {
    try {
      await store.stepFailed(ctx.runId, name, Date.now(), msg, options.leaseOwner)
      emit('run_failed', name, { error: msg })
      await store.fail(ctx.runId, msg, options.leaseOwner)
    } catch (writeErr) {
      if (!(writeErr instanceof LeaseLostError)) throw writeErr
    }
    throw new Error(msg)
  }
  let i = 0
  while (i < STAGE_NAMES.length) {
    const name = STAGE_NAMES[i]
    // 断点恢复：传入子集时跳过未提供的阶段（不能对缺失阶段取 .run）
    if (!stageByName.has(name)) {
      i++
      continue
    }
    if (await store.isCancelled(ctx.runId)) {
      emit('run_cancelled')
      throw new RunCancelled()
    }
    // 运行时预算（冻结值）在步骤边界强制；工具调用/费用上限同样在此强制
    const budgets = ctx.frozenConfig?.budgets
    if (budgets !== null && budgets !== undefined) {
      if (budgets.maxRuntimeMs !== undefined && Date.now() - ctx.runStartedAt > budgets.maxRuntimeMs) {
        throw await abortRun(name, `budget_exceeded: 运行时长超过上限 ${budgets.maxRuntimeMs}ms`)
      }
      if (budgets.maxToolCalls !== undefined && ctx.usage.toolCalls > budgets.maxToolCalls) {
        throw await abortRun(name, `budget_exceeded: 工具调用 ${ctx.usage.toolCalls} 超过上限 ${budgets.maxToolCalls}`)
      }
      // 费用上限：只有配置了 LLM 单价来源（usage.costUsd 真实累计）时才强制；
      // 无单价时 costUsd 恒 0，不假装执行（budgets 注释同步说明）
      if (budgets.maxCostUsd !== undefined && ctx.usage.costUsd > budgets.maxCostUsd) {
        throw await abortRun(name, `budget_exceeded: 估算费用 $${ctx.usage.costUsd.toFixed(4)} 超过上限 $${budgets.maxCostUsd}`)
      }
    }
    try {
      ctx.validationFeedback = validationFeedback
      await runStage(name, validationFeedback !== null && REPAIR_LOOP.includes(name))
      validationFeedback = null
      i++
    } catch (err) {
      if (err instanceof RunCancelled) {
        emit('run_cancelled')
        throw err
      }
      // 丢租约：立即退出且不再写入任何状态（stepFailed/fail 会把接管者正在运行的 run 改成失败）
      if (err instanceof LeaseLostError) throw err
      if (err instanceof ValidationRejected && name === 'validate' && repairs < maxRepairAttempts) {
        repairs++
        validationFeedback = err.issues
        // 回到修复环起点（product_analysis），带入问题清单重跑
        i = STAGE_NAMES.indexOf(REPAIR_LOOP[0])
        continue
      }
      const message = err instanceof Error ? err.message : String(err)
      try {
        await store.stepFailed(ctx.runId, name, Date.now(), message, options.leaseOwner)
        emit('run_failed', name, { error: message })
        await store.fail(ctx.runId, message, options.leaseOwner)
      } catch (writeErr) {
        if (!(writeErr instanceof LeaseLostError)) throw writeErr
      }
      throw err
    }
  }

  if (ctx.result === null && stageByName.has('publish')) throw new Error('publish 阶段结束但 result 为空')
  // 恢复场景：全部阶段已完成（stages 为空）但 result 从 checkpoint 恢复时，在此幂等补发布
  if (ctx.result !== null) await store.publish(ctx.runId, ctx.result, options.leaseOwner)
  emit('run_published', undefined, { runId: ctx.runId })
}
