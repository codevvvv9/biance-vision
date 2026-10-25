/**
 * 平台纯契约包（P0-1）：服务端错误序列化与共享前端 ApiError 的两个真实消费者
 * 共用的类型与公开码——零依赖、无 Node/DOM/PG import，两端（server/web）同源。
 *
 * 约束（方案 §3.0.1）：本包不含服务端阈值/私有策略/内部堆栈；错误码注册表
 * 是有限静态集合，新码经注册表扩展而非路由内散落字符串。requestId 关联字段
 * 在 P0-3 由两端接线使用；事件 schema 等 P2a 起按批次增量加入。
 */

/** 统一 API 错误响应体（后端序列化输出；前端 ApiError 携带同一形状的字段） */
export interface ApiErrorResponse {
  statusCode: number
  error: string
  message: string
  /** 机器可读公开码（仅注册表内的码可透出；内部 SQLSTATE/网络异常禁止直透） */
  code: string
  /** 请求编号：报障时用户可复制、管理端可据此全链路定位 */
  requestId: string
  /** 429/503 等可等待错误携带；客户端按其做有抖动退避 */
  retryAfterSeconds?: number
}

/** 公开错误码注册项：一个码同时声明 HTTP 语义/展示/重试属性（内部异常映射留在服务端） */
export interface ErrorDefinition {
  httpStatus: number
  /** 双语展示字典键（进入既有 zh-CN/en-US 字典；P0 起后端只发注册表内 messageKey 对应文案） */
  messageKey: string
  retryable: boolean
  logLevel: 'info' | 'warn' | 'error'
}

/** 请求/任务关联字段：requestId 每次 HTTP 唯一；异步任务携带来源 originRequestId（不发明第二套 trace 协议） */
export interface RequestCorrelation {
  requestId: string
  originRequestId?: string
}

/**
 * 框架级公共错误码注册表：跨领域、前端按码分支行为的码在此中央声明
 * （HTTP 语义/重试属性/日志级别）。规则：
 * - 公开错误体只应携带本表内的框架码 + 各领域真实发出的业务码（原码原语义，
 *   由属主模块维护，不收编改名——收编会破坏既有 UI 分支且污染纯契约）；
 * - 内部 err.code（PG SQLSTATE/网络异常/第三方错误）禁止直透，统一落
 *   internal_error / service_unavailable；
 * - 新框架码必须在注册表声明后才可在服务端/前端同时引用（OCP 具名注册）。
 */
export const PUBLIC_ERROR_REGISTRY: Readonly<Record<string, ErrorDefinition>> = {
  validation_failed: { httpStatus: 400, messageKey: 'errors.validation_failed', retryable: false, logLevel: 'info' },
  bad_request: { httpStatus: 400, messageKey: 'errors.bad_request', retryable: false, logLevel: 'info' },
  payload_too_large: { httpStatus: 413, messageKey: 'errors.payload_too_large', retryable: false, logLevel: 'info' },
  invalid_credentials: { httpStatus: 401, messageKey: 'errors.invalid_credentials', retryable: false, logLevel: 'info' },
  session_expired: { httpStatus: 401, messageKey: 'errors.session_expired', retryable: false, logLevel: 'info' },
  permission_denied: { httpStatus: 403, messageKey: 'errors.permission_denied', retryable: false, logLevel: 'info' },
  csrf_invalid: { httpStatus: 403, messageKey: 'errors.csrf_invalid', retryable: false, logLevel: 'info' },
  not_found: { httpStatus: 404, messageKey: 'errors.not_found', retryable: false, logLevel: 'info' },
  chat_disabled: { httpStatus: 403, messageKey: 'errors.chat_disabled', retryable: false, logLevel: 'info' },
  chat_limit_exceeded: { httpStatus: 429, messageKey: 'errors.chat_limit_exceeded', retryable: true, logLevel: 'warn' },
  ai_access_exhausted: { httpStatus: 403, messageKey: 'errors.ai_access_exhausted', retryable: false, logLevel: 'info' },
  ai_daily_limit_exceeded: { httpStatus: 429, messageKey: 'errors.ai_daily_limit_exceeded', retryable: true, logLevel: 'warn' },
  ai_rate_limited: { httpStatus: 429, messageKey: 'errors.ai_rate_limited', retryable: true, logLevel: 'warn' },
  rate_limited: { httpStatus: 429, messageKey: 'errors.rate_limited', retryable: true, logLevel: 'warn' },
  login_throttled: { httpStatus: 429, messageKey: 'errors.login_throttled', retryable: true, logLevel: 'warn' },
  service_unavailable: { httpStatus: 503, messageKey: 'errors.service_unavailable', retryable: true, logLevel: 'error' },
  security_state_unavailable: { httpStatus: 503, messageKey: 'errors.security_state_unavailable', retryable: true, logLevel: 'error' },
  internal_error: { httpStatus: 500, messageKey: 'errors.internal_error', retryable: false, logLevel: 'error' },
}

/** 框架码判定（服务端序列化器用于区分「可透出的已声明码」与未声明值） */
export function isFrameworkErrorCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(PUBLIC_ERROR_REGISTRY, code)
}
