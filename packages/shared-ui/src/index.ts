/**
 * @biance/shared-ui 桶出口（W3-S1，docs/admin-isolation-plan.md §3.1）：
 * 两端（user-web / admin-web）共用的 UI 基建——API 客户端、i18n（词典静态打包）、
 * 数据类型、纯工具、认证上下文、MiniMarkdown 富文本、Dropdown/anchoredPanel、
 * ErrorBoundary、fx/useSpotlight。源码直消费（vite alias + tsconfig paths 指向本 src），
 * 不经构建产物；组件样式仍在两端各自的 styles/index.css 全局层（级联顺序有契约，见
 * web/src/styles/index.css 注释），S3 物理拆库时随组件内聚迁移。
 */
export { api, setUnauthorizedHandler, fetchAdminUsers, updateChatPolicy, cutOffUserChat, fetchAdminConversations, fetchAdminConversation } from './api'
export type { ApiOptions } from './api'
export { ApiError } from './api'
export { apiErrorMessage } from './errors'

export * from './types'
export * from './utils'
export { default as i18n, currentLocale, contentLocale, websiteLocale, klinechartsLocale, KLINECHARTS_LOCALE, KLINECHARTS_ZH_TW } from './i18n'
export type { AppLocale, ContentLocale } from './i18n'
export { AuthProvider, useAuth } from './auth/AuthContext'
export { default as MiniMarkdown } from './components/MiniMarkdown'
export { default as ErrorBoundary } from './components/ErrorBoundary'
export { useSpotlight } from './components/fx/useSpotlight'
export { Dropdown } from './research/Dropdown'
export type { DropdownOption } from './research/Dropdown'
export { useAnchoredPanel } from './research/anchoredPanel'
export type { AnchoredPanelPos } from './research/anchoredPanel'

export { startTelemetry, stopTelemetry, resetTelemetrySubject, reportOperationFailed, reportClientError, telemetryStats } from './telemetry'
export { mountDevDebug, debugRecordRequest } from './telemetry/devDebug'
export type { BvDebugSnapshot } from './telemetry/devDebug'
export { toTraditional } from './zh-tw'
