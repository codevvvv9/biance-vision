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

/** worker 侧注册处理器 */
export async function registerKnowledgeWorkers(boss: PgBoss): Promise<void> {
  await boss.work<KnowledgeParseJob>(Q_KNOWLEDGE_PARSE, async (jobs) => {
    for (const job of jobs) {
      try {
        await processDocument(job.data.docId)
      } catch (err) {
        // processDocument 已置 failed + 原因；此处吞掉避免整批任务失败重试刷状态
        log.warn('knowledge', '解析任务失败', kv({ id: job.data.docId.slice(0, 8), 原因: (err as Error).message }))
      }
    }
  })
}
