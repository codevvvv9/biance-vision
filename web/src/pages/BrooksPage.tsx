/**
 * 价格行为复盘页（/brooks）：Al Brooks 理论的结构识别学习工具。
 * K 线 + 结构标注（摆动点/腿/内外包/信号）+ 当前状态摘要 + 信号清单（带规则出处）。
 * 纯结构识别、只认收盘K线，不做任何行情预测。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import { useAi } from '../ai/AiContext'
import { useMarket } from '../market/MarketContext'
import { useFullscreen } from '../hooks/useFullscreen'
import FullscreenButton from '../components/FullscreenButton'
import { fmtDateTime, lsGet, lsSet } from '../utils'
import BrooksChart from '../brooks/BrooksChart'
import { BrooksTerm, termForSignalKind } from '../brooks/terms'
import { currentLocale } from '../i18n'
import type { SharedLocale } from 'biance-vision-brooks'
import type { BrooksChartHandle } from '../brooks/BrooksChart'
import { analyzeBrooks } from 'biance-vision-brooks'
import type { BrooksDisplay, BrooksSignal } from 'biance-vision-brooks'
import type { KlineBar } from '../types'

const INTERVALS: { v: string; t: string }[] = [
  { v: '1m', t: 'brooks:interval.1m' },
  { v: '5m', t: 'brooks:interval.5m' },
  { v: '15m', t: 'brooks:interval.15m' },
  { v: '1h', t: 'brooks:interval.1h' },
  { v: '4h', t: 'brooks:interval.4h' },
  { v: '1d', t: 'brooks:interval.1d' },
]

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
}

const SCALES: { v: number; t: string; hint: string }[] = [
  { v: 1, t: 'brooks:scales.1.t', hint: 'brooks:scales.1.hint' },
  { v: 2, t: 'brooks:scales.2.t', hint: 'brooks:scales.2.hint' },
  { v: 3, t: 'brooks:scales.3.t', hint: 'brooks:scales.3.hint' },
  { v: 5, t: 'brooks:scales.5.t', hint: 'brooks:scales.5.hint' },
]

const LIMITS = [300, 500, 1000]

const DEFAULT_DISPLAY: BrooksDisplay = {
  swings: true,
  legs: true,
  io: true,
  signals: true,
  ema: true,
  regime: true,
}

const TOGGLES: { key: keyof BrooksDisplay; labelKey: string }[] = [
  { key: 'regime', labelKey: 'brooks:toggles.regime' },
  { key: 'ema', labelKey: 'brooks:toggles.ema' },
  { key: 'legs', labelKey: 'brooks:toggles.legs' },
  { key: 'swings', labelKey: 'brooks:toggles.swings' },
  { key: 'io', labelKey: 'brooks:toggles.io' },
  { key: 'signals', labelKey: 'brooks:toggles.signals' },
]

type SignalFilter = 'all' | 'bull' | 'bear'

function sigDirClass(s: BrooksSignal): string {
  return s.direction === 'bull' ? 'bull' : s.direction === 'bear' ? 'bear' : 'neutral'
}

export default function BrooksPage(): JSX.Element {
  const { t, i18n } = useTranslation()
  const locale: SharedLocale = currentLocale()
  const [searchParams, setSearchParams] = useSearchParams()
  const { order, subscribeKline, upColor } = useMarket()
  const { status: aiStatus, askAi, showRobot } = useAi()
  const [symbol, setSymbol] = useState(() => (searchParams.get('symbol') || 'BTCUSDT').toUpperCase())
  const [symbolInput, setSymbolInput] = useState(symbol)
  const [interval, setIntervalValue] = useState(() => {
    const v = searchParams.get('interval')
    return v && INTERVAL_MS[v] ? v : '1h'
  })
  const [limit, setLimit] = useState(500)
  const [swingK, setSwingK] = useState(3)
  const [bars, setBars] = useState<KlineBar[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [filter, setFilter] = useState<SignalFilter>('all')
  const [showHelp, setShowHelp] = useState(false)
  const [display, setDisplay] = useState<BrooksDisplay>(() => lsGet('brooks.display', DEFAULT_DISPLAY))
  const chartRef = useRef<BrooksChartHandle | null>(null)
  const fs = useFullscreen<HTMLElement>()

  // 文案（label/reason/summary 等）由 shared 引擎按 locale 产出，语言切换时连同重算
  const analysis = useMemo(
    () => (bars.length > 0 ? analyzeBrooks(bars, { swingK, locale }) : null),
    [bars, swingK, locale],
  )

  const toggleDisplay = (key: keyof BrooksDisplay): void => {
    setDisplay((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      lsSet('brooks.display', next)
      return next
    })
  }

  // REST 拉取（丢掉未收盘的最后一根：分析只认收盘K线，WS 会实时补上）
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    api<{ klines: KlineBar[] }>(`/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`)
      .then((d) => {
        if (cancelled) return
        let list = d.klines
        const ms = INTERVAL_MS[interval] ?? 60_000
        if (list.length > 0 && Date.now() - list[list.length - 1].time < ms) {
          list = list.slice(0, -1)
        }
        setBars(list)
        setLoading(false)
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message || i18n.t('brooks:loadFailed'))
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [symbol, interval, limit, reload])

  // WS：tick 直接进图表；收盘后才并入分析数据触发重算
  useEffect(() => {
    const off = subscribeKline(symbol, interval, (k) => {
      chartRef.current?.updateBar(k)
      if (!k.closed) return
      setBars((prev) => {
        if (prev.length === 0) return prev
        const last = prev[prev.length - 1]
        if (k.time < last.time) return prev
        if (k.time === last.time) {
          const copy = prev.slice()
          copy[copy.length - 1] = k
          return copy
        }
        return [...prev.slice(-(limit - 1)), k]
      })
    })
    return off
  }, [symbol, interval, subscribeKline, limit])

  const applySymbol = (): void => {
    const s = symbolInput.trim().toUpperCase()
    if (!/^[A-Z0-9]{4,20}$/.test(s)) return
    setSymbol(s)
    setSearchParams({ symbol: s, interval })
  }

  const applyInterval = (v: string): void => {
    setIntervalValue(v)
    setSearchParams({ symbol, interval: v })
  }

  /** 把当前结构摘要打包发给 AI 助手，用 Brooks 框架解读（AI 需已配置）；提示词跟随 UI 语言 */
  const askAiAnalysis = (): void => {
    if (!analysis || !summary) return
    const dirText = (d: string): string => t(`brooks:aiPrompt.dir.${d === 'bull' ? 'bull' : d === 'bear' ? 'bear' : 'neutral'}`)
    const recent = analysis.signals
      .slice(-8)
      .reverse()
      .map((s, i) => `${i + 1}. [${s.label} · ${dirText(s.direction)}] ${s.reason}`)
      .join('\n')
    const lastLegText = summary.lastLeg
      ? t('brooks:aiPrompt.lastLegLine', {
          dir: t(`brooks:aiPrompt.legDir.${summary.lastLeg.direction === 'up' ? 'up' : 'down'}`),
          count: summary.lastLeg.barCount,
          trend: summary.lastLeg.trendBarCount,
          retracement: summary.lastLeg.retracementOfPrev !== undefined
            ? t('brooks:aiPrompt.retracement', { pct: (summary.lastLeg.retracementOfPrev * 100).toFixed(0) })
            : '',
        }) + '\n'
      : ''
    const prompt = [
      t('brooks:aiPrompt.header', { symbol, interval, barCount: summary.barCount, swingK: analysis.options.swingK }),
      `- ${t('brooks:aiPrompt.regime')}：${summary.regimeText}`,
      t('brooks:aiPrompt.alwaysInLine', { dir: dirText(summary.alwaysIn), reason: summary.alwaysInReason }),
      t('brooks:aiPrompt.structureLine', { verdict: summary.trendStructure, sequence: summary.swingSequence }),
      lastLegText + `- ${t('brooks:aiPrompt.recentSignals')}\n${recent || t('brooks:aiPrompt.none')}`,
      '',
      t('brooks:aiPrompt.requirements'),
    ].join('\n')
    showRobot()
    askAi(prompt)
  }

  const signals = analysis?.signals ?? []
  const visibleSignals = signals
    .filter((s) => (filter === 'all' ? true : s.direction === filter))
    .slice()
    .reverse()
  const bullCount = signals.filter((s) => s.direction === 'bull').length
  const bearCount = signals.filter((s) => s.direction === 'bear').length
  const summary = analysis?.summary
  const lastLeg = summary?.lastLeg

  return (
    <div className="page brooks-page">
      <section className="panel brooks-controls">
        <div className="brooks-controls-row">
          <form
            className="form-row brooks-symbol-form"
            onSubmit={(e) => {
              e.preventDefault()
              applySymbol()
            }}
          >
            <input
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
              placeholder={t('brooks:symbolPlaceholder')}
              list="brooks-symbol-list"
              spellCheck={false}
            />
            <datalist id="brooks-symbol-list">
              {order.slice(0, 60).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <button className="btn btn-primary btn-sm" type="submit">
              {t('brooks:analyze')}
            </button>
          </form>
          <div className="interval-group" role="tablist">
            {INTERVALS.map((iv) => (
              <button key={iv.v} className={iv.v === interval ? 'on' : ''} onClick={() => applyInterval(iv.v)}>
                {t(iv.t)}
              </button>
            ))}
          </div>
          <div className="interval-group" role="group" aria-label={t('brooks:swingScale')}>
            {SCALES.map((s) => (
              <button
                key={s.v}
                title={t(s.hint)}
                className={s.v === swingK ? 'on' : ''}
                onClick={() => setSwingK(s.v)}
              >
                {t(s.t)}·{s.v}
              </button>
            ))}
          </div>
          <div className="interval-group" role="group" aria-label={t('brooks:barCount')}>
            {LIMITS.map((n) => (
              <button key={n} className={n === limit ? 'on' : ''} onClick={() => setLimit(n)}>
                {t('brooks:barsUnit', { count: n })}
              </button>
            ))}
          </div>
          <div className="brooks-toggles">
            {TOGGLES.map((tg) => (
              <button
                key={tg.key}
                className={`brooks-toggle${display[tg.key] ? ' on' : ''}`}
                onClick={() => toggleDisplay(tg.key)}
              >
                {t(tg.labelKey)}
              </button>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowHelp(true)}>
            {t('brooks:helpButton')}
          </button>
        </div>
      </section>

      <div className="brooks-grid">
        <section className="panel chart-panel brooks-chart-panel" ref={fs.ref}>
          <div className="panel-head">
            <h2 className="panel-title">
              <span className="title-glyph teal">▮</span>
              {t('brooks:title', {
                base: symbol.replace('USDT', ''),
                interval: t(INTERVALS.find((i) => i.v === interval)?.t ?? 'brooks:interval.1h'),
              })}
              {analysis ? t('brooks:titleScale', { k: analysis.options.swingK }) : ''}
            </h2>
            <div className="panel-head-tools">
              <span className="brooks-note">{t('brooks:note')}</span>
              <button
                className="btn btn-primary btn-sm"
                onClick={askAiAnalysis}
                disabled={!aiStatus.configured || !analysis}
                title={aiStatus.configured ? t('brooks:ai.hintOk') : t('brooks:ai.hintNo')}
              >
                {t('brooks:ai.button')}
              </button>
              <FullscreenButton
                on={fs.isFullscreen}
                onClick={fs.toggle}
                label={t('brooks:fullscreen')}
              />
              <button className="btn btn-ghost btn-sm" onClick={() => setReload((n) => n + 1)}>
                {t('brooks:refresh')}
              </button>
            </div>
          </div>
          <div className="brooks-chart-hold">
            <BrooksChart ref={chartRef} bars={bars} analysis={analysis} display={display} upColor={upColor} />
            {loading && <div className="chart-mask">{t('brooks:loading', { symbol })}</div>}
            {error && (
              <div className="chart-mask error">
                <span>{error}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setReload((n) => n + 1)}>
                  {t('brooks:retry')}
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="brooks-side">
          <section className="panel brooks-summary-panel">
            <div className="panel-head">
              <h3 className="panel-title">
                <span className="title-glyph amber">◆</span>{t('brooks:summary.title')}
              </h3>
            </div>
            {summary ? (
              <div className="brooks-summary">
                <div className="brooks-kv">
                  <span className="k"><BrooksTerm term="市场状态">{t('brooks:summary.marketState')}</BrooksTerm></span>
                  <span className={`brooks-chip regime-${summary.regime}`}>{summary.regimeText}</span>
                </div>
                <div className="brooks-kv">
                  <span className="k"><BrooksTerm term="alwaysIn">Always In</BrooksTerm></span>
                  <span className={`brooks-chip dir-${summary.alwaysIn}`}>
                    {t(`brooks:summary.alwaysIn.${summary.alwaysIn === 'bull' ? 'bull' : summary.alwaysIn === 'bear' ? 'bear' : 'none'}`)}
                  </span>
                </div>
                <div className="brooks-sub">{summary.alwaysInReason}{t('brooks:summary.sinceBar', { n: summary.alwaysInSince + 1 })}</div>
                <div className="brooks-kv">
                  <span className="k"><BrooksTerm term="结构判定">{t('brooks:summary.structureVerdict')}</BrooksTerm></span>
                  <span className="v">{summary.trendStructure}</span>
                </div>
                <div className="brooks-kv">
                  <span className="k"><BrooksTerm term="摆动序列">{t('brooks:summary.swingSequence')}</BrooksTerm></span>
                  <span className="v mono">{summary.swingSequence}</span>
                </div>
                {lastLeg && (
                  <div className="brooks-kv">
                    <span className="k"><BrooksTerm term="最近一腿">{t('brooks:summary.lastLeg')}</BrooksTerm></span>
                    <span className="v">
                      {t('brooks:summary.lastLegLine', {
                        dir: lastLeg.direction === 'up' ? '↑' : '↓',
                        count: lastLeg.barCount,
                        trend: lastLeg.trendBarCount,
                      })}
                      {lastLeg.retracementOfPrev !== undefined
                        ? t('brooks:summary.lastLegRetrace', { pct: (lastLeg.retracementOfPrev * 100).toFixed(0) })
                        : ''}
                    </span>
                  </div>
                )}
                <div className="brooks-kv">
                  <span className="k">{t('brooks:summary.signalStat')}</span>
                  <span className="v">
                    {t('brooks:summary.signalCount', { total: signals.length, bull: bullCount, bear: bearCount })}
                  </span>
                </div>
              </div>
            ) : (
              <div className="brooks-sub">{t('brooks:summary.empty')}</div>
            )}
          </section>

          <section className="panel brooks-signals-panel">
            <div className="panel-head">
              <h3 className="panel-title">
                <span className="title-glyph amber">◆</span>{t('brooks:signals.title')}
              </h3>
              <div className="panel-head-tools brooks-filter">
                {(['all', 'bull', 'bear'] as SignalFilter[]).map((f) => (
                  <button key={f} className={f === filter ? 'on' : ''} onClick={() => setFilter(f)}>
                    {t(`brooks:signals.filter.${f}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="brooks-signal-list">
              {visibleSignals.length === 0 && <div className="brooks-sub">{t('brooks:signals.empty')}</div>}
              {visibleSignals.map((s, idx) => (
                <button
                  key={`${s.kind}-${s.index}-${idx}`}
                  className={`brooks-signal ${sigDirClass(s)}`}
                  onClick={() => chartRef.current?.scrollTo(s.index)}
                  title={t('brooks:signals.locate')}
                >
                  <div className="brooks-signal-head">
                    <span className={`brooks-sig-chip ${sigDirClass(s)} strength-${s.strength}`} title={termForSignalKind(s.label, s.kind)}>{s.label}</span>
                    <span className="brooks-signal-title">{s.title}</span>
                    <span className="brooks-signal-time">{fmtDateTime(s.time)}</span>
                  </div>
                  <div className="brooks-signal-reason">{s.reason}</div>
                  <div className="brooks-signal-concept">{s.concept}</div>
                  {s.empiricalNote && <div className="brooks-signal-prior" title={t('brooks:signals.empiricalTitle')}>{t('brooks:signals.empirical', { note: s.empiricalNote })}</div>}
                  {s.ref && (s.ref.entry !== undefined || s.ref.stop !== undefined || s.ref.target !== undefined) && (
                    <div className="brooks-signal-ref mono">
                      {s.ref.entry !== undefined && <span>{t('brooks:signals.ref.entry', { v: s.ref.entry.toPrecision(6) })}</span>}
                      {s.ref.stop !== undefined && <span>{t('brooks:signals.ref.stop', { v: s.ref.stop.toPrecision(6) })}</span>}
                      {s.ref.target !== undefined && <span>{t('brooks:signals.ref.target', { v: s.ref.target.toPrecision(6) })}</span>}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {showHelp && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowHelp(false)
          }}
        >
          <div className="modal brooks-help">
            <div className="modal-head">
              <h3>{t('brooks:help.title')}</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowHelp(false)}>
                {t('brooks:help.close')}
              </button>
            </div>
            <div className="modal-body">
              <h4>{t('brooks:help.structureTitle')}</h4>
              <ul>
                {(t('brooks:help.structure', { returnObjects: true }) as string[]).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <h4>{t('brooks:help.signalTitle')}</h4>
              <ul>
                {(t('brooks:help.signalList', { returnObjects: true }) as string[]).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <h4>{t('brooks:help.aiTitle')}</h4>
              <ul>
                {(t('brooks:help.aiList', { returnObjects: true }) as string[]).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <h4>{t('brooks:help.scaleTitle')}</h4>
              <ul>
                {(t('brooks:help.scaleList', { returnObjects: true }) as string[]).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
              <p className="brooks-disclaimer">{t('brooks:help.disclaimer')}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
