import { useEffect, useState } from 'react'
import { api } from '../api'

interface Access { totalLimit: number; used: number; dailyLimit: number | null; requestsPerMinute: number }
export function UserAccessPanel({ username, onClose }: { username: string; onClose: () => void }): JSX.Element {
  const [access, setAccess] = useState<Access | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [total, setTotal] = useState(''), [daily, setDaily] = useState(''), [minute, setMinute] = useState('')
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [password, setPassword] = useState('')
  useEffect(() => { let alive = true; void api<{ access: Access | null }>(`/admin/users/${encodeURIComponent(username)}/ai-access`).then(r => { if (!alive) return; setAccess(r.access); if (r.access) { setTotal(String(r.access.totalLimit)); setDaily(r.access.dailyLimit === null ? '' : String(r.access.dailyLimit)); setMinute(String(r.access.requestsPerMinute)) } }).catch(e => { if (alive) setError((e as Error).message) }).finally(() => { if (alive) setLoading(false) }); return () => { alive = false } }, [username])
  async function save(): Promise<void> {
    setBusy(true); setError(''); setMessage('')
    try { const r = await api<{ access: Access }>(`/admin/users/${encodeURIComponent(username)}/ai-access`, { method: 'PUT', body: { totalLimit: Number(total), dailyLimit: daily.trim() ? Number(daily) : null, requestsPerMinute: Number(minute) } }); setAccess(r.access); setMessage('额度已保存，已用计数保留。新请求立即按新上限判断。') }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function reset(): Promise<void> {
    if (!window.confirm(`确认重置 ${username} 的密码？原密码和已有会话将失效。`)) return
    setBusy(true); setError(''); setPassword('')
    try { const r = await api<{ password: string }>(`/admin/users/${encodeURIComponent(username)}/reset-credentials`, { method: 'POST', body: {} }); setPassword(r.password) }
    catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <section className="admin-delivery" aria-label={`${username} 额度与交付`}><div className="panel-head"><h3>{username} · 额度与凭据管理</h3><button className="btn btn-ghost" onClick={onClose}>关闭并清除密码</button></div>{loading ? <p role="status">加载额度…</p> : access ? <><p>已用 {access.used} / 累计上限 {access.totalLimit}；剩余 {Math.max(0, access.totalLimit - access.used)}。续开请提高累计上限，保留既有用量。</p><div className="admin-provision-grid"><label>累计上限<input type="number" min={0} max={100000} value={total} onChange={e => setTotal(e.target.value)} /></label><label>每日上限（留空不限）<input type="number" min={1} max={100000} value={daily} onChange={e => setDaily(e.target.value)} /></label><label>每分钟上限<input type="number" min={1} max={60} value={minute} onChange={e => setMinute(e.target.value)} /></label></div><button className="btn btn-primary" disabled={busy} onClick={() => void save()}>保存额度</button></> : <p>该账号尚未纳入新开通额度管理，继续执行原有聊天策略。</p>}<button className="btn btn-ghost" disabled={busy} onClick={() => void reset()}>重置交付密码并退出已有会话</button>{password && <label>新密码（请安全交付，关闭即清除）<input readOnly autoComplete="off" value={password} onFocus={e => e.currentTarget.select()} /></label>}{message && <p role="status">{message}</p>}{error && <p role="alert" className="err-text">{error}</p>}</section>
}
