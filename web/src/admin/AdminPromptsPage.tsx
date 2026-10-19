/**
 * /admin/prompts 提示词注册表管理（P1-6，超管）：
 * 列表/草稿编辑（含占位符文档）/发布确认/回滚/版本 diff/场景作用域选择。
 * 页面底部附 P1-8 研究文案与输入面板配置（免责三段 + chat_input_config）。
 * 数据面：GET/POST/PUT/publish/rollback /api/admin/prompts*（P0-6 已有）+
 * /api/admin/settings/disclaimers、/api/admin/settings/chat-input。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { TASK_SCENES } from 'biance-vision-brooks'
import { Dropdown } from '../research/Dropdown'

/** 与 server/src/research/prompts.ts PROMPT_NAMES 保持同步（客户端不能引 server 模块） */
const PROMPT_NAMES = ['intent-classifier', 'counter-reviewer', 'news-attribution', 'concept-teaching', 'query-rewrite', 'synthesis-writer', 'memory-extraction'] as const

const PROMPT_DESC: Record<string, string> = {
  'intent-classifier': '意图分类（会话层，LLM 纠偏）',
  'counter-reviewer': '反证归纳（run 内；要求每行 [k] 证据编号）',
  'news-attribution': '新闻归因附答（会话层）',
  'concept-teaching': '概念教学附答（会话层）',
  'query-rewrite': '检索查询改写（run 内变体）',
  'synthesis-writer': '受约束综合解释（run 内第 6 调用点；只引用已计算事实/条件/证据）',
  'memory-extraction': '研究记忆提取（run 发布后后台任务）',
}

interface TemplateDto {
  id: string
  name: string
  scene: string
  status: 'draft' | 'published' | 'retired'
  version: number
  content: string
  note: string
  publishedAt: number | null
  createdAt: number
}

interface DisclaimerConfig {
  common: string
  perp: string
  event: string
}

const SCENE_OPTIONS = [
  { value: '', label: '全局（所有场景）' },
  ...TASK_SCENES.map((s) => ({ value: s, label: `场景：${s}` })),
]

/** 行级 diff（与生效版对比）：删除行红、新增行绿；首尾空白忽略 */
function lineDiff(base: string, next: string): { kind: 'same' | 'add' | 'del'; text: string }[] {
  const a = base.split('\n')
  const b = next.split('\n')
  // 简易 LCS（模板都是几十行，O(n·m) 足够）
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: { kind: 'same' | 'add' | 'del'; text: string }[] = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: a[i] }); i++ }
    else { out.push({ kind: 'add', text: b[j] }); j++ }
  }
  while (i < m) { out.push({ kind: 'del', text: a[i] }); i++ }
  while (j < n) { out.push({ kind: 'add', text: b[j] }); j++ }
  return out
}

