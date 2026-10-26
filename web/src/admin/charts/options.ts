/**
 * 大盘/各 tab 顶部图表的 option 工厂（纯函数，无 i18n 依赖——
 * 文案由调用方翻译后经 labels 传入；色板/轴样式走 echarts.ts 主题单点）。
 * 图型对照官方实践：面积堆叠折线（Area/Stacked Line）、横向堆叠条形
 * （Bar Y-Category）、热力图（Heatmap+visualMap）、词云（echarts-wordcloud）、
 * 仪表盘（Gauge）、环形饼（Doughnut）、柱线混合（Bar+Line mix）。
 */
import { axisStyle, type ChartOption } from "./echarts";

/** tokens.css 变量镜像（模块随页面 lazy 加载，CSS 已就绪；canvas 不认 CSS var 故取实体值） */
const cv = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const COLORS = {
  cyan: cv("--cyan"),
  up: cv("--up"),
  down: cv("--down"),
  amber: cv("--amber"),
  purple: cv("--purple"),
  blue: cv("--blue"),
  text: cv("--text"),
  text2: cv("--text-2"),
  text3: cv("--text-3"),
  onAccent: cv("--on-accent"),
};
const WORD_PALETTE = [COLORS.cyan, COLORS.up, COLORS.amber, COLORS.purple, COLORS.blue, COLORS.text2];

const axis = axisStyle();
const GRID = { left: 48, right: 24, top: 40, bottom: 28, containLabel: true };
const TOOLTIP_STYLE = { confine: true } as const;

function dayLabel(day: string): string {
  return day.slice(5); // YYYY-MM-DD → MM-DD
}

function hourLabel(hour: string): string {
  // 2026-10-26T10:00:00+08:00 → 10-26 10时
  return `${hour.slice(5, 10)} ${hour.slice(11, 13)}时`;
}

// ---- 业务洞察 ----

export function userGrowthOption(
  users: { day: string; newUsers: number; cumulative: number }[],
  dau: { day: string; dau: number }[],
  labels: { newUsers: string; cumulative: string; dau: string },
): ChartOption {
  return {
    tooltip: { trigger: "axis", ...TOOLTIP_STYLE },
    legend: { top: 0 },
    grid: GRID,
    xAxis: { type: "category", data: users.map((d) => dayLabel(d.day)), ...axis },
    yAxis: [
      { type: "value", minInterval: 1, ...axis },
      { type: "value", minInterval: 1, ...axis, splitLine: { show: false } },
    ],
    series: [
      {
        name: labels.newUsers,
        type: "bar",
        data: users.map((d) => d.newUsers),
        barMaxWidth: 14,
      },
      {
        name: labels.dau,
        type: "line",
        data: dau.map((d) => d.dau),
        smooth: true,
        symbolSize: 4,
      },
      {
        name: labels.cumulative,
        type: "line",
        yAxisIndex: 1,
        data: users.map((d) => d.cumulative),
        smooth: true,
        symbol: "none",
        lineStyle: { type: "dashed" },
      },
    ],
  };
}

export function messagesOption(
  days: { day: string; ai: number; research: number }[],
  labels: { ai: string; research: string },
): ChartOption {
  return {
    tooltip: { trigger: "axis", ...TOOLTIP_STYLE },
    legend: { top: 0 },
    grid: GRID,
    xAxis: { type: "category", data: days.map((d) => dayLabel(d.day)), ...axis },
    yAxis: { type: "value", minInterval: 1, ...axis },
    series: [
      { name: labels.ai, type: "bar", stack: "msg", data: days.map((d) => d.ai), barMaxWidth: 16 },
      { name: labels.research, type: "bar", stack: "msg", data: days.map((d) => d.research), barMaxWidth: 16 },
    ],
  };
}

/** 热力图：x=研究周期（固定序），y=标的（按热度 Top8）；visualMap 连续色阶 */
export function hotspotOption(
  cells: { symbol: string; horizon: string; count: number }[],
  horizons: string[],
): ChartOption {
  const totals = new Map<string, number>();
  for (const c of cells) totals.set(c.symbol, (totals.get(c.symbol) ?? 0) + c.count);
  const symbols = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([s]) => s);
  const data: [number, number, number][] = cells
    .filter((c) => symbols.includes(c.symbol))
    .map((c) => [horizons.indexOf(c.horizon), symbols.indexOf(c.symbol), c.count] as [number, number, number])
    .filter(([x, y]) => x >= 0 && y >= 0);
  const max = Math.max(1, ...data.map((d) => d[2]));
  return {
    tooltip: {
      ...TOOLTIP_STYLE,
      formatter: (p: unknown) => {
        const d = (p as { data: [number, number, number] }).data;
        return `${symbols[d[1]]} × ${horizons[d[0]]}：${d[2]}`;
      },
    },
    grid: { left: 8, right: 16, top: 8, bottom: 56, containLabel: true },
    xAxis: { type: "category", data: horizons, ...axis, splitArea: { show: true } },
    yAxis: { type: "category", data: symbols, ...axis, splitArea: { show: true } },
    visualMap: {
      min: 0,
      max,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      dimension: 2,
    },
    series: [
      {
        type: "heatmap",
        data,
        label: { show: true, color: COLORS.onAccent },
        emphasis: { itemStyle: { shadowBlur: 6, shadowColor: "rgba(0,0,0,0.4)" } },
      },
    ],
  };
}

