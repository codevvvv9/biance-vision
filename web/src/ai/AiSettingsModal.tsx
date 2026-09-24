import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../api'
import { useAi } from './AiContext'
import type { AdminUser } from '../types'

interface Props {
  onClose: () => void
}

interface ProfileForm {
  baseUrl: string
  apiKey: string
  model: string
  temperature: string
  maxTokens: string
  extraPrompt: string
  dailyLimit: string
  allowedUsers: string // 逗号分隔，表单态
}

const EMPTY_PROFILE: ProfileForm = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: '',
  temperature: '',
  maxTokens: '',
  extraPrompt: '',
  dailyLimit: '',
  allowedUsers: '',
}

const toForm = (p: {
  baseUrl: string
  model: string
  apiKeyMasked: string
  temperature?: number
  maxTokens?: number
  extraPrompt?: string
  dailyLimit?: number
  allowedUsers?: string[]
}): ProfileForm => ({
  baseUrl: p.baseUrl || 'https://api.openai.com/v1',
  apiKey: p.apiKeyMasked,
  model: p.model,
  temperature: p.temperature === undefined ? '' : String(p.temperature),
  maxTokens: p.maxTokens === undefined ? '' : String(p.maxTokens),
  extraPrompt: p.extraPrompt ?? '',
  dailyLimit: p.dailyLimit === undefined ? '' : String(p.dailyLimit),
  allowedUsers: (p.allowedUsers ?? []).join(', '),
})