export default function AdminPromptsPage(): JSX.Element {
  const [templates, setTemplates] = useState<TemplateDto[]>([])
  const [pointers, setPointers] = useState<{ name: string; scene: string; publishedId: string }[]>([])
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  // 新建草稿表单
  const [newName, setNewName] = useState<string>(PROMPT_NAMES[0])
  const [newScene, setNewScene] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newNote, setNewNote] = useState('')
  // 编辑中的草稿
  const [editing, setEditing] = useState<TemplateDto | null>(null)
  const [editContent, setEditContent] = useState('')
  // diff 视图（草稿 vs 同作用域生效版）
  const [diffOf, setDiffOf] = useState<TemplateDto | null>(null)
  // 免责与输入配置
  const [disclaimers, setDisclaimers] = useState<DisclaimerConfig | null>(null)
  const [chatInputText, setChatInputText] = useState('{\n  "scenes": {}\n}')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [p, d, ci] = await Promise.all([
        api<{ templates: TemplateDto[]; pointers: { name: string; scene: string; publishedId: string }[] }>('/admin/prompts'),
        api<{ disclaimers: DisclaimerConfig }>('/admin/settings/disclaimers'),
        api<{ chatInput: unknown }>('/admin/settings/chat-input'),
      ])
      setTemplates(p.templates)
      setPointers(p.pointers)
      setDisclaimers(d.disclaimers)
      setChatInputText(JSON.stringify(ci.chatInput ?? { scenes: {} }, null, 2))
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const groups = useMemo(() => {
    const map = new Map<string, TemplateDto[]>()
    for (const t of templates) {
      const key = `${t.name}@@${t.scene}`
      const list = map.get(key) ?? []
      list.push(t)
      map.set(key, list)
    }
    for (const list of map.values()) list.sort((a, b) => b.version - a.version)
    return [...map.entries()].sort(([ka], [kb]) => ka.localeCompare(kb))
  }, [templates])

  const pointerOf = (name: string, scene: string): string | undefined => pointers.find((p) => p.name === name && p.scene === scene)?.publishedId

  const run = async (fn: () => Promise<void>, okMsg: string): Promise<void> => {
    if (busy) return
    setBusy(true); setError(''); setMessage('')
    try {
      await fn()
      setMessage(okMsg)
      await refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const createDraft = (): void => {
    void run(async () => {
      await api('/admin/prompts', { method: 'POST', body: { name: newName, scene: newScene, content: newContent, note: newNote } })
      setNewContent(''); setNewNote('')
    }, '草稿已创建（发布后生效指针切换，新 run 才冻结新文）')
  }

  const saveDraft = (): void => {
    if (editing === null) return
    void run(async () => {
      await api(`/admin/prompts/${editing.id}`, { method: 'PUT', body: { content: editContent } })
      setEditing(null)
    }, '草稿已保存（仍可继续编辑；发布后不可变）')
  }

  const publish = (t: TemplateDto): void => {
    if (!window.confirm(`发布「${t.name}」v${t.version}（场景 ${t.scene || '全局'}）？\n发布后指针切换：只影响之后创建的 run（冻结语义，运行中的 run 不受影响）。`)) return
    void run(async () => { await api(`/admin/prompts/${t.id}/publish`, { method: 'POST' }) }, `已发布「${t.name}」v${t.version}`)
  }

  const rollback = (t: TemplateDto): void => {
    if (!window.confirm(`回滚「${t.name}」（场景 ${t.scene || '全局'}）到 v${t.version}？\n同样只影响之后创建的 run。`)) return
    void run(async () => { await api(`/admin/prompts/${t.id}/rollback`, { method: 'POST' }) }, `已回滚「${t.name}」到 v${t.version}`)
  }

  const saveDisclaimers = (): void => {
    if (disclaimers === null) return
    void run(async () => { await api('/admin/settings/disclaimers', { method: 'PUT', body: disclaimers }) }, '免责文案已保存（即时生效，不重启）')
  }

  const saveChatInput = (): void => {
    void run(async () => {
      let parsed: unknown
      try {
        parsed = JSON.parse(chatInputText)
      } catch {
        throw new Error('输入面板配置不是合法 JSON')
      }
      await api('/admin/settings/chat-input', { method: 'PUT', body: parsed })
    }, '输入面板配置已保存（非法结构会被服务端拒绝）')
  }

  return (
    <div className="admin-page">
      <h3>提示词注册表</h3>
      <p className="admin-hint">
        七个模板的版本化生命周期：草稿可编辑 → 发布不可变 → 回滚=指针切回历史版本。
        发布只影响之后创建的 run（创建时全文冻结进 frozenConfig，执行阶段不再解析指针）。
        场景作用域：同名模板可按 (name, scene) 差异化；'' 为全局缺省。
      </p>
      {error !== '' && <p className="err-text" role="alert">{error}</p>}
      {message !== '' && <p className="ok-text" role="status">{message}</p>}

      <section className="admin-card">
        <h4>新建草稿</h4>
        <div className="prompt-form-row">
          <label>模板
            <Dropdown ariaLabel="模板名" value={newName} disabled={busy} onChange={v => setNewName(v)} options={PROMPT_NAMES.map(n => ({ value: n, label: `${n}（${PROMPT_DESC[n] ?? ''}）` }))} />
          </label>
          <label>场景作用域
            <Dropdown ariaLabel="场景作用域" value={newScene} disabled={busy} onChange={setNewScene} options={SCENE_OPTIONS} />
          </label>
        </div>
        <textarea className="prompt-editor" aria-label="模板内容" value={newContent} onChange={e => setNewContent(e.target.value)} placeholder="模板内容（1-20000 字）" rows={5} />
        <input className="prompt-note-input" aria-label="备注" value={newNote} onChange={e => setNewNote(e.target.value)} placeholder="备注（如：调整了 [k] 引用要求）" />
        <button className="btn btn-primary" disabled={busy || newContent.trim() === ''} onClick={createDraft}>创建草稿</button>
      </section>

      <section className="admin-card">
        <h4>版本列表（{templates.length}）</h4>
        {groups.map(([key, list]) => {
          const [name, scene] = key.split('@@')
          const activeId = pointerOf(name, scene)
          const active = list.find((t) => t.id === activeId) ?? null
          return (
            <div key={key} className="prompt-group">
              <div className="prompt-group-head">
                <strong>{name}</strong>
                <span className="prompt-group-scene">{scene === '' ? '全局' : `场景 ${scene}`}</span>
                {active !== null && <span className="prompt-active-tag">生效 v{active.version}</span>}
              </div>
              <ul className="prompt-version-list">
                {list.map((t) => (
                  <li key={t.id} className={`prompt-version pv-${t.status}`}>
                    <span>v{t.version}</span>
                    <span className={`prompt-status ps-${t.status}`}>{t.status === 'draft' ? '草稿' : t.status === 'published' ? '已发布' : '历史'}</span>
                    {t.id === activeId && <span className="prompt-active-tag">← 当前生效</span>}
                    <span className="prompt-note-text">{t.note}</span>
                    <span className="prompt-actions">
                      {t.status === 'draft' && (
                        <>
                          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setEditing(t); setEditContent(t.content); setDiffOf(active !== null ? t : null) }}>编辑</button>
                          {active !== null && active.id !== t.id && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setDiffOf(diffOf?.id === t.id ? null : t)}>{diffOf?.id === t.id ? '收起 diff' : '对比生效版'}</button>}
                          <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => publish(t)}>发布</button>
                        </>
                      )}
                      {t.status !== 'draft' && t.id !== activeId && (
                        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => rollback(t)}>回滚到此</button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {diffOf !== null && list.some((t) => t.id === diffOf.id) && active !== null && (
                <div className="prompt-diff" aria-label="与生效版对比">
                  <div className="prompt-diff-head">v{active.version}（生效）→ v{diffOf.version}（草稿）</div>
                  <pre>
                    {lineDiff(active.content, diffOf.content).map((l, i) => (
                      <span key={i} className={`diff-${l.kind}`}>{(l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  ') + l.text}{'\n'}</span>
                    ))}
                  </pre>
                </div>
              )}
            </div>
          )
        })}
      </section>

      {editing !== null && (
        <section className="admin-card">
          <h4>编辑草稿：{editing.name} v{editing.version}（场景 {editing.scene || '全局'}）</h4>
          <textarea className="prompt-editor" aria-label="草稿内容" value={editContent} onChange={e => setEditContent(e.target.value)} rows={12} />
          <div className="prompt-actions">
            <button className="btn btn-primary" disabled={busy || editContent.trim() === ''} onClick={saveDraft}>保存草稿</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => { setEditing(null); setDiffOf(null) }}>取消</button>
          </div>
        </section>
      )}

      <section className="admin-card">
        <h4>占位符与格式约定</h4>
        <ul className="admin-hint-list">
          <li><code>{'{{vertical}}'}</code>：产品差异化约束段（服务端按 product 注入）</li>
          <li><code>{'{{traderProfile}}'}</code>：用户画像单行摘要（创建 run 时冻结）</li>
          <li><code>{'{{memory}}'}</code>：用户长期研究记忆块（≤400 字，创建时注入）</li>
          <li><code>{'{{knowledgeVersion}}'}</code>：本 run 冻结的知识版本 id</li>
          <li>[k] 证据编号：counter-reviewer / synthesis-writer 要求逐行/逐句标注；无合适证据标 [0]</li>
          <li>否定性约束必须保留：禁止编造数字 / 禁止概率胜率数字 / 只引用给出的内容</li>
        </ul>
      </section>

      <h3>研究文案与输入配置</h3>
      <section className="admin-card">
        <h4>免责文案（P1-8，即时生效）</h4>
        {disclaimers !== null && (
          <>
            <label>通用<textarea className="prompt-editor" aria-label="通用免责" value={disclaimers.common} onChange={e => setDisclaimers({ ...disclaimers, common: e.target.value })} rows={2} /></label>
            <label>永续研究<textarea className="prompt-editor" aria-label="永续免责" value={disclaimers.perp} onChange={e => setDisclaimers({ ...disclaimers, perp: e.target.value })} rows={2} /></label>
            <label>事件合约研究<textarea className="prompt-editor" aria-label="事件免责" value={disclaimers.event} onChange={e => setDisclaimers({ ...disclaimers, event: e.target.value })} rows={2} /></label>
            <button className="btn btn-primary" disabled={busy} onClick={saveDisclaimers}>保存免责文案</button>
          </>
        )}
      </section>
      <section className="admin-card">
        <h4>输入面板配置（chat_input_config）</h4>
        <p className="admin-hint">JSON：{'{ scenes: { [产品或场景]: { placeholder?, suggestionLimit? } } }'}；产品键 spot/perp/event，场景键为 TaskScene。缺失回退内置占位。</p>
        <textarea className="prompt-editor" aria-label="输入面板配置 JSON" value={chatInputText} onChange={e => setChatInputText(e.target.value)} rows={6} />
        <button className="btn btn-primary" disabled={busy} onClick={saveChatInput}>保存输入配置</button>
      </section>
    </div>
  )
}