export function wordcloudOption(words: { name: string; value: number }[]): ChartOption {
  return {
    series: [
      {
        type: "wordCloud",
        shape: "circle",
        sizeRange: [14, 58],
        rotationRange: [-45, 0, 45],
        rotationStep: 45,
        gridSize: 4,
        drawOutOfBound: false,
        layoutAnimation: true,
        textStyle: {
          color: (params: { dataIndex?: number }) => WORD_PALETTE[(params.dataIndex ?? 0) % WORD_PALETTE.length],
        },
        emphasis: { focus: "self" },
        data: words,
      },
    ],
  };
}

// ---- 系统健康 ----

/** HTTP 流量（2xx/4xx/5xx 堆叠面积）+ p95 延迟（右轴） */
export function httpTrafficOption(
  buckets: { hour: string; byClass: { c2xx: number; c4xx: number; c5xx: number }; p95Ms: number | null }[],
  labels: { requests: string; p95: string },
): ChartOption {
  const hours = buckets.map((b) => hourLabel(b.hour));
  return {
    tooltip: { trigger: "axis", ...TOOLTIP_STYLE },
    legend: { top: 0 },
    grid: GRID,
    xAxis: { type: "category", data: hours, ...axis, boundaryGap: false },
    yAxis: [
      { type: "value", minInterval: 1, ...axis },
      { type: "value", ...axis, splitLine: { show: false }, name: "ms", nameTextStyle: axis.nameTextStyle },
    ],
    series: [
      { name: "2xx", type: "line", stack: "req", areaStyle: { opacity: 0.28 }, symbol: "none", data: buckets.map((b) => b.byClass.c2xx) },
      { name: "4xx", type: "line", stack: "req", areaStyle: { opacity: 0.28 }, symbol: "none", data: buckets.map((b) => b.byClass.c4xx) },
      { name: "5xx", type: "line", stack: "req", areaStyle: { opacity: 0.28 }, symbol: "none", data: buckets.map((b) => b.byClass.c5xx) },
      {
        name: labels.p95,
        type: "line",
        yAxisIndex: 1,
        smooth: true,
        symbol: "none",
        connectNulls: false,
        lineStyle: { type: "dashed" },
        data: buckets.map((b) => b.p95Ms),
      },
    ],
  };
}

/** 队列积压横向堆叠条形（y 类目=队列名；series=created/active/retry） */
export function queueBacklogOption(
  queues: { name: string; created: number; active: number; retry: number }[],
  labels: { created: string; active: string; retry: string },
): ChartOption {
  const rows = [...queues].sort((a, b) => b.created - a.created).reverse();
  return {
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, ...TOOLTIP_STYLE },
    legend: { top: 0 },
    grid: { left: 8, right: 24, top: 36, bottom: 8, containLabel: true },
    xAxis: { type: "value", ...axis },
    yAxis: { type: "category", data: rows.map((q) => q.name), ...axis },
    series: [
      { name: labels.created, type: "bar", stack: "q", data: rows.map((q) => q.created), barMaxWidth: 14 },
      { name: labels.active, type: "bar", stack: "q", data: rows.map((q) => q.active), barMaxWidth: 14 },
      { name: labels.retry, type: "bar", stack: "q", data: rows.map((q) => q.retry), barMaxWidth: 14 },
    ],
  };
}

/** 研究产出：总量 Bar + 失败 Bar + 失败率 Line（右轴 %） */
export function researchOutputOption(
  days: { day: string; total: number; failed: number }[],
  labels: { total: string; failed: string; failRate: string },
): ChartOption {
  return {
    tooltip: { trigger: "axis", ...TOOLTIP_STYLE },
    legend: { top: 0 },
    grid: GRID,
    xAxis: { type: "category", data: days.map((d) => dayLabel(d.day)), ...axis },
    yAxis: [
      { type: "value", minInterval: 1, ...axis },
      { ...axis, type: "value", max: 100, axisLabel: { ...axis.axisLabel, formatter: "{value}%" }, splitLine: { show: false } },
    ],
    series: [
      { name: labels.total, type: "bar", data: days.map((d) => d.total), barMaxWidth: 14 },
      { name: labels.failed, type: "bar", data: days.map((d) => d.failed), barMaxWidth: 14 },
      {
        name: labels.failRate,
        type: "line",
        yAxisIndex: 1,
        smooth: true,
        symbol: "none",
        data: days.map((d) => (d.total === 0 ? null : Math.round((d.failed / d.total) * 1000) / 10)),
        connectNulls: false,
      },
    ],
  };
}

