import { useCallback } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useMembership, useMembershipState } from './Membership'

/** 研究能力访问状态（全站唯一前端消费点，docs/specs/ui.md）：
 * 把会员 polling 快照映射为研究门禁语义——
 * - hasData=false 且无 error → 首查进行中（loading：主体不挂载、零请求）
 * - hasData=false 且有 error → 首查失败（失败重试卡）
 * - hasData=true 且有 error → 后台刷新失败（保留主体+横幅；旧数据仅用于展示，
 *   服务端对每次研究操作仍逐次校验）
 * - allowed=false → 明确拒绝（门禁卡或只读模式）
 * retry 走 store.refresh(true)，绕过失败退避（直接刷新，不被 retryNotBefore 吞掉）。
 * 未登录（无 membership store）不进入本状态机——游客态由页面原有逻辑处理。 */
export interface ResearchAccessState {
  allowed: boolean
  hasData: boolean
  firstLoadFailed: boolean
  refreshFailed: boolean
  loading: boolean
  retry: () => void
}

export function useResearchAccess(): ResearchAccessState {
  const { user } = useAuth()
  const store = useMembership()
  const snapshot = useMembershipState()
  const retry = useCallback(() => {
    if (store) void store.refresh(true)
  }, [store])
  if (!user || !store)
    return {
      allowed: false,
      hasData: false,
      firstLoadFailed: false,
      refreshFailed: false,
      loading: false,
      retry,
    }
  const hasData = snapshot.data !== undefined
  return {
    allowed: snapshot.data?.access?.research?.allowed === true,
    hasData,
    firstLoadFailed: !hasData && snapshot.error !== '',
    refreshFailed: hasData && snapshot.error !== '',
    loading: !hasData && snapshot.error === '',
    retry,
  }
}
