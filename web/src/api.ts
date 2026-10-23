/**
 * W3-S1 兼容 shim：实体已下沉 @biance/shared-ui（packages/shared-ui/src/api.ts），
 * web 内既有相对导入（'./api'、'../api'）经本文件转发；S3 admin 树迁出时一并清理。
 */
export {
  api,
  setUnauthorizedHandler,
  fetchAdminUsers,
  updateChatPolicy,
  cutOffUserChat,
  fetchAdminConversations,
  fetchAdminConversation,
} from '@biance/shared-ui'
export type { ApiOptions } from '@biance/shared-ui'
