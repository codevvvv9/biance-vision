/**
 * 管理端大盘（v0.18.4 默认首页）：业务洞察（用户增长/消息趋势/上下文热点/
 * 内容词云）优先，系统健康（HTTP 流量/队列积压/研究产出/事件流/文档状态/
 * worker 心跳）其次。快照 30s 轮询，洞察与时序 5 分钟轮询（useResource）。
 * 图表 option 见 charts/options.ts（纯函数）；词条在 admin 词典 ui.* 组。
 */
import { useMemo } from "react";
import { Card, Col, Row, Statistic, Typography } from "antd";
import { api } from "../api";
import { useAdminText } from "./ui/text";
import { useResource } from "./ui/resource";
import { EChart } from "./charts/EChart";
import {
  docStatusOption,
  eventFlowOption,
  heartbeatGaugeOption,
  hotspotOption,
  httpTrafficOption,
  messagesOption,
  queueBacklogOption,
  researchOutputOption,
  userGrowthOption,
  wordcloudOption,
} from "./charts/options";
import {
  loadInsights,
  loadResearchStats,
  loadTimeseries,
} from "./features/dashboard/api";
import { loadQueueHealth } from "./features/queues/api";
import styles from "./ui/admin.module.css";

/** 研究周期固定序（shared/src/market.ts RESEARCH_HORIZONS 的镜像，热力图 x 轴用） */
const HORIZONS = ["10m", "30m", "1h", "1d", "1w"];

interface OverviewResponse {
  dbAvailable: boolean;
  workerHeartbeat: { at: number; ageMs: number | null; stale: boolean };
}

function loadOverview(): Promise<OverviewResponse> {
  return api<OverviewResponse>("/admin/observability/overview");
}

interface KnowledgeDocsResponse {
  documents: { status: string }[];
}

function loadKnowledgeDocs(): Promise<KnowledgeDocsResponse> {
  return api<KnowledgeDocsResponse>("/admin/knowledge/documents");
}

function ChartBlock({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ minWidth: 0, padding: "0 4px" }}>
      <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 4 }}>
        {title}
      </Typography.Title>
      {children}
    </div>
  );
}

