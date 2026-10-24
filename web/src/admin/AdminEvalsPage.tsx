/**
 * /admin/evals 评测与模型（超管）：数据集 CRUD（版本化）、评测运行与指标、
 * 模型注册表与训练触发（research-py 健康显式呈现）。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import type { EvalDataset, EvalRun, PredictionModelInfo } from 'biance-vision-brooks'

interface ModelRow extends PredictionModelInfo {
  artifactPath: string | null
}

const KIND_LABEL: Record<string, string> = { structure: '结构回放', rag: 'RAG 检索', dialog: '对话', replay: '端到端回放' }

export default function AdminEvalsPage(): JSX.Element {
  const { t } = useTranslation('admin')
  const [datasets, setDatasets] = useState<EvalDataset[]>([])
  const [runs, setRuns] = useState<EvalRun[]>([])
  const [models, setModels] = useState<ModelRow[]>([])
  const [pyHealthy, setPyHealthy] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [kind, setKind] = useState<'rag' | 'structure'>('rag')
  const [name, setName] = useState('')
  const [itemsText, setItemsText] = useState('[]')
  const [modelVersion, setModelVersion] = useState('')
  const [horizon, setHorizon] = useState<'10m' | '30m' | '1h' | '1d' | '1w'>('10m')
  const [openReport, setOpenReport] = useState<string | null>(null)
  const [report, setReport] = useState<Record<string, unknown> | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [d, r, m] = await Promise.all([
        api<{ datasets: EvalDataset[] }>('/admin/evaluations/datasets'),
        api<{ runs: EvalRun[] }>('/admin/evaluations/runs'),
        api<{ models: ModelRow[]; researchPy: { healthy: boolean } }>('/admin/models'),
      ])
      setDatasets(d.datasets)
      setRuns(r.runs)
      setModels(m.models)
      setPyHealthy(m.researchPy.healthy)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), 8000)
    return () => clearInterval(t)
  }, [refresh])

  const createDataset = async (): Promise<void> => {
    setError('')
    setMessage('')
    try {
      let items: unknown
      try {
        items = JSON.parse(itemsText)
      } catch {
        throw new Error(t('条目 JSON 解析失败'))
      }
      const r = await api<{ dataset: EvalDataset }>('/admin/evaluations/datasets', { method: 'POST', body: { kind, name, items } })
      setMessage(t('数据集已创建：{{name}} v{{v}}', { name: r.dataset.name, v: r.dataset.version }))
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const triggerRun = async (datasetId: string): Promise<void> => {
    setError('')
    try {
      await api('/admin/evaluations/runs', { method: 'POST', body: { datasetId } })
      setMessage(t('评测已入队'))
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const train = async (): Promise<void> => {
    setError('')
    setMessage('')
    try {
      await api('/admin/models/train', { method: 'POST', body: { modelVersion, horizon } })
      setMessage(t('训练任务已入队（状态机 training→candidate→published，评测达标后发布）'))
      void refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="admin-page">
      <h3>{t('评测与模型')}</h3>
      {error && <p className="err-text">{error}</p>}
      {message && <p className="ok-text">{message}</p>}
      <p className={`muted ${pyHealthy === false ? 'err-text' : ''}`}>
        research-py：{pyHealthy === null ? t('检测中') : pyHealthy ? t('健康') : t('不可达（docker compose up -d research-py）')}
      </p>

      <div className="panel">
        <h4>{t('数据集')}</h4>
        <table className="mini-table">
          <thead><tr><th>{t('名称')}</th><th>{t('类型')}</th><th>{t('版本')}</th><th>{t('条目')}</th><th>{t('操作')}</th></tr></thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{t(KIND_LABEL[d.kind] ?? d.kind)}</td>
                <td>v{d.version}</td>
                <td>{d.itemCount}</td>
                <td className="actions">
                  <button className="btn-primary" onClick={() => void triggerRun(d.id)}>{t('运行评测')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="admin-row">
          <select value={kind} onChange={(e) => setKind(e.target.value as 'rag' | 'structure')}>
            <option value="rag">{t('RAG 检索')}</option>
            <option value="structure">{t('结构回放')}</option>
          </select>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('数据集名称')} />
          <button className="btn" disabled={name === ''} onClick={() => void createDataset()}>{t('创建')}</button>
        </div>
        <textarea
          value={itemsText}
          onChange={(e) => setItemsText(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={t('RAG：[{"query":"H2 是什么","expectDocTitle":"术语表"}]\n结构：[{"symbol":"BTCUSDT","marketType":"usdm_perp","interval":"1h"}]')}
        />
      </div>

      <div className="panel">
        <h4>{t('评测运行')}</h4>
        <table className="mini-table">
          <thead><tr><th>{t('运行')}</th><th>{t('配置')}</th><th>{t('状态')}</th><th>{t('指标')}</th><th></th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.id.slice(0, 8)}</td>
                <td>{r.configVersion}</td>
                <td>{r.status}</td>
                <td>{r.metrics === null ? '-' : Object.entries(r.metrics).map(([k, v]) => `${k}=${v}`).join(' ')}</td>
                <td>
                  <button
                    onClick={() => {
                      if (openReport === r.id) {
                        setOpenReport(null)
                        return
                      }
                      void api<{ report: Record<string, unknown> | null }>(`/admin/evaluations/runs/${r.id}`)
                        .then((d) => {
                          setReport(d.report)
                          setOpenReport(r.id)
                        })
                        .catch((e: Error) => setError(e.message))
                    }}
                  >
                    {openReport === r.id ? t('收起') : t('报告')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {openReport !== null && report !== null && (
          <pre className="evidence-text">{JSON.stringify(report, null, 2)}</pre>
        )}
      </div>

      <div className="panel">
        <h4>{t('模型注册表')}</h4>
        <table className="mini-table">
          <thead><tr><th>{t('模型')}</th><th>{t('期限')}</th><th>{t('状态')}</th><th>{t('训练截止')}</th><th>{t('指标')}</th></tr></thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.modelVersion}>
                <td>{m.modelVersion}</td>
                <td>{m.horizon}</td>
                <td>{m.status}</td>
                <td>{new Date(m.trainedUntil).toLocaleString()}</td>
                <td>{m.metrics === null ? '-' : Object.entries(m.metrics).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(4) : v}`).join(' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="admin-row">
          <input value={modelVersion} onChange={(e) => setModelVersion(e.target.value)} placeholder={t('模型版本名，如 qgb-10m-001')} />
          <select value={horizon} onChange={(e) => setHorizon(e.target.value as '10m' | '30m' | '1h' | '1d' | '1w')}>
            <option value="10m">{t('10 分钟')}</option>
            <option value="30m">{t('30 分钟')}</option>
            <option value="1h">{t('1 小时')}</option>
            <option value="1d">{t('1 天')}</option>
            <option value="1w">{t('1 周')}</option>
          </select>
          <button className="btn btn-primary" disabled={modelVersion === ''} onClick={() => void train()}>{t('触发训练')}</button>
        </div>
        <p className="muted">{t('训练用库内已收盘 1m K 线：特征只看过去，标签用未来（训练合法）；时间切分 dev/calibration/test = 70/15/15')}</p>
      </div>
    </div>
  )
}
