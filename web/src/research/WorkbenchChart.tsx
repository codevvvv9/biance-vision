import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { analyzeBrooks } from 'biance-vision-brooks'
import type { BrooksDisplay, ResearchResult, ResearchRun, SharedLocale } from 'biance-vision-brooks'
import BrooksChart from '../brooks/BrooksChart'
import type { BrooksChartLevel } from '../brooks/BrooksChart'
import { useMarket } from '../market/MarketContext'
import { contentLocale } from '../i18n'
import { useResearchCandles } from './useResearchCandles'

const TF = { '10m': '1m', '30m': '5m', '1h': '15m', '1d': '1h', '1w': '4h' }
const DISPLAY: BrooksDisplay = { swings: true, legs: true, io: true, signals: true, ema: true, regime: true }

/** Only mounted for an authenticated, selected run. Composer settings cannot alter this chart. */
export default function WorkbenchChart({ run, result, highlightTime }: { run: ResearchRun; result: ResearchResult | null; highlightTime: number | null }): JSX.Element {
  const { t } = useTranslation()
  const locale: SharedLocale = contentLocale()
  const { upColor } = useMarket()
  const interval = TF[run.horizon]
  const { bars, loading, error, source, fallbackReason } = useResearchCandles(run.symbol, run.marketType, interval, run.asOf, run.id)
  const analysis = useMemo(() => analyzeBrooks(bars, { swingK: 3, locale }), [bars, locale])
  const levels = useMemo<BrooksChartLevel[]>(() => {
    const p = (result as unknown as { payload?: { kind?: string; position?: { stopPrice?: string }; liquidation?: { price?: number }; quote?: { strikePrice?: string } } } | null)?.payload
    const values = p?.kind === 'perp' ? [{ price: Number(p.position?.stopPrice ?? NaN), label: t('research:chart.stop') }, { price: Number(p.liquidation?.price ?? NaN), label: t('research:chart.liq') }]
      : p?.kind === 'event' ? [{ price: Number(p.quote?.strikePrice ?? NaN), label: t('research:chart.strike') }] : []
    return values.filter(v => Number.isFinite(v.price))
  }, [result, t])
  return <div className="wb-chart">
    <div className="wb-chart-meta"><strong>{run.symbol}</strong><span>{interval} · {run.marketType === 'spot' ? t('research:chart.spot') : t('research:chart.perp')} · {t('research:chart.closed')}</span></div>
    <p className="wb-caption">{t('research:chart.frozenAt', { time: new Date(run.asOf).toLocaleString(), count: bars.length })}</p>
    <div className="wb-chart-canvas">
      {!loading && !error && bars.length > 0 && <BrooksChart bars={bars} analysis={analysis} display={DISPLAY} upColor={upColor} highlightTime={highlightTime} levels={levels} />}
      {loading && <p className="wb-chart-state" role="status">{t('research:chart.reading')}</p>}
      {error && <p className="wb-chart-state err-text" role="alert">{error}</p>}
      {!loading && !error && bars.length === 0 && <p className="wb-chart-state">{t('research:chart.noBars')}</p>}
    </div>
    {fallbackReason && <p className="warn-line" role="alert">{t('research:chart.fallbackNote', { reason: fallbackReason })}</p>}
    <p className="wb-caption">{source === 'snapshot' ? t('research:chart.sourceSnapshot') : t('research:chart.sourceHistory')} · {run.snapshotId != null ? t('research:chart.snapshot', { id: run.snapshotId }) : t('research:chart.snapshotNone')}<br />{t('research:chart.rules', { v: run.ruleVersion ?? t('research:chart.unknown') })} · {t('research:chart.config', { v: run.configVersion ?? t('research:chart.unknown') })}<br />{t('research:chart.knowledge', { v: run.knowledgeVersion ?? t('research:chart.noKnowledge') })}</p>
    {highlightTime !== null && <p className="wb-caption">{t('research:chart.structureEvent', { time: new Date(highlightTime).toLocaleString() })}</p>}
  </div>
}
