/**
 * 知识库任务注册（worker 进程消费 knowledge:parse）与入队辅助（app 进程调用）。
 * 失败重试交给 pg-boss 的 retryLimit；文档状态由 processDocument 自行落 failed。
 */
import type PgBoss from 'pg-boss'
import { Q_KNOWLEDGE_PARSE, getBoss } from '../queue.js'
import { processDocument } from './pipeline.js'
import { kv, log } from '../logger.js'

export type KnowledgeParseJob = { docId: string }

/** 入队解析任务（app 导入路由用）；队列未启动返回 false（调用方可直接同步处理或稍后 reparse） */
export async function enqueueKnowledgeParse(docId: string): Promise<boolean> {
  const boss = getBoss()
  if (!boss) {
    log.warn('knowledge', '队列不可用，解析任务未入队（可稍后 reparse）', kv({ id: docId.slice(0, 8) }))
    return false
  }
  await boss.send(Q_KNOWLEDGE_PARSE, { docId } satisfies KnowledgeParseJob, {
    singletonKey: `knowledge-parse:${docId}`,
    singletonSeconds: 60,
  })
  log.info('knowledge', '解析任务已入队', kv({ id: docId.slice(0, 8) }))
  return true
}

/** worker 侧注册处理器（batchSize=全局解析并发闸：1=同一时刻只解析一份文档） */
export async function registerKnowledgeWorkers(boss: PgBoss, batchSize = 1): Promise<void> {
  // W2 worker 心跳（UI 方案 §4.3）：每 30s 写 app_settings，statuses 端点聚合判断
  // 「解析队列不可用」黄条；间隔为失联阈值（90s）的 1/3，进程退出后心跳自然过期
  const { touchWorkerHeartbeat } = await import('./store.js')
  void touchWorkerHeartbeat().catch(() => {})
  const hb = setInterval(() => void touchWorkerHeartbeat().catch(() => {}), 30_000)
  hb.unref?.()
  await boss.work<KnowledgeParseJob>(
    Q_KNOWLEDGE_PARSE,
    { batchSize },
    async (jobs) => {
    for (const job of jobs) {
      try {
        await processDocument(job.data.docId)
      } catch (err) {
        // W1-B（rag-pipeline §4.3 v2）：不再吞异常——processDocument 已置 failed+原因，
        // 此处抛出让 pg-boss 的重试语义真实生效（临时故障如 research-py 重启后
        // 自动重试一次，重试仍失败则停在 failed 等待手动 reparse）。
        // singletonKey 防同文档重复入队；全局并发=1 由队列的 maxConcurrency 提供
        //（解析天然串行——单批次在飞，多文档排队）
        log.warn('knowledge', '解析任务失败（交 pg-boss 重试或停留 failed）', kv({ id: job.data.docId.slice(0, 8), 原因: (err as Error).message }))
        throw err
      }
    }
  })
}
