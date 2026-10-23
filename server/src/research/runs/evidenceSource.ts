/**
 * 证据源投影（W2 流程 7，docs/knowledge-ui-redesign-plan.md §3.3）：
 * 把冻结证据行 + 源文档当前行 + 权限上下文投影为 evidence 响应的只增字段——
 * - fileUrl：用户侧鉴权读取端点；仅 knowledge_chunk 且源文档当前可读（未归档/
 *   未清除、有本地文件、按当前 access 可见）时给出，其余一律 null（约定不可用）；
 * - docUpdated：文档已重发布（冻结版本号 ≠ 当前 version）/已归档/已清除 → true，
 *   前端据此不定位页码并提示「文档已更新，定位可能失效」（M6 可信降级）。
 * 纯函数（smoke 直接断言）；历史快照三阶段语义的第三阶段=原文读取按当前权限。
 */
import { canSeeAccess, type KnowledgeAccessContext } from '../../knowledge/access.js'
import type { EvidenceItemRow, KnowledgeDocumentRow } from '../../models.js'
import type { EvidenceSource } from 'biance-vision-brooks'

export function projectEvidenceSource(
  evidence: Pick<EvidenceItemRow, 'id' | 'kind' | 'docVersionId' | 'contentHash'>,
  doc: Pick<KnowledgeDocumentRow, 'id' | 'version' | 'status' | 'access' | 'blobKey'> | null | undefined,
  viewer: KnowledgeAccessContext,
): EvidenceSource {
  const docId = evidence.kind === 'knowledge_chunk' && evidence.docVersionId !== null ? evidence.docVersionId.split('#')[0] : null
  const contentHash = evidence.contentHash ?? null
  if (docId === null || evidence.docVersionId === null) {
    // 规则卡/市场 bar/结构事件/网页证据：无本地原文概念
    return { docId, contentHash, fileUrl: null, docUpdated: false }
  }
  const frozenVersion = Number.parseInt(evidence.docVersionId.split('#')[1] ?? '0', 10)
  const docUpdated = doc == null || doc.status === 'archived' || doc.version !== frozenVersion
  const readable =
    doc != null &&
    doc.status !== 'archived' &&
    (doc.blobKey ?? '') !== '' &&
    canSeeAccess(viewer, doc.access)
  return {
    docId,
    contentHash,
    fileUrl: readable ? `/api/research/evidence/${evidence.id}/file` : null,
    docUpdated,
  }
}
