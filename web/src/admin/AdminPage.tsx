import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useState } from 'react'
import { cutOffUserChat, fetchAdminUsers, updateChatPolicy, api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { fmtDateTime } from '../utils'
import type { AdminUserRow, AuditAction, AuditEntry, AuditRecord } from '../types'
import { ProvisionUserPanel } from './ProvisionUserPanel'
import { UserAccessPanel } from './UserAccessPanel'
import { WebsiteSettings } from './WebsiteSettings'
import './website-admin.css'

const ACTION_META: Record<AuditAction, { label: string; cls: string }> = {
  login: { label: '登录', cls: 'act-auth' },
  login_failed: { label: '登录失败', cls: 'act-fail' },
  logout: { label: '登出', cls: 'act-auth' },
  rule_create: { label: '新增规则', cls: 'act-rule' },
  rule_update: { label: '修改规则', cls: 'act-rule' },
  rule_delete: { label: '删除规则', cls: 'act-rule' },
  settings_update: { label: '修改推送设置', cls: 'act-set' },
  settings_test: { label: '测试推送', cls: 'act-set' },
  chat_policy_update: { label: '改聊天策略', cls: 'act-set' },
  chat_cutoff: { label: '掐断聊天', cls: 'act-fail' },
}

const STATUS_META: Record<NonNullable<AuditRecord['status']>, { label: string; cls: string }> = {
  active: { label: '进行中', cls: 'st-active' },
  ended: { label: '已登出', cls: 'st-ended' },
  expired: { label: '已过期', cls: 'st-expired' },
}

function ActionTag({ entry }: { entry: AuditEntry }): JSX.Element {
  const { t } = useTranslation('admin')
  const meta = ACTION_META[entry.action]
  return <span className={`act-tag ${meta?.cls ?? ''} ${entry.ok ? '' : 'is-fail'}`}>{t(meta?.label ?? entry.action)}</span>
}

function Timeline({ actions }: { actions: AuditEntry[] }): JSX.Element {
  return (
    <div className="audit-timeline">
      {actions.map((a, i) => (
        <div className={`tl-item ${a.ok ? '' : 'tl-fail'}`} key={i}>
          <span className="mono tl-time">{fmtDateTime(a.at)}</span>
          <ActionTag entry={a} />
          <span className="tl-detail">{a.detail}</span>
        </div>
      ))}
    </div>
  )
}

/** 每日限额输入：空 = 不限（提交 null），Enter 或点「设」提交；非正整数不提交 */
function LimitInput({
  limit,
  busy,
  onSubmit,
  onInvalid,
}: {
  limit: number | null
  busy: boolean
  onSubmit: (dailyLimit: number | null) => void
  onInvalid: (message: string) => void
}): JSX.Element {
  const { t } = useTranslation('admin')
  const [val, setVal] = useState(limit === null ? '' : String(limit))
  const commit = (): void => {
    const v = val.trim()
    if (v === '') {
      if (limit !== null) onSubmit(null)
      return
    }
    const n = Number(v)
    if (!Number.isInteger(n) || n <= 0) {
      onInvalid(t('每日上限需为正整数，留空表示不限'))
      return
    }
    if (limit === n) return
    onSubmit(n)
  }
  return (
    <>
      <input
        className="chat-limit-input"
        type="number"
        min={1}
        step={1}
        value={val}
        disabled={busy}
        placeholder={t("不限")}
        title={t("每日聊天上限：留空 = 不限，Enter 或点「设」提交")}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={commit} title={t("提交每日上限（空 = 不限）")}>
        {t('设')}
      </button>
    </>
  )
}

export default function AdminPage(): JSX.Element {
  const { t } = useTranslation('admin')
  const { user } = useAuth()
  const [records, setRecords] = useState<AuditRecord[] | null>(null)
  const [usernames, setUsernames] = useState<string[]>([])
  const [users, setUsers] = useState<AdminUserRow[] | null>(null)
  const [copied, setCopied] = useState('')
  const [username, setUsername] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState('')
  /** 正在执行聊天管控操作的用户名；非空时全部行的管控按钮禁用（全局互斥，避免并发管控写） */
  const [accessUser, setAccessUser] = useState<string | null>(null)
  const [busyUser, setBusyUser] = useState('')

  const load = useCallback((name: string): void => {
    const qs = name ? `?username=${encodeURIComponent(name)}` : ''
    api<{ records: AuditRecord[]; usernames: string[] }>(`/admin/audit-logs${qs}`)
      .then((d) => {
        setRecords(d.records)
        setUsernames(d.usernames)
        setError('')
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  const refreshUsers = useCallback((): void => {
    fetchAdminUsers()
      .then((d) => {
        setUsers(d.users)
        setError('')
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    if (user?.role !== 'superadmin') return
    load('')
    refreshUsers()
  }, [load, refreshUsers, user])

  const runUserOp = useCallback(
    (name: string, op: () => Promise<unknown>): void => {
      if (busyUser !== '') return
      setBusyUser(name)
      op()
        .then(() => {
          setError('')
          refreshUsers()
        })
        .catch((e: Error) => setError(e.message))
        .finally(() => setBusyUser(''))
    },
    [busyUser, refreshUsers],
  )

  const toggleDisabled = (u: AdminUserRow): void => {
    runUserOp(u.username, () => updateChatPolicy(u.username, { disabled: !u.chatPolicy.disabled }))
  }

  const commitLimit = (u: AdminUserRow, dailyLimit: number | null): void => {
    runUserOp(u.username, () => updateChatPolicy(u.username, { dailyLimit }))
  }

  const cutoff = (u: AdminUserRow): void => {
    if (!window.confirm(t('确认掐断用户「{{u}}」？\n将禁用该用户聊天并取消其全部进行中的研究任务。', { u: u.username }))) return
    runUserOp(u.username, async () => {
      const r = await cutOffUserChat(u.username)
      window.alert(
        t('已禁用「{{u}}」的聊天，并取消 {{n}} 个进行中的研究任务。', { u: u.username, n: r.cancelledRuns.length }) +
          (r.cancelDeferred === true ? t('研究取消被延迟（数据库暂不可用），稍后可在 AI 会话页的研究会话追踪中复查。') : ''),
      )
    })
  }

  const copyName = (name: string): void => {
    navigator.clipboard
      ?.writeText(name)
      .then(() => {
        setCopied(name)
        window.setTimeout(() => setCopied(''), 1500)
      })
      .catch(() => {
        /* 剪贴板不可用时静默 */
      })
  }

  // 日志筛选下拉：真实用户在前，已删除但留有日志的用户在后
  const filterNames = [...new Set([...(users ?? []).map((u) => u.username), ...usernames])]

  return (
    <div className="page">
      <ProvisionUserPanel onCreated={refreshUsers} />
      <WebsiteSettings />
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            <i className="title-glyph" />
            {t('用户列表')}
          </h2>
          <button className="btn btn-ghost" onClick={refreshUsers}>
            {t('刷新')}
          </button>
        </div>
        <div className="table-wrap">
          <table className="table users-table">
            <thead>
              <tr>
                <th>{t('用户名')}</th>
                <th className="col-role">{t("角色")}</th>
                <th className="col-chat">{t("聊天")}</th>
                <th className="col-time">{t("创建时间")}</th>
                <th className="col-copy">{t("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {error !== '' && users === null && (
                <tr className="empty-row">
                  <td colSpan={5}>{t('加载失败：{{msg}}', { msg: error })}</td>
                </tr>
              )}
              {users === null && !error && (
                <tr className="empty-row">
                  <td colSpan={5}>{t('加载中…')}</td>
                </tr>
              )}
              {users?.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={5}>{t('暂无用户')}</td>
                </tr>
              )}
              {(users ?? []).map((u) => (
                <tr key={u.username}>
                  <td className="mono col-name">
                    <b>{u.username}</b>
                  </td>
                  <td className="col-role">
                    <span className={`role-tag ${u.role === 'superadmin' ? 'role-super' : ''}`}>
                      {u.role === 'superadmin' ? t('超级管理员') : t('普通用户')}
                    </span>
                  </td>
                  <td className="col-chat">
                    <span className="chat-cell">
                      <span className={`role-tag ${u.chatPolicy.disabled ? 'chat-off' : 'chat-ok'}`}>
                        {u.chatPolicy.disabled ? t('已禁用') : t('正常')}
                      </span>
                      <span className="chat-usage mono dim" title={t("今日已用 / 每日上限")}>
                        {u.chatUsage.today}/{u.chatUsage.limit === null ? t('不限') : u.chatUsage.limit}
                      </span>
                      <span
                        className={`sess-status ${u.activeRecently ? 'st-active' : 'st-ended'}`}
                        title={u.activeRecently ? t('5 分钟内有操作（活跃近似）') : t('5 分钟内无操作')}
                      >
                        <i />
                        {u.activeRecently ? t('在线') : t('离线')}
                      </span>
                    </span>
                  </td>
                  <td className="mono dim col-time">{fmtDateTime(u.createdAt)}</td>
                  <td className="col-copy">
                    <span className="chat-ops">
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => copyName(u.username)}
                        title={t("复制用户名（AI 档案绑定等场景需精准匹配，可直接粘贴）")}
                      >
                        {copied === u.username ? `✓ ${t('已复制')}` : t('复制')}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busyUser !== ''}
                        onClick={() => toggleDisabled(u)}
                        title={u.chatPolicy.disabled ? t('恢复该用户的 AI 聊天') : t('禁用该用户的 AI 聊天（不影响登录）')}
                      >
                        {u.chatPolicy.disabled ? t('启用') : t('禁用')}
                      </button>
                      {u.role === 'user' && <button className="btn btn-ghost btn-sm" onClick={() => setAccessUser(u.username)}>额度 / 重置密码</button>}
                      <LimitInput
                        key={`${u.username}:${u.chatPolicy.dailyLimit ?? 'null'}`}
                        limit={u.chatPolicy.dailyLimit}
                        busy={busyUser !== ''}
                        onSubmit={(dailyLimit) => commitLimit(u, dailyLimit)}
                        onInvalid={setError}
                      />
                      <button
                        className="btn btn-ghost btn-sm danger"
                        disabled={busyUser !== ''}
                        onClick={() => cutoff(u)}
                        title={t("一键掐断：禁用聊天并取消其全部进行中的研究任务")}
                      >
                        {t('掐断')}
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {accessUser && <UserAccessPanel key={accessUser} username={accessUser} onClose={() => setAccessUser(null)} />}
        <p className="form-hint muted audit-hint">
          {t('AI 配置档案的「绑定用户」需与上述用户名完全一致（区分大小写），可点击「复制」后直接粘贴；')}
          {t('「聊天」列展示禁用状态与今日用量（已用/上限），可对单个用户禁用/设每日上限/一键掐断（掐断同时取消其进行中的研究任务）。')}
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            <i className="title-glyph amber" />
            {t('操作日志')}
          </h2>
          <div className="audit-toolbar">
            <select
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
                load(e.target.value)
              }}
            >
              <option value="">{t("全部用户")}</option>
              {filterNames.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost" onClick={() => load(username)}>
              {t('刷新')}
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table className="table audit-table">
            <thead>
              <tr>
                <th className="col-user">{t("用户")}</th>
                <th className="col-kind">{t("类型")}</th>
                <th className="col-ip" title={t("悬停查看设备信息")}>IP</th>
                <th className="col-time">{t("登录 / 发生时间")}</th>
                <th className="col-time">{t("结束时间")}</th>
                <th className="col-cnt">{t("操作数")}</th>
                <th className="col-status">{t("状态")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {error && (
                <tr className="empty-row">
                  <td colSpan={8}>{t('加载失败：{{msg}}', { msg: error })}</td>
                </tr>
              )}
              {!error && records?.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={8}>{t('暂无操作记录')}</td>
                </tr>
              )}
              {!error &&
                (records ?? []).flatMap((r) => {
                  const failed = r.kind === 'login_failed'
                  const open = expanded === r.id
                  const rows = [
                    <tr
                      key={r.id}
                      className={`${failed ? 'row-fail' : ''} ${open ? 'row-open' : ''}`}
                      onClick={() => !failed && setExpanded(open ? null : r.id)}
                      title={r.userAgent ? t('设备：{{ua}}', { ua: r.userAgent }) : undefined}
                    >
                      <td className="col-user">
                        <b>{r.username}</b>
                      </td>
                      <td className="col-kind">
                        <span className={`act-tag ${failed ? 'act-fail' : 'act-rule'}`}>
                          {failed ? t('登录失败') : t('登录会话')}
                        </span>
                      </td>
                      <td className="mono dim col-ip">{r.ip || '—'}</td>
                      <td className="mono dim col-time">{fmtDateTime(r.at)}</td>
                      <td className="mono dim col-time">{r.endedAt ? fmtDateTime(r.endedAt) : '—'}</td>
                      <td className="mono dim col-cnt">{failed ? '—' : r.actions.length}</td>
                      <td className="col-status">
                        {failed ? (
                          <span className="down">{t('失败')}</span>
                        ) : (
                          <span className={`sess-status ${STATUS_META[r.status ?? 'ended'].cls}`}>
                            <i />
                            {t(STATUS_META[r.status ?? 'ended'].label)}
                          </span>
                        )}
                      </td>
                      <td className="col-toggle">{!failed && <span className="toggle-caret">{open ? '▾' : '▸'}</span>}</td>
                    </tr>,
                  ]
                  if (open) {
                    rows.push(
                      <tr key={`${r.id}-detail`} className="row-detail">
                        <td colSpan={8}>
                          <Timeline actions={r.actions} />
                        </td>
                      </tr>,
                    )
                  }
                  return rows
                })}
            </tbody>
          </table>
        </div>
        {accessUser && <UserAccessPanel key={accessUser} username={accessUser} onClose={() => setAccessUser(null)} />}
        <p className="form-hint muted audit-hint">
          {t('一次登录即一条会话记录，展开可查看该次登录后的完整操作路径（含登录来源 IP 与设备）；')}
          {t('登录失败单独记录。保留最近 200 条会话，仅超级管理员可见。')}
        </p>
      </section>
    </div>
  )
}
