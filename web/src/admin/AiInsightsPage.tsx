import { Fragment, useCallback, useEffect, useState } from 'react'
import { api, fetchAdminConversation, fetchAdminConversations, fetchAdminUsers } from '../api'
import { useAuth } from '../auth/AuthContext'
import { fmtDateTime } from '../utils'
import type {
  AdminConversationContext,
  AdminConversationDetail,
  AdminConversationSummary,
  AdminMessageCard,
  AiConversationDetail,
  AiConversationSummary,
  AiMemoryItem,
  AiProfileMasked,
  AiUserStat,
  ChatIntent,
  ResearchRunStatus,
} from '../types'

const MEMORY_KIND_LABEL: Record<AiMemoryItem['kind'], string> = {
  preference: '偏好',
  fact: '背景',
  interest: '关注',
  habit: '习惯',
}

/** 研究会话（链路 B）展示用标签 */
const PRODUCT_LABEL: Record<string, string> = { perp: '永续', event: '事件', teaching: '教学' }
const MARKET_LABEL: Record<string, string> = { spot: '现货', usdm_perp: 'U 本位永续' }
const INTENT_LABEL: Record<ChatIntent, string> = {
  concept: '概念问答',
  structure: '当前结构',
  perp: '永续持仓',
  event: '事件研究',
  replay: '历史复盘',
  news: '新闻归因',
  system: '系统',
}
const RUN_STATUS_META: Record<ResearchRunStatus, { label: string; cls: string }> = {
  queued: { label: '排队中', cls: 'act-set' },
  running: { label: '运行中', cls: 'act-rule' },
  validating: { label: '校验中', cls: 'act-set' },
  published: { label: '已发布', cls: 'act-auth' },
  failed: { label: '失败', cls: 'act-fail' },
  cancelled: { label: '已取消', cls: '' },
}
const ROLE_LABEL: Record<AdminConversationDetail['messages'][number]['role'], string> = {
  user: '用户',
  assistant: '助手',
  system: '系统',
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

/** 研究会话上下文摘要行：product/symbol/marketType/horizon，有关联持仓或待确认草稿时标注「持仓草稿」 */
function ResearchContextLine({ ctx }: { ctx: AdminConversationContext }): JSX.Element {
  return (
    <div className="ai-ctx">
      <span className="role-tag mem-preference">{PRODUCT_LABEL[ctx.product ?? ''] ?? ctx.product ?? '未设产品'}</span>
      <span className="mono">{ctx.symbol ?? '—'}</span>
      <span className="dim">{MARKET_LABEL[ctx.marketType ?? ''] ?? ctx.marketType ?? '—'}</span>
      <span className="dim">{ctx.horizon ?? '—'}</span>
      {(ctx.positionId != null && ctx.positionId !== '') || (ctx.draft != null && Object.keys(ctx.draft).length > 0) ? (
        <span className="role-tag mem-interest">持仓草稿</span>
      ) : null}
    </div>
  )
}

/** 内联卡片摘要（只读）：kind + 草稿关键字段 + 完整度 */
function CardSummary({ card }: { card: AdminMessageCard }): JSX.Element {
  const d = card.draft
  const fields: [string, unknown][] = [
    ['交易对', d.symbol],
    ['方向', d.side === 'long' ? '做多' : d.side === 'short' ? '做空' : d.side],
    ['数量', d.qty],
    ['开仓价', d.entryPrice],
    ['杠杆', d.leverage !== undefined && d.leverage !== null ? `${String(d.leverage)}x` : undefined],
    ['风险预算', d.riskBudget],
  ]
  const text = fields
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(' · ')
  return (
    <div className="ai-msg-card">
      <span className="role-tag mem-preference">{card.kind === 'confirm_position' ? '持仓确认卡' : '完成卡'}</span>
      <span className="ai-msg-card-fields mono">{text !== '' ? text : '（草稿无字段）'}</span>
      <span className="dim">
        {card.complete === true ? '字段齐全，可确认写入' : `缺：${(card.missingFields ?? []).join('、') || '必填字段'}`}
      </span>
    </div>
  )
}

/** 研究会话详情（链路 B）：上下文摘要 + 完整消息流（intent 标签 / 内联卡 / 关联研究运行徽标） */
function ResearchConversationDetail({ detail }: { detail: AdminConversationDetail }): JSX.Element {
  return (
    <div className="ai-conv-detail">
      <ResearchContextLine ctx={detail.conversation.context} />
      {detail.messages.length === 0 && <p className="form-hint muted">（该会话暂无消息）</p>}
      {detail.messages.map((m) => {
        const run = m.runId !== null ? detail.runs[m.runId] : undefined
        return (
          <div key={m.id} className={`ai-msg ${m.role}`}>
            <span className="ai-msg-role">{ROLE_LABEL[m.role]}</span>
            {m.intent !== null && <span className="role-tag">{INTENT_LABEL[m.intent]}</span>}
            {m.runId !== null &&
              (run !== undefined ? (
                <span className={`act-tag ${RUN_STATUS_META[run.status].cls}`} title={`runId: ${run.id}`}>
                  研究 · {RUN_STATUS_META[run.status].label} · {run.product}/{run.symbol} {run.horizon}
                </span>
              ) : (
                <span className="act-tag" title={m.runId}>
                  研究 · {m.runId.slice(0, 8)}
                </span>
              ))}
            <span className="mono ai-msg-time">{fmtDateTime(m.createdAt)}</span>
            {m.content !== '' && <p className="ai-msg-content">{m.content}</p>}
            {m.card !== null && <CardSummary card={m.card} />}
          </div>
        )
      })}
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
  /** 研究会话（链路 B）区块独立状态与错误展示，与旧链路互不影响 */
  const [rUsernames, setRUsernames] = useState<string[] | null>(null)
  const [rUser, setRUser] = useState('')
  const [rConvs, setRConvs] = useState<AdminConversationSummary[] | null>(null)
  const [rOpenId, setROpenId] = useState<string | null>(null)
  const [rDetail, setRDetail] = useState<AdminConversationDetail | null>(null)
  const [rError, setRError] = useState('')
  /** 展开详情的加载错误（行内展示，不顶掉会话列表；与列表加载错误 rError 分离） */
  const [rDetailError, setRDetailError] = useState('')

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
    fetchAdminUsers()
      .then((d) => setRUsernames(d.users.map((u) => u.username)))
      .catch((e: Error) => setRError(e.message))
  }, [loadOverview, user])

  const loadConvs = useCallback((username: string): void => {
    fetchAdminConversations(username)
      .then((d) => {
        setRConvs(d.conversations)
        setRError('')
      })
      .catch((e: Error) => setRError(e.message))
  }, [])

  const pickResearchUser = (username: string): void => {
    setRUser(username)
    setROpenId(null)
    setRDetail(null)
    setRDetailError('')
    if (username === '') {
      setRConvs(null)
      return
    }
    setRConvs(null)
    loadConvs(username)
  }

  const toggleResearchConv = (id: string): void => {
    if (rOpenId === id) {
      setROpenId(null)
      setRDetail(null)
      setRDetailError('')
      return
    }
    setROpenId(id)
    setRDetail(null)
    setRDetailError('')
    fetchAdminConversation(id)
      .then((d) => {
        setRDetail(d)
        setRDetailError('')
      })
      .catch((e: Error) => setRDetailError(e.message))
  }

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

  const conf = pano?.profileMasked

  return (
    <div className="page">
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            <i className="title-glyph teal" />
            研究会话
          </h2>
          <div className="audit-toolbar">
            <select value={rUser} onChange={(e) => pickResearchUser(e.target.value)}>
              <option value="">选择用户</option>
              {(rUsernames ?? []).map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost" onClick={() => rUser !== '' && loadConvs(rUser)}>
              刷新
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="table ai-conv-table">
            <thead>
              <tr>
                <th className="col-title">会话</th>
                <th className="col-cnt">消息数</th>
                <th className="col-time">最近更新</th>
                <th className="col-toggle" />
              </tr>
            </thead>
            <tbody>
              {rError !== '' && (
                <tr className="empty-row">
                  <td colSpan={4}>加载失败：{rError}</td>
                </tr>
              )}
              {rError === '' && rUser === '' && (
                <tr className="empty-row">
                  <td colSpan={4}>请选择用户查看其研究会话</td>
                </tr>
              )}
              {rError === '' && rUser !== '' && rConvs === null && (
                <tr className="empty-row">
                  <td colSpan={4}>加载中…</td>
                </tr>
              )}
              {rError === '' && rConvs?.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={4}>该用户暂无研究会话</td>
                </tr>
              )}
              {rError === '' &&
                (rConvs ?? []).map((c) => {
                  const open = rOpenId === c.id
                  return (
                    <Fragment key={c.id}>
                      <tr className={open ? 'row-open' : ''} onClick={() => toggleResearchConv(c.id)}>
                        <td className="col-title">
                          <b>{c.title !== '' ? c.title : '（未命名会话）'}</b>
                        </td>
                        <td className="mono dim col-cnt">{c.messageCount}</td>
                        <td className="mono dim col-time">{fmtDateTime(c.updatedAt)}</td>
                        <td className="col-toggle">
                          <span className="toggle-caret">{open ? '▾' : '▸'}</span>
                        </td>
                      </tr>
                      {open && (
                        <tr className="row-detail">
                          <td colSpan={4}>
                            {rDetail !== null && rDetail.conversation.id === c.id ? (
                              <ResearchConversationDetail detail={rDetail} />
                            ) : rDetailError !== '' ? (
                              <p className="form-hint muted" style={{ padding: '10px 16px' }}>
                                加载失败：{rDetailError}
                              </p>
                            ) : (
                              <p className="form-hint muted" style={{ padding: '10px 16px' }}>
                                加载中…
                              </p>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
            </tbody>
          </table>
        </div>
        <p className="form-hint muted audit-hint">
          链路 B：研究工作台与悬浮助手共用的 conversations 会话。点击会话展开上下文摘要与完整消息流（含意图标签、持仓确认卡与关联研究运行状态）。
        </p>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">
            <i className="title-glyph purple" />
            AI 助手（旧链路）
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
                      <Fragment key={c.id}>
                        <tr className={open ? 'row-open' : ''} onClick={() => toggleConv(c.id)}>
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
                      </Fragment>
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
