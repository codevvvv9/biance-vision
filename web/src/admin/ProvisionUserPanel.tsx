import { useEffect, useState } from 'react'
import { api } from '../api'
import AiSettingsModal from './AiSettingsModal'

interface Access { totalLimit: number; dailyLimit: number | null; requestsPerMinute: number; profileName: string }
interface Delivery { username: string; password: string; publicOrigin: string | null; loginPath: string; access: Access }
interface Profile { model: string; apiKeyMasked: string; maxTokens?: number; dailyLimit?: number; allowedUsers?: string[] }

export function ProvisionUserPanel({ onCreated }: { onCreated: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [profiles, setProfiles] = useState<Record<string, Profile>>({})
  const [profile, setProfile] = useState('default')
  const [total, setTotal] = useState('10')
  const [daily, setDaily] = useState('10')
  const [perMinute, setPerMinute] = useState('6')
  const [busy, setBusy] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const loadProfiles = (): void => { void api<{ profiles: Record<string, Profile> }>('/admin/ai/config').then(r => setProfiles(r.profiles)).catch(e => setError((e as Error).message)) }
  useEffect(() => { if (open) loadProfiles() }, [open])
  async function create(): Promise<void> {
    if (busy) return
    setBusy(true); setError(''); setDelivery(null)
    try {
      const result = await api<Delivery>('/admin/users/provision', { method: 'POST', body: { ...(username.trim() ? { username: username.trim() } : {}), profileName: profile, totalLimit: Number(total), dailyLimit: daily.trim() ? Number(daily) : null, requestsPerMinute: Number(perMinute) } })
      setDelivery(result); setShowPassword(false); setCopied(false); setUsername(''); onCreated()
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  async function copy(): Promise<void> {
    if (!delivery) return
    try { await navigator.clipboard.writeText(`Biance Vision\n登录入口：${delivery.publicOrigin || '[既有用户域名]'}${delivery.loginPath}\n用户名：${delivery.username}\n密码：${delivery.password}\n累计 AI 交互额度：${delivery.access.totalLimit}\n首次使用指南：${delivery.publicOrigin || '[既有用户域名]'}/zh/guides/getting-started`); setCopied(true) }
    catch { setError('无法自动复制，请从下方选取用户名和密码手动复制。') }
  }
  const selected = profiles[profile]
  return <section className="panel admin-provision"><div className="panel-head"><h2 className="panel-title">账号人工开通</h2><button className="btn btn-primary" onClick={() => { setOpen(!open); setDelivery(null); setError('') }}>{open ? '收起并清除交付密码' : '＋ 生成用户并配置 AI'}</button></div><p className="muted">不开放自助注册。选择已保存的 AI 档案并设置硬额度，全部保存成功后才显示随机密码。密码只在本次交付中显示，不写入日志或浏览器存储。</p>{open && <><div className="admin-provision-grid"><label>用户名（留空自动生成）<input value={username} maxLength={32} autoComplete="off" placeholder="bv_…" onChange={e => setUsername(e.target.value)} /></label><label>AI 配置档案<select value={profile} onChange={e => setProfile(e.target.value)}>{Object.entries(profiles).map(([name, p]) => <option key={name} value={name}>{name} · {p.model}</option>)}</select></label><label>累计可用交互次数<input type="number" min={1} max={100000} value={total} onChange={e => setTotal(e.target.value)} /></label><label>每日上限（留空不限）<input type="number" min={1} max={100000} value={daily} onChange={e => setDaily(e.target.value)} /></label><label>每分钟请求上限<input type="number" min={1} max={60} value={perMinute} onChange={e => setPerMinute(e.target.value)} /></label><div className="admin-provision-profile"><button className="btn btn-ghost" onClick={() => setAiOpen(true)}>打开 AI 聊天配置：模型 / Key / Token / 工具</button>{selected && <p className="muted">模型 {selected.model}；输出上限 {selected.maxTokens || '按档案设置'}；档案日限 {selected.dailyLimit || '不限'}。累计额度与档案限制取更严格的一项。</p>}</div></div><p className="muted">一次已受理的聊天、翻译或研究入口请求计一次；被拒绝及 HTTP 失败请求退回累计额度。研究任务受理后的执行失败仍计一次；并发请求共享数据库额度，不能超发。</p><button className="btn btn-primary" disabled={busy || !selected?.apiKeyMasked || !Number.isInteger(Number(total)) || Number(total) < 1} onClick={() => void create()}>{busy ? '保存账号、档案绑定与额度…' : '保存全部并生成交付凭据'}</button>{delivery && <div className="admin-delivery" role="status"><strong>账号已开通，请安全交付后关闭本面板</strong><label>用户名<input readOnly value={delivery.username} onFocus={e => e.currentTarget.select()} /></label><label>随机密码<input readOnly type={showPassword ? 'text' : 'password'} value={delivery.password} autoComplete="off" onFocus={e => e.currentTarget.select()} /></label><div><button className="btn btn-ghost" onClick={() => setShowPassword(!showPassword)}>{showPassword ? '隐藏密码' : '显示密码'}</button><button className="btn btn-primary" onClick={() => void copy()}>{copied ? '已复制交付信息' : '复制账号、密码与登录入口'}</button><button className="btn btn-ghost" onClick={() => setDelivery(null)}>已交付，清除密码</button></div><p className="muted">交付时将登录路径拼接到现有用户域名。不要使用管理域名，不把密码放进 URL。关闭后无法再次读取原密码。</p></div>}{error && <p className="err-text" role="alert">{error}</p>}</>}{aiOpen && <AiSettingsModal onClose={() => { setAiOpen(false); loadProfiles() }} />}</section>
}
