/**
 * 大盘（v0.18.4）取数：业务洞察 / HTTP 时序 / 研究产出三端点。
 * 快照类（queue-health）复用 features/queues；页面组装见 AdminDashboardPage。
 */
import { api } from "../../../api";

export interface InsightsUsersDay {
  day: string;
  newUsers: number;
  cumulative: number;
}
export interface InsightsResponse {
  days: number;
  users: { total: number; days: InsightsUsersDay[] };
  activity: { days: { day: string; dau: number }[] };
  messages: { days: { day: string; ai: number; research: number }[] };
  hotspots: {
    cells: { symbol: string; horizon: string; count: number }[];
    products: { product: string; count: number }[];
  };
  wordcloud: { words: { name: string; value: number }[] };
  observedAt: string;
}

export interface TimeseriesResponse {
  dbAvailable: boolean;
  http: {
    buckets: {
      hour: string;
      total: number;
      byClass: { c2xx: number; c4xx: number; c5xx: number };
      p95Ms: number | null;
    }[];
  };
  events: { buckets: { hour: string; count: number }[] };
  observedAt: string;
}

export interface ResearchStatsResponse {
  days: { day: string; total: number; completed: number; failed: number }[];
  observedAt: string;
}

export function loadInsights(days = 30): Promise<InsightsResponse> {
  return api<InsightsResponse>(`/admin/insights?days=${days}`);
}

export function loadTimeseries(hours = 24): Promise<TimeseriesResponse> {
  return api<TimeseriesResponse>(`/admin/observability/timeseries?hours=${hours}`);
}

export function loadResearchStats(days = 14): Promise<ResearchStatsResponse> {
  return api<ResearchStatsResponse>(`/admin/research/stats?days=${days}`);
}
