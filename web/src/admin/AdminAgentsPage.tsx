/**
 * /admin/agents Agent 配置域（超管）：
 * 五类能力配置（密钥仅引用名）+ 版本流（草稿→发布不可变→回滚）+ 调试运行。
 */
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AgentCapabilities, AgentVersion } from 'biance-vision-brooks'
import { useSpotlight } from '../components/fx/useSpotlight'

const CAP_LABEL: Record<keyof AgentCapabilities, string> = {
  chat: '对话生成',
  embedding: '向量化',
  rerank: '精排',
  vision: '图示理解',
  search: '网页搜索',
  knowledge: '知识库增强',
}

const CAP_DESC: Record<keyof AgentCapabilities, string> = {
  chat: '研究/聊天使用的 LLM（OpenAI 兼容接口）',
  embedding: '知识切块向量化（维度需与库列一致）',
  rerank: '检索精排（未配置时流水线自动跳过）',
  vision: '书中图示理解（多模态模型）',
  search: '反证/新闻检索与原页抓取',
  knowledge: 'R3 索引增强（LLM 生成检索词项，默认关闭）',
}

/** 能力卡状态灯：启用未配 model/baseUrl 视为配置不全（琥珀），齐备为绿，停用为灰 */
function capLight(c: { enabled: boolean; model?: string; baseUrl?: string }): 'off' | 'warn' | 'ok' {
  if (!c.enabled) return 'off'
  if ((c.model ?? '') === '' ) return 'warn'
  return 'ok'
}

const DEFAULT_CONFIG = {
  capabilities: { chat: { enabled: false }, embedding: { enabled: false }, rerank: { enabled: false }, vision: { enabled: false }, search: { enabled: false } },
  roles: [{ name: 'brooks_analyst', promptRef: 'brooks_analyst', tools: ['market_snapshot', 'brooks_engine', 'knowledge_retrieval'], budget: {} }],
  retrieval: { variants: 2, candidateLimit: 40, finalLimit: 8, counterFinalLimit: 5, rerank: true, adjacency: true },
  budgets: { maxToolCalls: 40, maxRuntimeMs: 300000 },
  ruleParams: {},
}

interface DebugRunResult {
  versionLabel: string
  checks: Record<string, string>
  retrievalSmoke: { hits: number; topTitles: string[]; notes: string[] }
}

interface CapTestResult {
  results: Record<string, { status: 'ok' | 'failed' | 'skipped'; detail: string; latencyMs?: number }>
  totalMs: number
}

