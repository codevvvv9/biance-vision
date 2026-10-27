import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../auth/AuthContext'
import { useMembership, useMembershipState } from '../membership/Membership'
import { useResearchAccess } from '../membership/access'

export interface ResearchGateMode {
  /** 只读模式（readOnly=true）由页面显式消费：隐藏/禁用发送、新建研究、重跑、追问、
   * 重新评估，且对应 handler 一并检查——不可依赖额度推断（research:false 时额度可能>0，
   * 无套餐时额度为 null）。读取、证据查看、取消任务继续允许。 */
  readOnly: boolean
}

/** 研究终端统一门禁（render prop 传页面模式）。规则（docs/specs/ui.md）：
 * - 未登录：无 membership store，直接渲染页面原有游客态（禁止匿名提交为现状行为），
 *   绝不落入加载占位造成永久加载，也不请求私有数据
 * - 首查进行中：占位骨架——页面组件（含其 hooks/数据请求）不挂载
 * - 首查失败：失败重试卡（refresh(true) 绕过退避）
 * - 已有数据+后台刷新失败：保留主体不卸载（草稿/SSE/历史定位不受影响），顶部横幅提示
 * - 新数据明确拒绝：门禁引导卡（联系开通 + 查看历史研究入口）；
 *   经历史入口进入后 readOnly=true，读取/取消允许、新研究禁用
 * 权限与额度分别判断：额度耗尽的既有配额 UI/错误不受本组件影响，服务端逐次兜底。 */
export function ResearchGate({ children }: { children: (mode: ResearchGateMode) => ReactNode }) {
  const { user } = useAuth()
  const store = useMembership()
  const snapshot = useMembershipState()
  const access = useResearchAccess()
  const { t } = useTranslation('common')
  const [historyView, setHistoryView] = useState(false)

  if (!user || !store) return <>{children({ readOnly: false })}</>

  if (access.loading)
    return (
      <div className="page-loading research-gate-loading" role="status" aria-label={t('app.pageLoading')}>
        <span className="page-loading-bar" />
      </div>
    )

  if (access.firstLoadFailed)
    return (
      <section className="research-gate-card" role="status">
        <h2>{t('membership.researchGateLoadFailedTitle')}</h2>
        <p className="research-gate-error">{snapshot.error}</p>
        <button className="research-gate-action" onClick={access.retry}>
          {t('membership.retry')}
        </button>
      </section>
    )

  if (!access.allowed && !historyView) {
    const contacts = snapshot.data?.contacts
    const contactUrl = contacts?.telegram
      ? `https://t.me/${contacts.telegram}`
      : contacts?.email
        ? `mailto:${contacts.email}?subject=${encodeURIComponent('DuckStrat — Research access')}`
        : null
    return (
      <section className="research-gate-card" role="status">
        <h2>{t('membership.researchGateTitle')}</h2>
        <p>{t('membership.researchGateBody')}</p>
        <div className="research-gate-actions">
          {contactUrl && (
            <a className="research-gate-action primary" href={contactUrl} target="_blank" rel="noopener noreferrer">
              {t('membership.researchGateContact')}
            </a>
          )}
          <button className="research-gate-action" onClick={() => setHistoryView(true)}>
            {t('membership.researchGateHistory')}
          </button>
        </div>
      </section>
    )
  }

  const readOnly = !access.allowed
  return (
    <>
      {access.refreshFailed && (
        <div className="research-gate-banner" role="status">
          {t('membership.researchGateRefreshFailed')}
        </div>
      )}
      {readOnly && (
        <div className="research-gate-banner readonly" role="status">
          {t('membership.researchGateReadonly')}
        </div>
      )}
      {children({ readOnly })}
    </>
  )
}