export function eventFlowOption(buckets: { hour: string; count: number }[]): ChartOption {
  return {
    tooltip: { trigger: "axis", ...TOOLTIP_STYLE },
    grid: GRID,
    xAxis: { type: "category", data: buckets.map((b) => hourLabel(b.hour)), ...axis, boundaryGap: false },
    yAxis: { type: "value", minInterval: 1, ...axis },
    series: [
      {
        type: "line",
        smooth: true,
        symbol: "none",
        areaStyle: { opacity: 0.22 },
        data: buckets.map((b) => b.count),
      },
    ],
  };
}

export const DOC_STATUS_COLORS: Record<string, string> = {
  published: COLORS.up,
  indexed: COLORS.blue,
  chunked: COLORS.purple,
  parsed: COLORS.cyan,
  parsing: COLORS.amber,
  uploaded: COLORS.text2,
  failed: COLORS.down,
};

/** 知识库文档状态环形饼（中心总数 graphic） */
export function docStatusOption(
  statusCounts: { status: string; count: number }[],
  labels: { status: Record<string, string> },
): ChartOption {
  const data = statusCounts.map((s) => ({
    name: labels.status[s.status] ?? s.status,
    value: s.count,
    itemStyle: { color: DOC_STATUS_COLORS[s.status] ?? "#5a6b8c" },
  }));
  const total = statusCounts.reduce((a, b) => a + b.count, 0);
  return {
    tooltip: { ...TOOLTIP_STYLE },
    legend: { bottom: 0, type: "scroll" },
    title: {
      text: String(total),
      left: "center",
      top: "38%",
      textStyle: { color: COLORS.text, fontSize: 26, fontWeight: 600 },
    },
    series: [
      {
        type: "pie",
        radius: ["48%", "68%"],
        center: ["50%", "45%"],
        data,
        label: { show: false },
        emphasis: { scaleSize: 4 },
      },
    ],
  };
}

/** worker 心跳仪表盘：0-180s，90s 健康线（绿区/红区），当前年龄指针 */
export function heartbeatGaugeOption(ageMs: number | null, stale: boolean): ChartOption {
  const seconds = ageMs === null ? 0 : Math.round(ageMs / 1000);
  return {
    series: [
      {
        type: "gauge",
        min: 0,
        max: 180,
        splitNumber: 6,
        startAngle: 200,
        endAngle: -20,
        axisLine: { lineStyle: { width: 10, color: [[90 / 180, COLORS.up], [1, COLORS.down]] } },
        pointer: { itemStyle: { color: "auto" }, width: 3 },
        axisTick: { distance: -14, length: 4, lineStyle: { color: COLORS.text2 } },
        splitLine: { distance: -16, length: 8, lineStyle: { color: COLORS.text2 } },
        axisLabel: { distance: -34, color: COLORS.text2, fontSize: 10, formatter: "{value}s" },
        detail: {
          valueAnimation: false,
          offsetCenter: [0, "62%"],
          color: stale ? COLORS.down : COLORS.text,
          fontSize: 20,
          formatter: (v: number) => `${Math.round(v)}s`,
        },
        data: [{ value: Math.min(seconds, 180) }],
      },
    ],
  };
}

// ---- 各 tab 顶部 ----

/** 评测：近 N runs 按天 运行数 Bar + 成功率 Line（右轴 %） */
export function evalSuccessOption(
  days: { day: string; runs: number; passed: number }[],
  labels: { runs: string; successRate: string },
): ChartOption {
  return {
    tooltip: { trigger: "axis", ...TOOLTIP_STYLE },
    legend: { top: 0 },
    grid: GRID,
    xAxis: { type: "category", data: days.map((d) => dayLabel(d.day)), ...axis },
    yAxis: [
      { type: "value", minInterval: 1, ...axis },
      { ...axis, type: "value", max: 100, axisLabel: { ...axis.axisLabel, formatter: "{value}%" }, splitLine: { show: false } },
    ],
    series: [
      { name: labels.runs, type: "bar", data: days.map((d) => d.runs), barMaxWidth: 14 },
      {
        name: labels.successRate,
        type: "line",
        yAxisIndex: 1,
        smooth: true,
        symbol: "none",
        data: days.map((d) => (d.runs === 0 ? null : Math.round((d.passed / d.runs) * 1000) / 10)),
        connectNulls: false,
      },
    ],
  };
}

/** AI 活跃：每用户消息量 Top10 横向条形 */
export function aiActivityOption(stats: { username: string; messages: number }[]): ChartOption {
  const rows = [...stats].sort((a, b) => b.messages - a.messages).slice(0, 10).reverse();
  return {
    tooltip: { ...TOOLTIP_STYLE },
    grid: { left: 8, right: 32, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: "value", minInterval: 1, ...axis },
    yAxis: { type: "category", data: rows.map((r) => r.username), ...axis },
    series: [{ type: "bar", data: rows.map((r) => r.messages), barMaxWidth: 14 }],
  };
}