export default function AdminDashboardPage(): JSX.Element {
  const text = useAdminText();
  const insights = useResource(loadInsights, 300_000);
  const timeseries = useResource(loadTimeseries, 300_000);
  const researchStats = useResource(loadResearchStats, 300_000);
  const queues = useResource(loadQueueHealth, 30_000);
  const overview = useResource(loadOverview, 30_000);
  const knowledge = useResource(loadKnowledgeDocs, 300_000);

  const ins = insights.data;
  const ts = timeseries.data;
  const stats = researchStats.data;
  const queueRows = queues.data?.queues ?? [];
  const hb = overview.data?.workerHeartbeat;

  const kpis = useMemo(() => {
    const todayIndex = (days: { day: string }[]) => days.length - 1;
    return [
      {
        key: "kpiTotalUsers",
        value: ins ? ins.users.total : null,
      },
      {
        key: "kpiDauToday",
        value: ins && ins.activity.days.length > 0 ? ins.activity.days[todayIndex(ins.activity.days)].dau : null,
      },
      {
        key: "kpiMessagesToday",
        value: ins && ins.messages.days.length > 0
          ? (() => {
              const d = ins.messages.days[todayIndex(ins.messages.days)];
              return d.ai + d.research;
            })()
          : null,
      },
      {
        key: "kpiRunsToday",
        value: stats && stats.days.length > 0 ? stats.days[todayIndex(stats.days)].total : null,
      },
      {
        key: "kpiRequests24h",
        value: ts ? ts.http.buckets.reduce((a, b) => a + b.total, 0) : null,
      },
      {
        key: "kpiBacklog",
        value: queueRows.length > 0 ? queueRows.reduce((a, b) => a + b.created, 0) : null,
      },
    ];
  }, [ins, ts, stats, queueRows]);

  const userChart = useMemo(
    () => (ins ? userGrowthOption(ins.users.days, ins.activity.days, {
      newUsers: text("legendNewUsers"),
      cumulative: text("legendCumulative"),
      dau: text("legendDau"),
    }) : null),
    [ins, text],
  );
  const messageChart = useMemo(
    () => (ins ? messagesOption(ins.messages.days, {
      ai: text("legendAiMessages"),
      research: text("legendResearchMessages"),
    }) : null),
    [ins, text],
  );
  const hotspotChart = useMemo(
    () => (ins && ins.hotspots.cells.length > 0 ? hotspotOption(ins.hotspots.cells, HORIZONS) : null),
    [ins],
  );
  const wordChart = useMemo(
    () => (ins && ins.wordcloud.words.length > 0 ? wordcloudOption(ins.wordcloud.words) : null),
    [ins],
  );
  const httpChart = useMemo(
    () => (ts && ts.dbAvailable ? httpTrafficOption(ts.http.buckets, {
      requests: text("legendRequests"),
      p95: text("legendP95"),
    }) : null),
    [ts, text],
  );
  const eventChart = useMemo(
    () => (ts && ts.dbAvailable && ts.events.buckets.some((b) => b.count > 0) ? eventFlowOption(ts.events.buckets) : null),
    [ts],
  );
  const queueChart = useMemo(
    () => (queueRows.length > 0 ? queueBacklogOption(queueRows, {
      created: text("colCreated"),
      active: text("colActive"),
      retry: text("colRetry"),
    }) : null),
    [queueRows, text],
  );
  const researchChart = useMemo(
    () => (stats && stats.days.some((d) => d.total > 0) ? researchOutputOption(stats.days, {
      total: text("legendRunsTotal"),
      failed: text("legendFailed"),
      failRate: text("legendFailRate"),
    }) : null),
    [stats, text],
  );
  const heartbeatChart = useMemo(
    () => (hb ? heartbeatGaugeOption(hb.ageMs, hb.stale) : null),
    [hb],
  );
  const docChart = useMemo(() => {
    const docs = knowledge.data?.documents ?? [];
    if (docs.length === 0) return null;
    const counts = new Map<string, number>();
    for (const d of docs) counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
    const order = ["published", "indexed", "chunked", "parsed", "parsing", "uploaded", "failed"];
    const statusCounts = [...counts.entries()]
      .sort((a, b) => {
        const ia = order.indexOf(a[0]);
        const ib = order.indexOf(b[0]);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })
      .map(([status, count]) => ({ status, count }));
    return docStatusOption(statusCounts, {
      status: {
        published: text("doc_published"),
        indexed: text("doc_indexed"),
        chunked: text("doc_chunked"),
        parsed: text("doc_parsed"),
        parsing: text("doc_parsing"),
        uploaded: text("doc_uploaded"),
        failed: text("doc_failed"),
      },
    });
  }, [knowledge.data, text]);

  return (
    <div className={styles.stack}>
      <Row gutter={[12, 12]}>
        {kpis.map((kpi) => (
          <Col key={kpi.key} xs={12} md={8} lg={4}>
            <Card size="small">
              <Statistic
                title={text(kpi.key)}
                value={kpi.value ?? 0}
                loading={kpi.value === null}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Card size="small" title={text("sectionBusiness")}>
        <Row gutter={[8, 16]}>
          <Col xs={24} xl={12}>
            <ChartBlock title={text("chartUserGrowth")}>
              <EChart option={userChart} height={280} />
            </ChartBlock>
          </Col>
          <Col xs={24} xl={12}>
            <ChartBlock title={text("chartMessages")}>
              <EChart option={messageChart} height={280} />
            </ChartBlock>
          </Col>
          <Col xs={24} xl={12}>
            <ChartBlock title={text("chartHotspots")}>
              <EChart option={hotspotChart} height={300} emptyDescription={text("noHotspots")} />
            </ChartBlock>
          </Col>
          <Col xs={24} xl={12}>
            <ChartBlock title={text("chartWordcloud")}>
              <EChart option={wordChart} height={300} emptyDescription={text("wordcloudEmpty")} />
            </ChartBlock>
          </Col>
        </Row>
      </Card>

      <Card size="small" title={text("sectionSystem")}>
        <Row gutter={[8, 16]}>
          <Col xs={24} xl={12}>
            <ChartBlock title={text("chartHttpTraffic")}>
              <EChart option={httpChart} height={280} emptyDescription={text("noTimeseries")} />
            </ChartBlock>
          </Col>
          <Col xs={24} xl={12}>
            <ChartBlock title={text("chartQueueStates")}>
              <EChart option={queueChart} height={280} />
            </ChartBlock>
          </Col>
          <Col xs={24} xl={12}>
            <ChartBlock title={text("chartResearchOutput")}>
              <EChart option={researchChart} height={280} emptyDescription={text("noRuns")} />
            </ChartBlock>
          </Col>
          <Col xs={24} xl={12}>
            <ChartBlock title={text("chartEventFlow")}>
              <EChart option={eventChart} height={280} emptyDescription={text("noTimeseries")} />
            </ChartBlock>
          </Col>
          <Col xs={24} xl={12}>
            <ChartBlock title={text("chartDocStatus")}>
              <EChart option={docChart} height={280} emptyDescription={text("noDocs")} />
            </ChartBlock>
          </Col>
          <Col xs={24} xl={12}>
            <ChartBlock title={text("chartHeartbeat")}>
              <EChart option={heartbeatChart} height={280} />
            </ChartBlock>
          </Col>
        </Row>
      </Card>
    </div>
  );
}
