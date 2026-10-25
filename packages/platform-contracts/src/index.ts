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
