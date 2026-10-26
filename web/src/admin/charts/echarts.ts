/**
 * ECharts 按需注册单点（官方 tree-shaking 实践）+ admin 深色主题。
 * 页面一律从本文件 / EChart.tsx 使用图表，禁止直接 import echarts ——
 * build-isolation 已把 echarts/zrender/wordcloud 列为 admin-only，
 * 用户端产物零污染由双构建 module-graph 断言钉死。
 * 主题色运行时读 tokens.css 变量，与 app/Theme.tsx 的 antd token 同源。
 */
import { init, use, registerTheme } from "echarts/core";
import type { EChartsCoreOption, EChartsType } from "echarts/core";
import {
  LineChart,
  BarChart,
  PieChart,
  GaugeChart,
  HeatmapChart,
} from "echarts/charts";
import {
  TooltipComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  VisualMapComponent,
  DataZoomComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
// wordcloud 官方扩展（echarts-wordcloud）：副作用注册 series.wordCloud，
// 内部引 echarts 核心模块与 echarts/core 共享同一单例，不破坏按需引入。
import "echarts-wordcloud";

use([
  LineChart,
  BarChart,
  PieChart,
  GaugeChart,
  HeatmapChart,
  TooltipComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  VisualMapComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

/**
 * 统一 option 类型：EChartsCoreOption（echarts/core 宽松容器）。
 * 不用 ComposeOption 精确组合——wordCloud 扩展系列的索引签名会让联合推导
 * 崩成 never；语义正确性由 options.ts 工厂 + 人工截图核验兜底。
 */
export type ChartOption = EChartsCoreOption;

/** echarts-wordcloud 系列的关键字段（文档型声明，wordCloud option 构造参考） */
export interface WordCloudSeriesOption {
  type: "wordCloud";
  shape?: string;
  sizeRange?: [number, number];
  rotationRange?: [number, number];
  rotationStep?: number;
  gridSize?: number;
  drawOutOfBound?: boolean;
  layoutAnimation?: boolean;
  width?: number | string;
  height?: number | string;
  left?: number | string;
  top?: number | string;
  right?: number | string;
  bottom?: number | string;
  textStyle?: {
    color?: string | ((params: { dataIndex?: number }) => string);
    fontFamily?: string;
    fontWeight?: string | number;
  };
  emphasis?: { focus?: "self" | "series" | "none" };
  data?: { name: string; value: number }[];
  [key: string]: unknown;
}

let themeRegistered = false;

/** 注册 admin 深色主题（幂等）；必须在首个图表 init 之前调用 */
export function ensureBvAdminTheme(): void {
  if (themeRegistered) return;
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  registerTheme("bv-admin", {
    color: [
      v("--cyan"),
      v("--up"),
      v("--amber"),
      v("--purple"),
      v("--blue"),
      v("--down"),
      v("--text-1"),
    ],
    backgroundColor: "transparent",
    textStyle: { color: v("--text-1"), fontFamily: v("--sans") },
    legend: { textStyle: { color: v("--text-2") } },
    tooltip: {
      backgroundColor: v("--bg-2"),
      borderColor: v("--line-2"),
      textStyle: { color: v("--text") },
    },
  });
  themeRegistered = true;
}

export { init };
export type { EChartsType };

/** 深色轴系默认值：各图 option 展开 merge（主题对 axis 样式覆盖有限） */
export function axisStyle() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    axisLine: { lineStyle: { color: v("--line-2") } },
    axisTick: { lineStyle: { color: v("--line-2") } },
    axisLabel: { color: v("--text-2") },
    splitLine: { lineStyle: { color: v("--line") } },
    nameTextStyle: { color: v("--text-3") },
  };
}
