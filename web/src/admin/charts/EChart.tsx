/**
 * EChart：admin 图表统一 React 封装（自写，不引第三方 wrapper）。
 * - 主题 'bv-admin'（charts/echarts.ts 注册，色值同源 tokens.css）
 * - ResizeObserver 自适应容器宽度；卸载 dispose
 * - option 为 null 时渲染空态（数据未就绪/空数据不装 0，与观测页纪律一致）
 * - setOption(notMerge=true)：option 由 useMemo 生成，切换数据整体替换
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Empty } from "antd";
import { ensureBvAdminTheme, init, type ChartOption, type EChartsType } from "./echarts";

export function EChart({
  option,
  height = 260,
  emptyDescription,
}: {
  option: ChartOption | null;
  height?: number;
  emptyDescription?: ReactNode;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    ensureBvAdminTheme();
    const chart = init(el, "bv-admin");
    chartRef.current = chart;
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart && option) chart.setOption(option, true);
  }, [option]);

  return (
    <div style={{ position: "relative", height }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {option ? null : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={emptyDescription} />
        </div>
      )}
    </div>
  );
}
