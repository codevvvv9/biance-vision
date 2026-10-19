import { useMemo } from 'react'
import { analyzeBrooks } from 'biance-vision-brooks'
import type { BrooksDisplay, ResearchResult, ResearchRun } from 'biance-vision-brooks'
import BrooksChart from '../brooks/BrooksChart'
import type { BrooksChartLevel } from '../brooks/BrooksChart'
import { useMarket } from '../market/MarketContext'
import { useResearchCandles } from './useResearchCandles'

const TF = { '10m': '1m', '30m': '5m', '1h': '15m', '1d': '1h', '1w': '4h' }
const DISPLAY: BrooksDisplay = { swings: true, legs: true, io: true, signals: true, ema: true, regime: true }

/** Only mounted for an authenticated, selected run. Composer settings cannot alter this chart. */
export default function WorkbenchChart({ run, result, highlightTime }: { run: ResearchRun; result: ResearchResult | null; highlightTime: number | null }): JSX.Element {
  const { upColor } = useMarket()
  const interval = TF[run.horizon]
  const { bars, loading, error, source, fallbackReason } = useResearchCandles(run.symbol, run.marketType, interval, run.asOf, run.id)
  const analysis = useMemo(() => analyzeBrooks(bars), [bars])
  const levels = useMemo<BrooksChartLevel[]>(() => {
    const p = (result as unknown as { payload?: { kind?: string; position?: { stopPrice?: string }; liquidation?: { price?: number }; quote?: { strikePrice?: string } } } | null)?.payload
    const values = p?.kind === 'perp' ? [{ price: Number(p.position?.stopPrice ?? NaN), label: '止损' }, { price: Number(p.liquidation?.price ?? NaN), label: '强平' }]
      : p?.kind === 'event' ? [{ price: Number(p.quote?.strikePrice ?? NaN), label: '执行价' }] : []
    return values.filter(v => Number.isFinite(v.price))
  }, [result])
  return <div className="wb-chart">
    <div className="wb-chart-meta"><strong>{run.symbol}</strong><span>{interval} · {run.marketType === 'spot' ? '现货' : '永续'} · 已收盘</span></div>
    <p className="wb-caption">冻结于 {new Date(run.asOf).toLocaleString()} · {bars.length} 根</p>
    <div className="wb-chart-canvas">
      {!loading && !error && bars.length > 0 && <BrooksChart bars={bars} analysis={analysis} display={DISPLAY} upColor={upColor} highlightTime={highlightTime} levels={levels} />}
      {loading && <p className="wb-chart-state" role="status">正在读取研究快照…</p>}
      {error && <p className="wb-chart-state err-text" role="alert">{error}</p>}
      {!loading && !error && bars.length === 0 && <p className="wb-chart-state">该时点暂无可展示的 K 线。</p>}
    </div>
    {fallbackReason && <p className="warn-line" role="alert">快照不可复现：{fallbackReason}。此图仅作参考，原研究结论保持冻结。</p>}
    <p className="wb-caption">{source === 'snapshot' ? '原始冻结输入包' : '历史库数据'} · 快照 {run.snapshotId ?? '暂无'}<br />规则 {run.ruleVersion ?? '未知'} · 配置 {run.configVersion ?? '未知'}<br />知识 {run.knowledgeVersion ?? '无发布版本'}</p>
    {highlightTime !== null && <p className="wb-caption">结构发生：{new Date(highlightTime).toLocaleString()}；确认时间见证据条目。待确认结构以虚线区分。</p>}
  </div>
}
