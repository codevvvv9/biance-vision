/**
 * 共享契约 barrel：/api 新族的请求/响应 zod schema 统一出口。
 * server 与 web 同源引用，禁止各自手写类型漂移（docs/specs/api-storage.md）。
 */

export * from './common.js'
export * from './market.js'
export * from './portfolio.js'
export * from './event-quotes.js'
export * from './predictions.js'
export * from './research.js'
export * from './knowledge.js'
export * from './admin.js'
export * from './resultV2.js'
export * from './membership.js'
