import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { fmtDateTime } from '../utils'
import type {
  AiConversationDetail,
  AiConversationSummary,
  AiMemoryItem,
  AiProfileMasked,
  AiUserStat,
} from '../types'

const MEMORY_KIND_LABEL: Record<AiMemoryItem['kind'], string> = {
  preference: '偏好',
  fact: '背景',
  interest: '关注',
  habit: '习惯',
}

interface UserPanorama {
  username: string
  profileName: string
  profileConfigured: boolean
  profileMasked: AiProfileMasked | null
  prompt: string
  conversations: AiConversationSummary[]
  memories: AiMemoryItem[]
}

function ConfigRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="ai-insight-conf-row">
      <span className="dim">{label}</span>
      <span className="mono">{value}</span>
    </div>
  )
}

/** 会话详情：完整上下文（用户/助手逐条） */
function ConversationDetail({ conv }: { conv: AiConversationDetail }): JSX.Element {
  return (
    <div className="ai-conv-detail">
      {conv.messages.map((m, i) => (
        <div key={i} className={`ai-msg ${m.role}`}>
          <span className="ai-msg-role">{m.role === 'user' ? '用户' : '助手'}</span>
          <span className="mono ai-msg-time">{fmtDateTime(m.at)}</span>
          <p className="ai-msg-content">{m.content}</p>
        </div>
      ))}
    </div>
  )
}

