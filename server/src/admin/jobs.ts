/**
 * 评测与训练队列任务注册（worker 消费）。
 * - eval:run → executeEvalRun（RAG hit@k/MRR、结构因果回放）
 * - model:train → executeTrainJob（数据集构建 + 时间切分 + research-py 训练 + 注册表 ready）
 */
import type PgBoss from 'pg-boss'
import { Q_EVAL_RUN, Q_MODEL_TRAIN, getBoss } from '../queue.js'
import { executeEvalRun } from '../research/evalRunner.js'
import { executeTrainJob, markTrainFailed } from '../research/training.js'
import type { TrainJobInput } from '../research/training.js'
import { currentAgentConfig } from './agentVersions.js'

export type EvalRunJob = { runId: string }

export async function enqueueEvalRun(runId: string): Promise<boolean> {
  const boss = getBoss()
  if (!boss) return false
  await boss.send(Q_EVAL_RUN, { runId } satisfies EvalRunJob, { singletonKey: `eval:${runId}` })
  return true
}

export async function enqueueTrainJob(input: TrainJobInput): Promise<boolean> {
  const boss = getBoss()
  if (!boss) return false
  await boss.send(Q_MODEL_TRAIN, input, { singletonKey: `train:${input.modelVersion}` })
  return true
}

export async function registerAdminWorkers(boss: PgBoss): Promise<void> {
  await boss.work<EvalRunJob>(Q_EVAL_RUN, async (jobs) => {
    for (const job of jobs) await executeEvalRun(job.data.runId)
  })
  await boss.work<TrainJobInput>(Q_MODEL_TRAIN, async (jobs) => {
    for (const job of jobs) {
      try {
        await executeTrainJob(job.data)
      } catch (err) {
        await markTrainFailed(job.data.modelVersion, (err as Error).message)
      }
    }
  })
}

/** 评测/训练入队前钉住的配置版本（无发布版本时 default-v1） */
export async function pinnedConfigVersion(): Promise<string> {
  const agent = await currentAgentConfig()
  return agent?.label ?? 'default-v1'
}
