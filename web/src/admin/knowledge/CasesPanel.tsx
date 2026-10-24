import { useTranslation } from 'react-i18next'
import type { CSSProperties } from 'react'
/**
 * 案例窗（可见上下文与未来结果分列存储防泄漏；检索只返回可见字段）。
 */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'

interface CaseWindow {
  id: string
  symbol: string
  interval: string
  atTime: number
  published: boolean
  annotation: string
  visibleContext: { regime?: string; alwaysIn?: string }
}

export default function CasesPanel({ onError }: { onError: (msg: string) => void }): JSX.Element {
  const { t } = useTranslation('admin')
  const [cases, setCases] = useState<CaseWindow[]>([])
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [interval, setIntervalStr] = useState('15m')
  const [annotation, setAnnotation] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const r = await api<{ cases: CaseWindow[] }>('/admin/knowledge/cases?all=1')
      setCases(r.cases)
    } catch (e) {
      onError((e as Error).message)
    }
  }, [onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const build = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('/admin/knowledge/cases', {
        method: 'POST',
        body: { symbol, marketType: 'usdm_perp', interval, annotation },
      })
      await refresh()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel fx-in" style={{ '--fx-i': 5 } as CSSProperties}>
      <h4>{t('案例窗（可见上下文与未来结果分列；检索只返回可见字段）')}</h4>
      <div className="admin-row">
        <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder={t("交易对")} />
        <select value={interval} onChange={(e) => setIntervalStr(e.target.value)}>
          <option value="5m">5m</option>
          <option value="15m">15m</option>
          <option value="1h">1h</option>
          <option value="4h">4h</option>
        </select>
        <input value={annotation} onChange={(e) => setAnnotation(e.target.value)} placeholder={t("人工结构标注，如：多头回调 H2 二次进场")} />
        <button className="btn btn-primary" disabled={busy} onClick={() => void build()}>{busy ? t('构建中…') : t('构建案例窗')}</button>
      </div>
      <table className="mini-table">
        <thead><tr><th>{t('序列')}</th><th>{t('决策时')}</th><th>{t('状态')}</th><th>{t('决策时结构')}</th><th>{t('操作')}</th></tr></thead>
        <tbody>
          {cases.map((c) => (
            <tr key={c.id}>
              <td>{c.symbol} {c.interval}</td>
              <td>{new Date(c.atTime).toLocaleString()}</td>
              <td>{c.published ? t('已发布') : t('待审核')}</td>
              <td>{c.visibleContext.regime ?? '-'} / {c.visibleContext.alwaysIn ?? '-'}</td>
              <td className="actions">
                {!c.published && (
                  <button className="btn-primary" onClick={() => void api(`/admin/knowledge/cases/${c.id}/publish`, { method: 'POST' }).then(() => refresh()).catch((e: Error) => onError(e.message))}>
                    {t('发布')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