export default function AiInsightsPage(): JSX.Element {
  const { user } = useAuth()
  const [stats, setStats] = useState<AiUserStat[] | null>(null)
  const [selected, setSelected] = useState('')
  const [pano, setPano] = useState<UserPanorama | null>(null)
  const [openConv, setOpenConv] = useState<AiConversationDetail | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [error, setError] = useState('')

  const loadOverview = useCallback((): void => {
    api<{ stats: AiUserStat[] }>('/admin/ai/overview')
      .then((d) => {
        setStats(d.stats)
        setError('')
      })
      .catch((e: Error) => setError(e.message))
  }, [])

  useEffect(() => {
    if (user?.role !== 'superadmin') return
    loadOverview()
  }, [loadOverview, user])

  const pickUser = (username: string): void => {
    setSelected(username)
    setOpenConv(null)
    setShowPrompt(false)
    api<UserPanorama>(`/admin/ai/user?username=${encodeURIComponent(username)}`)
      .then((d) => {
        setPano(d)
        setError('')
      })
      .catch((e: Error) => setError(e.message))
  }

  const toggleConv = (id: string): void => {
    if (openConv?.id === id) {
      setOpenConv(null)
      return
    }
    api<{ conversation: AiConversationDetail }>(`/admin/ai/conversations/${id}`)
      .then((d) => setOpenConv(d.conversation))
      .catch((e: Error) => setError(e.message))
  }

  // 普通用户直接输入 /admin/ai 时跳回首页；接口侧同样有 403 拦截
  if (user?.role !== 'superadmin') return <Navigate to="/" replace />

  const conf = pano?.profileMasked

  return (
    <div className="page">
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            <i className="title-glyph purple" />
            AI 会话记录
          </h2>
          <button className="btn btn-ghost" onClick={loadOverview}>
            刷新
          </button>
        </div>
        <div className="table-wrap">
          <table className="table ai-stats-table">
            <thead>
              <tr>
                <th>用户</th>
                <th className="col-profile">生效档案</th>
                <th className="col-cnt">会话</th>
                <th className="col-cnt">消息</th>
                <th className="col-cnt">记忆</th>
                <th className="col-time">最近活跃</th>
              </tr>
            </thead>
            <tbody>
              {error && (
                <tr className="empty-row">
                  <td colSpan={6}>加载失败：{error}</td>
                </tr>
              )}
              {!error && stats?.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={6}>暂无任何 AI 对话记录</td>
                </tr>
              )}
              {!error &&
                (stats ?? []).map((s) => (
                  <tr
                    key={s.username}
                    className={selected === s.username ? 'row-open' : ''}
                    onClick={() => pickUser(s.username)}
                    title="点击查看该用户的 AI 全景"
                  >
                    <td className="col-name">
                      <b>{s.username}</b>
                    </td>
                    <td className="mono dim col-profile">{s.profileName}</td>
                    <td className="mono dim col-cnt">{s.conversations}</td>
                    <td className="mono dim col-cnt">{s.messages}</td>
                    <td className="mono dim col-cnt">{s.memories}</td>
                    <td className="mono dim col-time">{s.lastActiveAt ? fmtDateTime(s.lastActiveAt) : '—'}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        <p className="form-hint muted audit-hint">
          点击用户行查看其生效配置、长期记忆、会话上下文与完整系统提示词。仅超级管理员可见。
        </p>
      </section>

      {pano && (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">
                <i className="title-glyph amber" />
                生效配置 · {pano.username}
              </h2>
            </div>
            <div className="ai-insight-conf">
              {pano.profileConfigured && conf ? (
                <>
                  <ConfigRow label="档案" value={pano.profileName} />
                  <ConfigRow label="接口地址" value={conf.baseUrl} />
                  <ConfigRow label="模型" value={conf.model} />
                  <ConfigRow label="API Key" value={conf.apiKeyMasked} />
                  <ConfigRow label="temperature" value={conf.temperature === undefined ? '0.7（默认）' : String(conf.temperature)} />
                  <ConfigRow label="输出上限" value={conf.maxTokens && conf.maxTokens > 0 ? `${conf.maxTokens} tokens` : '不限'} />
                  <ConfigRow label="每日限额" value={conf.dailyLimit && conf.dailyLimit > 0 ? `${conf.dailyLimit} 次/人/天` : '不限'} />
                  <ConfigRow label="绑定用户" value={(conf.allowedUsers ?? []).join('、') || '（未绑定，走 default 规则）'} />
                  {conf.extraPrompt && (
                    <div className="ai-insight-conf-row ai-insight-extra">
                      <span className="dim">追加提示词</span>
                      <pre>{conf.extraPrompt}</pre>
                    </div>
                  )}
                </>
              ) : (
                <p className="form-hint muted">该用户当前没有生效的 AI 档案（default 未配置完整）。</p>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">
                <i className="title-glyph" />
                长期记忆 · {pano.memories.length} 条
              </h2>
            </div>
            {pano.memories.length === 0 ? (
              <p className="form-hint muted" style={{ padding: '10px 16px' }}>
                暂无记忆（系统会在对话中自动提取用户偏好与背景，跨会话注入提示词）
              </p>
            ) : (
              <div className="ai-memory-list">
                {pano.memories.map((m) => (
                  <div key={m.id} className="ai-memory-item">
                    <span className={`role-tag mem-${m.kind}`}>{MEMORY_KIND_LABEL[m.kind]}</span>
                    <span className="ai-memory-content">{m.content}</span>
                    <span className="mono dim ai-memory-time">{fmtDateTime(m.updatedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">
                <i className="title-glyph teal" />
                会话上下文 · {pano.conversations.length} 个
              </h2>
            </div>
            <div className="table-wrap">
              <table className="table ai-conv-table">
                <thead>
                  <tr>
                    <th className="col-title">会话</th>
                    <th className="col-cnt">消息数</th>
                    <th className="col-time">创建时间</th>
                    <th className="col-time">最近更新</th>
                    <th className="col-toggle" />
                  </tr>
                </thead>
                <tbody>
                  {pano.conversations.length === 0 && (
                    <tr className="empty-row">
                      <td colSpan={5}>该用户暂无会话</td>
                    </tr>
                  )}
                  {pano.conversations.map((c) => {
                    const open = openConv?.id === c.id
                    return (
                      <>
                        <tr key={c.id} className={open ? 'row-open' : ''} onClick={() => toggleConv(c.id)}>
                          <td className="col-title">
                            <b>{c.title}</b>
                          </td>
                          <td className="mono dim col-cnt">{c.messageCount}</td>
                          <td className="mono dim col-time">{fmtDateTime(c.createdAt)}</td>
                          <td className="mono dim col-time">{fmtDateTime(c.updatedAt)}</td>
                          <td className="col-toggle">
                            <span className="toggle-caret">{open ? '▾' : '▸'}</span>
                          </td>
                        </tr>
                        {open && openConv && (
                          <tr key={`${c.id}-detail`} className="row-detail">
                            <td colSpan={5}>
                              <ConversationDetail conv={openConv} />
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">
                <i className="title-glyph purple" />
                生效系统提示词
              </h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowPrompt((v) => !v)}>
                {showPrompt ? '收起' : '查看'}
              </button>
            </div>
            {showPrompt && (
              <pre className="ai-prompt-view ai-insight-prompt">
                {pano.prompt || '（该用户无生效档案，无提示词）'}
              </pre>
            )}
            <p className="form-hint muted audit-hint">
              内置金融分析指令 + 档案追加要求 + 该用户的长期记忆 + 实时行情快照，即此用户每次提问时模型收到的完整上下文。
            </p>
          </section>
        </>
      )}
    </div>
  )
}