/** AI 大模型设置（仅超级管理员）：多档案 + 用户绑定；Key 只存服务端，界面回显打码 */
export default function AiSettingsModal({ onClose }: Props): JSX.Element {
  const { refresh, status } = useAi()
  const [profiles, setProfiles] = useState<Record<string, ProfileForm>>({ default: EMPTY_PROFILE })
  const [current, setCurrent] = useState('default')
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [promptView, setPromptView] = useState<string | null>(null)
  const [modelOptions, setModelOptions] = useState<string[]>([])
  const [allUsers, setAllUsers] = useState<string[]>([])

  useEffect(() => {
    api<{ profiles: Record<string, Parameters<typeof toForm>[0]> }>('/ai/config')
      .then((r) => {
        const entries = Object.entries(r.profiles ?? {})
        if (entries.length > 0) {
          setProfiles(Object.fromEntries(entries.map(([name, p]) => [name, toForm(p)])))
        }
      })
      .catch((e: Error) => setResult({ ok: false, message: e.message }))
      .finally(() => setLoading(false))
    // 绑定用户候选：与「用户列表」同源的精确用户名（区分大小写）
    api<{ users: AdminUser[] }>('/admin/users')
      .then((r) => setAllUsers(r.users.map((u) => u.username)))
      .catch(() => {
        /* 拉取失败时退回手输，不阻断设置 */
      })
  }, [])

  // 切换档案时拉取该档案的模型候选与提示词（收起旧内容）
  useEffect(() => {
    setPromptView(null)
    setModelOptions([])
    if (loading) return
    api<{ models: string[] }>(`/ai/models?name=${encodeURIComponent(current)}`)
      .then((r) => setModelOptions(r.models))
      .catch(() => {
        /* noop */
      })
  }, [current, loading])

  const form = profiles[current] ?? EMPTY_PROFILE

  const setField = (k: keyof ProfileForm, v: string): void => {
    setProfiles((prev) => ({ ...prev, [current]: { ...(prev[current] ?? EMPTY_PROFILE), [k]: v } }))
  }

  const boundUsers = form.allowedUsers.split(/[,，\s]+/).filter(Boolean)
  const unknownUsers = allUsers.length > 0 ? boundUsers.filter((u) => !allUsers.includes(u)) : []

  const toggleBoundUser = (u: string): void => {
    const next = boundUsers.includes(u) ? boundUsers.filter((x) => x !== u) : [...boundUsers, u]
    setField('allowedUsers', next.join(', '))
  }

  const addProfile = (): void => {
    const name = window.prompt('新档案名（1~24 位字母 / 数字 / _ / -）')?.trim()
    if (!name) return
    if (!/^[a-zA-Z0-9_-]{1,24}$/.test(name)) {
      setResult({ ok: false, message: `档案名「${name}」不合法` })
      return
    }
    if (profiles[name]) {
      setResult({ ok: false, message: `档案「${name}」已存在` })
      return
    }
    setProfiles((prev) => ({ ...prev, [name]: { ...EMPTY_PROFILE, baseUrl: '' } }))
    setCurrent(name)
    setResult(null)
  }

  const removeCurrent = (): void => {
    if (current === 'default') return
    if (!window.confirm(`删除档案「${current}」？绑定该档案的用户将回落到 default。`)) return
    setProfiles((prev) => {
      const next = { ...prev }
      delete next[current]
      return next
    })
    setCurrent('default')
  }

  const viewPrompt = async (): Promise<void> => {
    if (promptView !== null) {
      setPromptView(null)
      return
    }
    try {
      const r = await api<{ prompt: string }>(`/ai/prompt?name=${encodeURIComponent(current)}`)
      setPromptView(r.prompt)
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message })
    }
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    try {
      const r = await api<{ ok: boolean; message: string }>(`/ai/test?name=${encodeURIComponent(current)}`, {
        method: 'POST',
        body: form,
      })
      setResult({ ok: r.ok, message: r.ok ? '连接成功，Key 有效' : `连接失败：${r.message}` })
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setResult(null)
    try {
      const payload = {
        profiles: Object.fromEntries(
          Object.entries(profiles).map(([name, p]) => [
            name,
            { ...p, allowedUsers: p.allowedUsers.split(/[,，\s]+/).filter(Boolean) },
          ]),
        ),
      }
      await api('/ai/config', { method: 'PUT', body: payload })
      await refresh()
      onClose()
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const removeAll = async (): Promise<void> => {
    if (!window.confirm('确定清空全部 AI 配置吗？删除后机器人与聊天窗口将不再出现（可随时重新配置）')) return
    try {
      await api('/ai/config', { method: 'DELETE' })
      await refresh()
      onClose()
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message })
    }
  }

  const names = Object.keys(profiles)

  // Portal 渲染到 body：Header 的 backdrop-filter 会破坏 fixed 后代的视口定位，导致弹窗错位
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal ai-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>AI 大模型设置</h3>
          <button className="modal-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="ai-profile-bar">
            <label className="ai-profile-select">
              <span>配置档案</span>
              <select value={current} onChange={(e) => setCurrent(e.target.value)}>
                {names.map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {n === 'default' ? '（默认）' : ''}
                    {profiles[n].allowedUsers ? ` · ${profiles[n].allowedUsers}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn btn-ghost btn-sm" onClick={addProfile}>
              ＋ 新建
            </button>
            <button
              className="btn btn-ghost btn-sm danger"
              onClick={removeCurrent}
              disabled={current === 'default'}
              title={current === 'default' ? 'default 档案不可删除' : `删除档案「${current}」`}
            >
              删除档案
            </button>
          </div>
          <p className="ai-settings-tip">
            兼容 OpenAI 接口格式，保存即生效无需重启。绑定用户的档案优先，其他用户走 <code>default</code>
            ；API Key 只存服务端，不下发浏览器。
          </p>
          <label className="ai-field">
            <span>Base URL</span>
            <input value={form.baseUrl} onChange={(e) => setField('baseUrl', e.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false} />
          </label>
          <label className="ai-field">
            <span>API Key</span>
            <input type="password" value={form.apiKey} onChange={(e) => setField('apiKey', e.target.value)} placeholder="sk-..." spellCheck={false} />
          </label>
          <label className="ai-field">
            <span>模型名称{modelOptions.length > 0 ? '（可下拉选择）' : ''}</span>
            <input
              value={form.model}
              onChange={(e) => setField('model', e.target.value)}
              placeholder="gpt-4o-mini"
              list="ai-model-options"
              spellCheck={false}
            />
            {modelOptions.length > 0 && (
              <datalist id="ai-model-options">
                {modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}
          </label>
          <div className="ai-field-row">
            <label className="ai-field">
              <span>temperature（0~2，空 = 0.7）</span>
              <input type="number" min={0} max={2} step={0.1} value={form.temperature} onChange={(e) => setField('temperature', e.target.value)} placeholder="0.7" />
            </label>
            <label className="ai-field">
              <span>输出上限（空 = 不限）</span>
              <input type="number" min={0} step={256} value={form.maxTokens} onChange={(e) => setField('maxTokens', e.target.value)} placeholder="如 2048" />
            </label>
            <label className="ai-field">
              <span>每人每日次数（空 = 不限）</span>
              <input type="number" min={0} step={10} value={form.dailyLimit} onChange={(e) => setField('dailyLimit', e.target.value)} placeholder="如 50" />
            </label>
          </div>
          {current !== 'default' && (
            <div className="ai-field">
              <span>绑定用户（逗号分隔，留空 = 不绑定；绑定的用户使用本档案而非 default）</span>
              <input value={form.allowedUsers} onChange={(e) => setField('allowedUsers', e.target.value)} placeholder="如 zhangsan, lisi" spellCheck={false} />
              {allUsers.length > 0 && (
                <div className="ai-user-chips">
                  {allUsers.map((u) => {
                    const bound = boundUsers.includes(u)
                    return (
                      <button
                        key={u}
                        type="button"
                        className={`ai-user-chip ${bound ? 'is-bound' : ''}`}
                        onClick={() => toggleBoundUser(u)}
                        title={bound ? '点击解除绑定' : '点击绑定该用户'}
                      >
                        {bound ? '✓ ' : '+ '}
                        {u}
                      </button>
                    )
                  })}
                </div>
              )}
              {unknownUsers.length > 0 && (
                <p className="ai-user-warn">
                  「{unknownUsers.join('、')}」不在系统用户列表中——绑定按用户名精准匹配（区分大小写），请到「管理」页核对
                </p>
              )}
            </div>
          )}
          <div className="ai-field">
            <span className="ai-field-label-row">
              追加系统提示词（可选）
              <button className="ai-prompt-toggle" onClick={() => void viewPrompt()} title="查看当前档案生效的完整系统提示词">
                ❗ {promptView === null ? '查看当前生效提示词' : '收起提示词'}
              </button>
            </span>
            <textarea
              rows={3}
              value={form.extraPrompt}
              onChange={(e) => setField('extraPrompt', e.target.value)}
              placeholder="追加在内置金融分析提示词之后，例如：回答控制在 300 字内；重点关注主流币"
              spellCheck={false}
            />
          </div>
          {promptView !== null && <pre className="ai-prompt-view">{promptView}</pre>}
          {result && <p className={`ai-settings-result ${result.ok ? 'ok' : 'bad'}`}>{result.message}</p>}
          <div className="ai-settings-actions">
            {status.configured && (
              <button className="btn btn-ghost btn-sm danger ai-del-btn" onClick={() => void removeAll()}>
                清空全部
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => void test()} disabled={testing || loading}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button className="btn btn-sm" onClick={() => void save()} disabled={saving || loading}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
