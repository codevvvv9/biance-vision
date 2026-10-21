/**
 * 知识库权限上下文（W1-A，docs/unified-roadmap.md §3 / specs/knowledge-rag.md 方案变更①）：
 * access=public/purchase/member 参与检索过滤（用户拍板方案甲）——purchase/member 资料
 * 对普通用户不可见，superadmin 例外；例外由服务端构造上下文判定，不信任客户端传入。
 *
 * 六条消费路径（词项/向量召回、规则卡案例、邻接扩展、会话问答、研究 run 证据组装）
 * 一律经 searchHybrid/fetchCitation 的 access 参数过滤；**上下文缺失时按普通用户处理**
 * （安全默认——漏传只会更保守，绝不会放大权限）。
 *
 * 历史快照三阶段语义（定稿）：冻结证据快照按冻结时授权供原研究所有者渲染；
 * 新检索/新研究/自动 LLM 上下文一律按当前权限；原文读取按当前权限。
 */
import { roleOfUsername } from '../users.js'

export type KnowledgeAccessRole = 'user' | 'superadmin'

/** 检索/消费路径的权限上下文：构造点唯一（服务端会话或用户名），透传只读 */
export interface KnowledgeAccessContext {
  readonly viewerRole: KnowledgeAccessRole
}

/** 普通用户上下文（缺省/降级语义：受限内容不可见） */
export const PUBLIC_VIEWER: KnowledgeAccessContext = { viewerRole: 'user' }

/** 超管上下文（admin 端点/评测/管理端检索调试） */
export const ADMIN_VIEWER: KnowledgeAccessContext = { viewerRole: 'superadmin' }

/** 从会话构造（HTTP 路径：session 由服务端鉴权取出，非请求方自称） */
export function accessCtxFromSession(session: { role?: string } | null | undefined): KnowledgeAccessContext {
  return session?.role === 'superadmin' ? ADMIN_VIEWER : PUBLIC_VIEWER
}

/**
 * 从用户名构造（worker/异步路径：研究 run 的检索按发起者当前角色）。
 * roleOfUsername 读 users 存储（单进程阶段=JSON 镜像 mtime 热加载，app/worker 共卷一致；
 * W3-S2 存储收敛后以 PG 为唯一真源）。未知用户名=普通用户（保守）。
 */
export function accessCtxForUser(username: string): KnowledgeAccessContext {
  return roleOfUsername(username) === 'superadmin' ? ADMIN_VIEWER : PUBLIC_VIEWER
}

/** 当前上下文能否看见该 access 级别的文档/派生内容 */
export function canSeeAccess(ctx: KnowledgeAccessContext, access: string | null | undefined): boolean {
  if (ctx.viewerRole === 'superadmin') return true
  return access !== 'purchase' && access !== 'member'
}

/** 是否受限级别（purchase/member）——过滤点统一用此判定，避免字符串比较散落 */
export function isRestrictedAccess(access: string | null | undefined): boolean {
  return access === 'purchase' || access === 'member'
}
