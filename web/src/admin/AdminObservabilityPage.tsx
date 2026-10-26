/**
 * 管理端监控页（P2a-4）：三视图最小集——概览（sink 状态/计数/新鲜度）、
 * 错误聚合列表（fingerprint 分组 TopN）、请求精确检索（requestId/originRequestId/
 * 用户名）。趋势图在 P2b 批次。
 * 空数据/加载失败/降级有独立状态（不用 0 假装采集正常）；日志按文本渲染。
 * 视觉走 admin 统一体系：antd 深色主题（app/Theme）+ ui/admin.module.css 原语，
 * 词条在 admin 词典 observability 组（zh/en 双语）。
 */
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "@biance/shared-ui"
import { useTranslation } from "react-i18next"
import { Button, Card, Empty, Input, Statistic, Table, Tag, Typography } from "antd"
import { useAdminText } from "./ui/text"
import { Feedback } from "./ui/feedback"
import { EChart } from "./charts/EChart"
import { httpTrafficOption } from "./charts/options"
import { loadTimeseries } from "./features/dashboard/api"
import { useResource } from "./ui/resource"
import styles from "./ui/admin.module.css"

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

interface AlertRow {
  ruleKey: string
  dimension: string
  state: string
  severity: string
  firstSeen: string
  lastSeen: string
  resolvedAt: string | null
  ackedBy: string | null
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
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString()
}

const severityTag = (v: string): JSX.Element => (
  <Tag color={v === "critical" || v === "high" ? "error" : v === "warn" || v === "warning" ? "warning" : "default"}>{v}</Tag>
)
const stateTag = (v: string): JSX.Element => (
  <Tag color={v === "open" ? "error" : v === "resolved" ? "success" : "processing"}>{v}</Tag>
)