export default function AdminAgentsPage(): JSX.Element {
  const { t } = useTranslation('admin')
  const capsRef = useRef<HTMLDivElement>(null)
  useSpotlight(capsRef)
  const [versions, setVersions] = useState<AgentVersion[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [caps, setCaps] = useState<AgentCapabilities | null>(null)
  const [capsSource, setCapsSource] = useState('')
  const [capTest, setCapTest] = useState<CapTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  /** search 白名单输入框原始文本（逗号分隔；null=未编辑过，跟随 caps 值） */
  const [searchDomains, setSearchDomains] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [configText, setConfigText] = useState(JSON.stringify(DEFAULT_CONFIG, null, 2))
  const [debug, setDebug] = useState<DebugRunResult | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [v, c] = await Promise.all([
        api<{ versions: AgentVersion[]; currentVersionId: string | null }>('/admin/agents/versions'),
        api<{ capabilities: AgentCapabilities; source: string }>('/admin/agents/capabilities'),
      ])
      setVersions(v.versions)
      setCurrentId(v.currentVersionId)
      setCaps(c.capabilities)
      setCapsSource(c.source)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const saveCaps = async (): Promise<void> => {
    setError('')
    setMessage('')
    try {
      await api('/admin/agents/capabilities', { method: 'PUT', body: caps })
      setMessage(t('能力配置已保存'))
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** 用表单当前值（未保存也可）测连通性：embedding 报告维度与耗时 */
  const testCaps = async (): Promise<void> => {
    setError('')
    setMessage('')
    setCapTest(null)
    setTesting(true)
    try {
      setCapTest(await api<CapTestResult>('/admin/agents/capabilities/test', { method: 'POST', body: { capabilities: caps } }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const createDraft = async (): Promise<void> => {
    setError('')
    setMessage('')
    try {
      let config: unknown
      try {
        config = JSON.parse(configText)
      } catch {
        throw new Error(t('配置 JSON 解析失败'))
      }
      await api('/admin/agents/versions', { method: 'POST', body: { label, config } })
      setMessage(t('草稿已创建'))
      setLabel('')
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const editDraft = async (v: AgentVersion): Promise<void> => {
    setError('')
    try {
      let config: unknown
      try {
        config = JSON.parse(configText)
      } catch {
        throw new Error(t('配置 JSON 解析失败'))
      }
      await api(`/admin/agents/versions/${v.id}`, { method: 'PUT', body: { config } })
      setMessage(t('草稿 {{label}} 已保存', { label: v.label }))
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const action = async (v: AgentVersion, act: 'publish' | 'rollback' | 'debug-run'): Promise<void> => {
    setError('')
    setMessage('')
    try {
      if (act === 'debug-run') {
        setDebug(await api<DebugRunResult>(`/admin/agents/versions/${v.id}/debug-run`, { method: 'POST' }))
        return
      }
      await api(`/admin/agents/versions/${v.id}/${act}`, { method: 'POST' })
      setMessage(t('{{act}}完成：{{label}}', { act: act === 'publish' ? t('发布') : t('回滚'), label: v.label }))
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="admin-page">
      <h3>{t('Agent 配置域')}</h3>
      {error && <p className="err-text">{error}</p>}
      {message && <p className="ok-text">{message}</p>}

      <div className="panel">
        <h4>{t('能力配置（来源：{{src}}）', { src: capsSource === 'agent_version' ? t('当前发布 Agent 版本') : t('全局 app_settings') })}</h4>
        {caps !== null && (
          <>
          <div className="caps-grid" ref={capsRef}>
            {(Object.keys(CAP_LABEL) as (keyof AgentCapabilities)[]).filter((k) => k !== 'knowledge').map((k) => {
              const c = caps[k] as { enabled: boolean; model?: string; baseUrl?: string; secretRef?: string; dims?: number }
              const light = capLight(c)
              return (
                <div key={k} className={`cap-item fx-spot ${c.enabled ? 'on' : ''} light-${light}`}>
                  <div className="cap-head">
                    <label className="cap-switch">
                      <input
                        type="checkbox"
                        checked={c.enabled}
                        onChange={(e) => setCaps({ ...caps, [k]: { ...c, enabled: e.target.checked } })}
                      />
                      <span className="cap-track" aria-hidden><span className="cap-knob" /></span>
                      <strong>{t(CAP_LABEL[k])}</strong>
                    </label>
                    <span className={`cap-light lt-${light}`} title={light === 'ok' ? t('已启用且配置齐备') : light === 'warn' ? t('已启用但 model 未填') : t('未启用')} />
                  </div>
                  <p className="cap-desc">{t(CAP_DESC[k])}</p>
                  <div className="cap-fields">
                    <input value={c.baseUrl ?? ''} placeholder="baseUrl" onChange={(e) => setCaps({ ...caps, [k]: { ...c, baseUrl: e.target.value } })} />
                    <input value={c.model ?? ''} placeholder="model" onChange={(e) => setCaps({ ...caps, [k]: { ...c, model: e.target.value } })} />
                    <input value={c.secretRef ?? ''} placeholder={t("密钥引用名（secrets.json）")} onChange={(e) => setCaps({ ...caps, [k]: { ...c, secretRef: e.target.value } })} />
                    {k === 'embedding' && (
                      <input
                        type="number"
                        value={c.dims ?? 1536}
                        placeholder={t("维度（默认 1536，需与库列一致）")}
                        onChange={(e) => setCaps({ ...caps, [k]: { ...c, dims: Number(e.target.value) || undefined } })}
                      />
                    )}
                    {k === 'search' && (
                      <>
                        <input
                          value={searchDomains ?? (caps.search.allowedDomains ?? []).join(',')}
                          placeholder={t("抓取白名单域名（逗号分隔；留空不限制）")}
                          onChange={(e) => {
                            setSearchDomains(e.target.value)
                            const list = e.target.value.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== '')
                            // 留空 → undefined（不限制）；空数组语义为「不允许任何抓取」，仅 JSON 版本配置可设
                            setCaps({ ...caps, search: { ...caps.search, allowedDomains: list.length > 0 ? list : undefined } })
                          }}
                        />
                        <input
                          type="number"
                          value={caps.search.timeoutMs ?? ''}
                          placeholder={t("搜索/抓取超时 ms（默认 30000）")}
                          onChange={(e) => setCaps({ ...caps, search: { ...caps.search, timeoutMs: Number(e.target.value) || undefined } })}
                        />
                        <input
                          type="number"
                          value={caps.search.maxBytes ?? ''}
                          placeholder={t("原页体积上限字节（默认 1048576）")}
                          onChange={(e) => setCaps({ ...caps, search: { ...caps.search, maxBytes: Number(e.target.value) || undefined } })}
                        />
                        <input
                          type="number"
                          value={caps.search.maxResults ?? ''}
                          placeholder={t("单查询结果数（默认 5）")}
                          onChange={(e) => setCaps({ ...caps, search: { ...caps.search, maxResults: Number(e.target.value) || undefined } })}
                        />
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

            {/* R3 索引增强开关（caps.knowledge.enhance；默认关闭，管理端即开即生效） */}
            {caps.knowledge !== undefined && (() => { const kn = caps.knowledge; return (
              <div className="cap-item fx-spot on light-ok">
                <div className="cap-head">
                  <label className="cap-switch">
                    <input
                      type="checkbox"
                      checked={kn.enhance.enabled}
                      onChange={(e) => setCaps({ ...caps, knowledge: { enhance: { ...kn.enhance, enabled: e.target.checked } } })}
                    />
                    <input type="checkbox" className="cap-track" aria-hidden />
                  </label>
                  <span className="cap-name">{t(CAP_LABEL.knowledge)}</span>
                </div>
                <p className="cap-desc">{t(CAP_DESC.knowledge)}</p>
                <div className="cap-fields">
                  <label>{t('关键词/块')}<input type="number" min={1} max={8} value={kn.enhance.keywordsPerChunk} onChange={(e) => setCaps({ ...caps, knowledge: { enhance: { ...kn.enhance, keywordsPerChunk: Number(e.target.value) || 4 } } })} /></label>
                  <label>{t('问题/块')}<input type="number" min={1} max={4} value={kn.enhance.questionsPerChunk} onChange={(e) => setCaps({ ...caps, knowledge: { enhance: { ...kn.enhance, questionsPerChunk: Number(e.target.value) || 2 } } })} /></label>
                </div>
              </div>
            ); })()}
          </>
        )}
        <div className="admin-row">
          <button className="btn btn-primary" onClick={() => void saveCaps()}>{t('保存能力配置')}</button>
          <button className="btn" disabled={testing} onClick={() => void testCaps()}>{testing ? t('测试中…') : t('测试连通性（按表单值）')}</button>
        </div>
        <p className="muted">{t('密钥本身存 server/data/secrets.json，此处只填引用名')}</p>
        {capTest !== null && (
          <table className="mini-table">
            <thead>
              <tr><th>{t('能力')}</th><th>{t('状态')}</th><th>{t('说明')}</th><th>{t('耗时')}</th></tr>
            </thead>
            <tbody>
              {Object.entries(capTest.results).map(([k, r]) => (
                <tr key={k}>
                  <td>{CAP_LABEL[k as keyof AgentCapabilities] ?? k}</td>
                  <td>{r.status === 'ok' ? `✔ ${t('正常')}` : r.status === 'failed' ? `✖ ${t('失败')}` : `— ${t('跳过')}`}</td>
                  <td>{r.detail}</td>
                  <td>{r.latencyMs !== undefined ? `${r.latencyMs}ms` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h4>{t('版本流')}</h4>
        <table className="mini-table">
          <thead>
            <tr><th>{t('标签')}</th><th>{t('状态')}</th><th>{t('创建')}</th><th>{t('操作')}</th></tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id} className={currentId === v.id ? 'sel-row' : ''}>
                <td>{v.label}{currentId === v.id ? ` ← ${t('当前发布')}` : ''}</td>
                <td>{v.status}</td>
                <td>{new Date(v.createdAt).toLocaleString()}</td>
                <td className="actions">
                  {v.status === 'draft' && (
                    <>
                      <button onClick={() => { setConfigText(JSON.stringify(v.config, null, 2)); void editDraft(v) }}>{t('存当前编辑')}</button>
                      <button className="btn-primary" onClick={() => void action(v, 'publish')}>{t('发布')}</button>
                    </>
                  )}
                  {v.status === 'published' && currentId !== v.id && (
                    <button onClick={() => void action(v, 'rollback')}>{t('回滚到此')}</button>
                  )}
                  <button onClick={() => void action(v, 'debug-run')}>{t('调试运行')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="admin-row">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("新版本标签，如 v1.0.0")} />
          <button className="btn" disabled={label === ''} onClick={() => void createDraft()}>{t('新建草稿')}</button>
        </div>
        <textarea value={configText} onChange={(e) => setConfigText(e.target.value)} rows={14} spellCheck={false} />
      </div>

      {debug && (
        <div className="panel">
          <h4>{t('调试运行：{{label}}', { label: debug.versionLabel })}</h4>
          <ul>
            {Object.entries(debug.checks).map(([k, v]) => (
              <li key={k}><strong>{k}</strong>：{v}</li>
            ))}
          </ul>
          <p>{t('检索冒烟：命中 {{n}} 条', { n: debug.retrievalSmoke.hits })} {debug.retrievalSmoke.topTitles.join('、')}</p>
          {debug.retrievalSmoke.notes.map((n) => (
            <p key={n} className="muted">· {n}</p>
          ))}
        </div>
      )}
    </div>
  )
}
