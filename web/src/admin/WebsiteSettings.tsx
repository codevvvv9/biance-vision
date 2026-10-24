import { useEffect, useState } from 'react'
import { api } from '../api'

interface Contacts { version: 1; revision: number; telegram: string; email: string; updatedAt: number }

export function WebsiteSettings(): JSX.Element {
  const [contacts, setContacts] = useState<Contacts | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const load = (): void => {
    setError('')
    void api<{ contacts: Contacts }>('/admin/website-config').then(r => setContacts(r.contacts)).catch(e => setError((e as Error).message))
  }
  useEffect(load, [])
  async function save(): Promise<void> {
    if (!contacts || busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await api<{ contacts: Contacts }>('/admin/website-config', { method: 'PUT', body: { telegram: contacts.telegram, email: contacts.email, expectedRevision: contacts.revision } })
      setContacts(result.contacts)
      setMessage(`已发布 v${result.contacts.revision}。官网联系页下次打开或刷新时生效，无需重新构建。`)
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="panel admin-website-settings"><div className="panel-head"><h2 className="panel-title">官网公开联系方式</h2><button className="btn btn-ghost" disabled={busy} onClick={load}>刷新</button></div><p className="muted">仅发布公开联系方式。不要填写 Telegram Bot Token、API Key 或其他密钥。Telegram 按钮、用户名和二维码共用此配置。</p>{contacts && <div className="admin-website-form"><label>Telegram 用户名<input value={contacts.telegram} placeholder="留空则不展示 Telegram 联系入口" autoComplete="off" maxLength={33} onChange={e => setContacts({ ...contacts, telegram: e.target.value })} /></label><label>联系邮箱<input type="email" value={contacts.email} maxLength={254} onChange={e => setContacts({ ...contacts, email: e.target.value })} /></label><button className="btn btn-primary" disabled={busy || (!contacts.email.trim() && !contacts.telegram.trim())} onClick={() => void save()}>{busy ? '发布中…' : '保存并发布公开联系方式'}</button></div>}{message && <p role="status">{message}</p>}{error && <p className="err-text" role="alert">{error}</p>}</section>
}
