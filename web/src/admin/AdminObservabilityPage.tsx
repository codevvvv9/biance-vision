/**
 * 管理端监控页（P2a-4）：三视图最小集——概览（sink 状态/计数/新鲜度）、
 * 错误聚合列表（fingerprint 分组 TopN）、请求精确检索（requestId/originRequestId/
 * 用户名）。趋势图与告警在 P2b 批次。
 * 空数据/加载失败/降级有独立状态（不用 0 假装采集正常）；日志按文本渲染。
 */
import { useCallback, useEffect, useState } from "react"
import { api } from "@biance/shared-ui"
import { useTranslation } from "react-i18next"

interface Overview {
  dbAvailable: boolean
  sink: { queueItems: number; dropped: number; lastFlushAt: number | null; lastErrorAt: number | null }
  inbox: { recent15m: number; total: number }
  errorGroups: { recent15m: number; open: number }
  observedAt: string
}

interface ErrorGroupRow {
  fingerprint: string
  release: string
  source: string
  firstSeen: string
  lastSeen: string
  count: number
  status: string
  sample: unknown
}

interface LogRow {
  source: string
  kind: string
  requestId: string | null
  originRequestId: string | null
  payload: unknown
  receivedAt: string
}

const fmtTime = (v: string | number | null): string => {
  if (v === null) return "—"
  const d = typeof v === "number" ? new Date(v) : new Date(v)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString()
}

export default function AdminObservabilityPage() {
  const { t } = useTranslation("admin")
  const [overview, setOverview] = useState<Overview | null>(null)
  const [errors, setErrors] = useState<ErrorGroupRow[] | null>(null)
  const [logs, setLogs] = useState<LogRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState<{ requestId: string; username: string }>({ requestId: "", username: "" })

  const refresh = useCallback(async () => {
    setLoadError(null)
    try {
      const [ov, er] = await Promise.all([
        api<Overview>("/admin/observability/overview"),
        api<{ items: ErrorGroupRow[] }>("/admin/observability/errors?limit=50"),
      ])
      setOverview(ov)
      setErrors(er.items)
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const searchLogs = useCallback(async () => {
    setLogs(null)
    setLoadError(null)
    try {
      const qs = query.requestId !== ""
        ? `requestId=${encodeURIComponent(query.requestId)}`
        : query.username !== "" ? `username=${encodeURIComponent(query.username)}` : ""
      const r = await api<{ items: LogRow[] }>(`/admin/observability/logs?${qs}&limit=50`)
      setLogs(r.items)
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [query])

  return (
    <div className="observability-page">
      <header className="page-head">
        <h2>{t("observability.title")}</h2>
        <button onClick={() => { void refresh() }}>{t("observability.refresh")}</button>
      </header>
      {loadError !== null && <p className="error-banner">{loadError}</p>}

      <section>
        <h3>{t("observability.overview")}</h3>
        {overview === null ? <p>{t("observability.loading")}</p> : (
          <div className="stat-grid">
            <div><b>{overview.inbox.recent15m}</b><span>{t("observability.inboxRecent")}</span></div>
            <div><b>{overview.errorGroups.recent15m}</b><span>{t("observability.errorsRecent")}</span></div>
            <div><b>{overview.errorGroups.open}</b><span>{t("observability.errorsOpen")}</span></div>
            <div><b>{overview.sink.dropped}</b><span>{t("observability.dropped")}</span></div>
            <div><b>{fmtTime(overview.sink.lastFlushAt)}</b><span>{t("observability.lastFlush")}</span></div>
            <div><b>{overview.sink.lastErrorAt === null ? "—" : fmtTime(overview.sink.lastErrorAt)}</b><span>{t("observability.lastError")}</span></div>
          </div>
        )}
        {overview !== null && !overview.dbAvailable && <p className="error-banner">{t("observability.dbDown")}</p>}
      </section>

      <section>
        <h3>{t("observability.errorGroups")}</h3>
        {errors === null ? <p>{t("observability.loading")}</p> : errors.length === 0 ? (
          <p className="muted">{t("observability.emptyErrors")}</p>
        ) : (
          <table className="data-table">
            <thead><tr>
              <th>{t("observability.fingerprint")}</th><th>{t("observability.source")}</th>
              <th>{t("observability.count")}</th><th>{t("observability.lastSeen")}</th>
            </tr></thead>
            <tbody>
              {errors.map((e) => (
                <tr key={`${e.fingerprint}:${e.release}`}>
                  <td title={e.fingerprint}>{e.fingerprint.slice(0, 40)}</td>
                  <td>{e.source}</td>
                  <td>{e.count}</td>
                  <td>{fmtTime(e.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>{t("observability.logs")}</h3>
        <div className="search-row">
          <input
            placeholder={t("observability.requestIdPlaceholder")}
            value={query.requestId}
            onChange={(e) => setQuery((q) => ({ ...q, requestId: e.target.value, username: "" }))}
          />
          <input
            placeholder={t("observability.usernamePlaceholder")}
            value={query.username}
            onChange={(e) => setQuery((q) => ({ ...q, username: e.target.value, requestId: "" }))}
          />
          <button onClick={() => { void searchLogs() }}>{t("observability.search")}</button>
        </div>
        {logs === null ? <p className="muted">{t("observability.logsHint")}</p> : logs.length === 0 ? (
          <p className="muted">{t("observability.noMatch")}</p>
        ) : (
          <table className="data-table">
            <thead><tr>
              <th>{t("observability.time")}</th><th>{t("observability.source")}</th>
              <th>{t("observability.kind")}</th><th>requestId</th><th>payload</th>
            </tr></thead>
            <tbody>
              {logs.map((l, i) => (
                <tr key={i}>
                  <td>{fmtTime(l.receivedAt)}</td>
                  <td>{l.source}</td>
                  <td>{l.kind}</td>
                  <td title={l.originRequestId ?? ""}>{l.requestId === null ? "—" : l.requestId.slice(0, 13)}</td>
                  <td className="payload-cell">{JSON.stringify(l.payload).slice(0, 160)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">{t("observability.samplingNote")}</p>
      </section>
    </div>
  )
}
