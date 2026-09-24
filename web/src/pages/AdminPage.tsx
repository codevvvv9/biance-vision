import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { fmtDateTime } from '../utils'
import type { AuditAction, AuditEntry, AuditRecord } from '../types'

const ACTION_META: Record<AuditAction, { label: string; cls: string }> = {
  login: { label: '登录', cls: 'act-auth' },
  login_failed: { label: '登录失败', cls: 'act-fail' },
  logout: { label: '登出', cls: 'act-auth' },
  rule_create: { label: '新增规则', cls: 'act-rule' },
  rule_update: { label: '修改规则', cls: 'act-rule' },
  rule_delete: { label: '删除规则', cls: 'act-rule' },
  settings_update: { label: '修改推送设置', cls: 'act-set' },
  settings_test: { label: '测试推送', cls: 'act-set' },
}

const STATUS_META: Record<NonNullable<AuditRecord['status']>, { label: string; cls: string }> = {
  active: { label: '进行中', cls: 'st-active' },
  ended: { label: '已登出', cls: 'st-ended' },
  expired: { label: '已过期', cls: 'st-expired' },
}

function ActionTag({ entry }: { entry: AuditEntry }): JSX.Element {
  const meta = ACTION_META[entry.action]
  return <span className={`act-tag ${meta?.cls ?? ''} ${entry.ok ? '' : 'is-fail'}`}>{meta?.label ?? entry.action}</span>
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

export default function AdminPage(): JSX.Element {
  const { user } = useAuth()
  const [records, setRecords] = useState<AuditRecord[] | null>(null)
  const [usernames, setUsernames] = useState<string[]>([])
  const [username, setUsername] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [error, setError] = useState('')

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

  useEffect(() => {
    if (user?.role === 'superadmin') load('')
  }, [load, user])

  // 普通用户直接输入 /admin 时跳回首页；接口侧同样有 403 拦截
  if (user?.role !== 'superadmin') return <Navigate to="/" replace />

  return (
    <div className="page">
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            <i className="title-glyph amber" />
            操作日志
          </h2>
          <div className="audit-toolbar">
            <select
              value={username}
              onChange={(e) => {
                setUsername(e.target.value)
                load(e.target.value)
              }}
            >
              <option value="">全部用户</option>
              {usernames.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost" onClick={() => load(username)}>
              刷新
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table className="table audit-table">
            <thead>
              <tr>
                <th className="col-user">用户</th>
                <th className="col-kind">类型</th>
                <th className="col-ip" title="悬停查看设备信息">IP</th>
                <th className="col-time">登录 / 发生时间</th>
                <th className="col-time">结束时间</th>
                <th className="col-cnt">操作数</th>
                <th className="col-status">状态</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {error && (
                <tr className="empty-row">
                  <td colSpan={8}>加载失败：{error}</td>
                </tr>
              )}
              {!error && records?.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={8}>暂无操作记录</td>
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
                      title={r.userAgent ? `设备：${r.userAgent}` : undefined}
                    >
                      <td className="col-user">
                        <b>{r.username}</b>
                      </td>
                      <td className="col-kind">
                        <span className={`act-tag ${failed ? 'act-fail' : 'act-rule'}`}>
                          {failed ? '登录失败' : '登录会话'}
                        </span>
                      </td>
                      <td className="mono dim col-ip">{r.ip || '—'}</td>
                      <td className="mono dim col-time">{fmtDateTime(r.at)}</td>
                      <td className="mono dim col-time">{r.endedAt ? fmtDateTime(r.endedAt) : '—'}</td>
                      <td className="mono dim col-cnt">{failed ? '—' : r.actions.length}</td>
                      <td className="col-status">
                        {failed ? (
                          <span className="down">失败</span>
                        ) : (
                          <span className={`sess-status ${STATUS_META[r.status ?? 'ended'].cls}`}>
                            <i />
                            {STATUS_META[r.status ?? 'ended'].label}
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
        <p className="form-hint muted audit-hint">
          一次登录即一条会话记录，展开可查看该次登录后的完整操作路径（含登录来源 IP 与设备）；
          登录失败单独记录。保留最近 200 条会话，仅超级管理员可见。
        </p>
      </section>
    </div>
  )
}