export default function AdminObservabilityPage() {
  const { t } = useTranslation("admin")
  const text = useAdminText()
  const [overview, setOverview] = useState<Overview | null>(null)
  const [errors, setErrors] = useState<ErrorGroupRow[] | null>(null)
  const [logs, setLogs] = useState<LogRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState<{ requestId: string; username: string }>({ requestId: "", username: "" })
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null)
  const http = useResource(loadTimeseries, 300_000)
  const httpChart = useMemo(
    () =>
      http.data && http.data.dbAvailable && http.data.http.buckets.length > 0
        ? httpTrafficOption(http.data.http.buckets, { requests: text("legendRequests"), p95: text("legendP95") })
        : null,
    [http.data, text],
  )

  const refresh = useCallback(async () => {
    setLoadError(null)
    try {
      const [ov, er, al] = await Promise.all([
        api<Overview>("/admin/observability/overview"),
        api<{ items: ErrorGroupRow[] }>("/admin/observability/errors?limit=50"),
        api<{ items: AlertRow[] }>("/admin/observability/alerts"),
      ])
      setOverview(ov)
      setErrors(er.items)
      setAlerts(al.items)
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [])

  const [diagGrant, setDiagGrant] = useState<{ grantId: string; expiresAt: string } | null>(null)
  const grantDiagnostics = useCallback(async () => {
    try {
      const r = await api<{ grantId: string; expiresAt: string }>('/admin/observability/diagnostics', { method: 'POST', body: { target: 'admin' } })
      setDiagGrant(r)
      // P3-2：授权后挂只读 façade（15 分钟自动清；登出/撤销后自查 404 即卸载）
      ;(window as unknown as { __BV_DEBUG__?: unknown }).__BV_DEBUG__ = {
        snapshot: () => ({ environment: 'production', protectionMode: 'shadow', telemetryState: 'ready', recentRequests: [] }),
      }
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [])
  const revokeDiagnostics = useCallback(async () => {
    if (diagGrant === null) return
    try {
      await api(`/admin/observability/diagnostics/${diagGrant.grantId}`, { method: 'DELETE' })
      delete (window as unknown as { __BV_DEBUG__?: unknown }).__BV_DEBUG__
      setDiagGrant(null)
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [diagGrant])

  const ackAlert = useCallback(async (key: string) => {
    try {
      await api(`/admin/observability/alerts/${encodeURIComponent(key)}/ack`, { method: 'POST' })
      void refresh()
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [refresh])

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
    <div className={styles.stack}>
      <Feedback error={loadError ?? undefined} />

      <Card
        title={t("observability.overview")}
        extra={<Button onClick={() => { void refresh() }}>{t("observability.refresh")}</Button>}
      >
        {overview === null ? (
          <Typography.Text type="secondary">{t("observability.loading")}</Typography.Text>
        ) : (
          <div className={styles.grid}>
            <Statistic title={t("observability.inboxRecent")} value={overview.inbox.recent15m} />
            <Statistic title={t("observability.errorsRecent")} value={overview.errorGroups.recent15m} />
            <Statistic title={t("observability.errorsOpen")} value={overview.errorGroups.open} />
            <Statistic title={t("observability.dropped")} value={overview.sink.dropped} />
            <Statistic title={t("observability.lastFlush")} value={fmtTime(overview.sink.lastFlushAt)} />
            <Statistic title={t("observability.lastError")} value={fmtTime(overview.sink.lastErrorAt)} />
          </div>
        )}
        {overview !== null && !overview.dbAvailable && (
          <Feedback error={t("observability.dbDown")} />
        )}
      </Card>

      {/* P2b 预留的趋势位（v0.18.4 兑现）：HTTP 流量与延迟 24h；5 分钟自轮询 */}
      <Card title={t("ui.chartHttpTraffic")}>
        {httpChart === null ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("ui.noTimeseries")} />
        ) : (
          <EChart option={httpChart} height={300} />
        )}
      </Card>

      <Card title={t("observability.alerts")}>
        {alerts === null ? (
          <Typography.Text type="secondary">{t("observability.loading")}</Typography.Text>
        ) : alerts.length === 0 ? (
          <Empty description={t("observability.noAlerts")} />
        ) : (
          <Table<AlertRow>
            rowKey={(a) => a.ruleKey + a.dimension}
            size="small"
            pagination={false}
            dataSource={alerts}
            columns={[
              { title: t("observability.rule"), dataIndex: "ruleKey", key: "rule", render: (v: string) => <span className={styles.mono}>{v}</span> },
              { title: t("observability.severity"), dataIndex: "severity", key: "severity", render: severityTag },
              {
                title: t("observability.state"), dataIndex: "state", key: "state",
                render: (v: string, r: AlertRow) => <>{stateTag(v)}{r.ackedBy !== null && <Typography.Text type="secondary"> ({r.ackedBy})</Typography.Text>}</>,
              },
              { title: t("observability.firstSeen"), dataIndex: "firstSeen", key: "firstSeen", render: fmtTime },
              { title: t("observability.lastSeen"), dataIndex: "lastSeen", key: "lastSeen", render: fmtTime },
              {
                key: "action",
                render: (_: unknown, r: AlertRow) =>
                  r.state === "open" && (
                    <Button size="small" onClick={() => { void ackAlert(r.ruleKey) }}>{t("observability.ack")}</Button>
                  ),
              },
            ]}
          />
        )}
      </Card>

      <Card title={t("observability.errorGroups")}>
        {errors === null ? (
          <Typography.Text type="secondary">{t("observability.loading")}</Typography.Text>
        ) : errors.length === 0 ? (
          <Empty description={t("observability.emptyErrors")} />
        ) : (
          <Table<ErrorGroupRow>
            rowKey={(e) => `${e.fingerprint}:${e.release}`}
            size="small"
            pagination={false}
            dataSource={errors}
            columns={[
              {
                title: t("observability.fingerprint"), dataIndex: "fingerprint", key: "fingerprint",
                render: (v: string) => <span className={styles.mono} title={v}>{v.slice(0, 40)}</span>,
              },
              { title: t("observability.source"), dataIndex: "source", key: "source" },
              { title: t("observability.count"), dataIndex: "count", key: "count" },
              { title: t("observability.lastSeen"), dataIndex: "lastSeen", key: "lastSeen", render: fmtTime },
            ]}
          />
        )}
      </Card>

      <Card title={t("observability.diagnostics")}>
        <Typography.Paragraph type="secondary">{t("observability.diagnosticsHint")}</Typography.Paragraph>
        <Button
          danger={diagGrant !== null}
          onClick={() => { void (diagGrant === null ? grantDiagnostics() : revokeDiagnostics()) }}
        >
          {diagGrant === null ? t("observability.grantDiag") : t("observability.revokeDiag")}
        </Button>
      </Card>

      <Card title={t("observability.logs")}>
        <div className={styles.toolbar}>
          <div className={styles.filters}>
            <Input
              style={{ width: 280 }}
              allowClear
              placeholder={t("observability.requestIdPlaceholder")}
              value={query.requestId}
              onChange={(e) => setQuery((q) => ({ ...q, requestId: e.target.value, username: "" }))}
              onPressEnter={() => { void searchLogs() }}
            />
            <Input
              style={{ width: 180 }}
              allowClear
              placeholder={t("observability.usernamePlaceholder")}
              value={query.username}
              onChange={(e) => setQuery((q) => ({ ...q, username: e.target.value, requestId: "" }))}
              onPressEnter={() => { void searchLogs() }}
            />
            <Button onClick={() => { void searchLogs() }}>{t("observability.search")}</Button>
          </div>
        </div>
        {logs === null ? (
          <Typography.Text type="secondary">{t("observability.logsHint")}</Typography.Text>
        ) : logs.length === 0 ? (
          <Empty description={t("observability.noMatch")} />
        ) : (
          <Table<LogRow>
            rowKey={(_, i) => String(i)}
            size="small"
            pagination={false}
            dataSource={logs}
            columns={[
              { title: t("observability.time"), dataIndex: "receivedAt", key: "time", render: fmtTime },
              { title: t("observability.source"), dataIndex: "source", key: "source" },
              { title: t("observability.kind"), dataIndex: "kind", key: "kind" },
              {
                title: "requestId", dataIndex: "requestId", key: "requestId",
                render: (v: string | null, l: LogRow) => (
                  <span className={styles.mono} title={l.originRequestId ?? ""}>{v === null ? "—" : v.slice(0, 13)}</span>
                ),
              },
              {
                title: "payload", dataIndex: "payload", key: "payload",
                render: (v: unknown) => <span className={styles.mono}>{JSON.stringify(v).slice(0, 160)}</span>,
              },
            ]}
          />
        )}
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 12 }}>
          {t("observability.samplingNote")}
        </Typography.Paragraph>
      </Card>
    </div>
  )
}
