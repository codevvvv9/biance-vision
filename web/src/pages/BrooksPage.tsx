/**
 * 价格行为复盘页（/brooks）：Al Brooks 理论的结构识别学习工具。
 * K 线 + 结构标注（摆动点/腿/内外包/信号）+ 当前状态摘要 + 信号清单（带规则出处）。
 * 纯结构识别、只认收盘K线，不做任何行情预测。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useMarket } from '../market/MarketContext'
import { fmtDateTime, lsGet, lsSet } from '../utils'
import BrooksChart from '../brooks/BrooksChart'
import type { BrooksChartHandle } from '../brooks/BrooksChart'
import { analyzeBrooks } from '../brooks/analyze'
import type { BrooksDisplay, BrooksSignal } from '../brooks/types'
import type { KlineBar } from '../types'

const INTERVALS: { v: string; t: string }[] = [
  { v: '1m', t: '1分' },
  { v: '5m', t: '5分' },
  { v: '15m', t: '15分' },
  { v: '1h', t: '1时' },
  { v: '4h', t: '4时' },
  { v: '1d', t: '日线' },
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
  { v: 1, t: '微观', hint: 'k=1：微观摆动，噪音多，贴近逐根K线读法' },
  { v: 2, t: '精细', hint: 'k=2：偏微观的结构' },
  { v: 3, t: '标准', hint: 'k=3：社区共识的默认尺度（AxisJu/ByteBard 均用 3）' },
  { v: 5, t: '主要', hint: 'k=5：只看主要摆动点，结构更干净但更滞后' },
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

const TOGGLES: { key: keyof BrooksDisplay; label: string }[] = [
  { key: 'regime', label: '状态条' },
  { key: 'ema', label: 'EMA20' },
  { key: 'legs', label: '腿连线' },
  { key: 'swings', label: '摆动标签' },
  { key: 'io', label: '内/外包' },
  { key: 'signals', label: '信号' },
]

type SignalFilter = 'all' | 'bull' | 'bear'

function sigDirClass(s: BrooksSignal): string {
  return s.direction === 'bull' ? 'bull' : s.direction === 'bear' ? 'bear' : 'neutral'
}

export default function BrooksPage(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams()
  const { order, subscribeKline, upColor } = useMarket()
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

  const analysis = useMemo(() => (bars.length > 0 ? analyzeBrooks(bars, { swingK }) : null), [bars, swingK])

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
          setError(e.message || 'K 线加载失败')
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
              placeholder="交易对，如 BTCUSDT"
              list="brooks-symbol-list"
              spellCheck={false}
            />
            <datalist id="brooks-symbol-list">
              {order.slice(0, 60).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <button className="btn btn-primary btn-sm" type="submit">
              分析
            </button>
          </form>
          <div className="interval-group" role="tablist">
            {INTERVALS.map((iv) => (
              <button key={iv.v} className={iv.v === interval ? 'on' : ''} onClick={() => applyInterval(iv.v)}>
                {iv.t}
              </button>
            ))}
          </div>
          <div className="interval-group" role="group" aria-label="摆动尺度">
            {SCALES.map((s) => (
              <button
                key={s.v}
                title={s.hint}
                className={s.v === swingK ? 'on' : ''}
                onClick={() => setSwingK(s.v)}
              >
                {s.t}·{s.v}
              </button>
            ))}
          </div>
          <div className="interval-group" role="group" aria-label="K线数量">
            {LIMITS.map((n) => (
              <button key={n} className={n === limit ? 'on' : ''} onClick={() => setLimit(n)}>
                {n}根
              </button>
            ))}
          </div>
          <div className="brooks-toggles">
            {TOGGLES.map((t) => (
              <button
                key={t.key}
                className={`brooks-toggle${display[t.key] ? ' on' : ''}`}
                onClick={() => toggleDisplay(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowHelp(true)}>
            ? 图例与规则
          </button>
        </div>
      </section>

      <div className="brooks-grid">
        <section className="panel chart-panel brooks-chart-panel">
          <div className="panel-head">
            <h2 className="panel-title">
              <span className="title-glyph teal">▮</span>
              {symbol.replace('USDT', '')}/USDT · 价格行为结构 · {INTERVALS.find((i) => i.v === interval)?.t}
              {analysis ? `（尺度 k=${analysis.options.swingK}）` : ''}
            </h2>
            <div className="panel-head-tools">
              <span className="brooks-note">只识别结构 · 不预测涨跌 · 仅收盘K线计入信号</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setReload((n) => n + 1)}>
                刷新
              </button>
            </div>
          </div>
          <div className="brooks-chart-hold">
            <BrooksChart ref={chartRef} bars={bars} analysis={analysis} display={display} upColor={upColor} />
            {loading && <div className="chart-mask">加载 {symbol} K 线…</div>}
            {error && (
              <div className="chart-mask error">
                <span>{error}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setReload((n) => n + 1)}>
                  重试
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="brooks-side">
          <section className="panel">
            <div className="panel-head">
              <h3 className="panel-title">
                <span className="title-glyph amber">◆</span>当前结构
              </h3>
            </div>
            {summary ? (
              <div className="brooks-summary">
                <div className="brooks-kv">
                  <span className="k">市场状态</span>
                  <span className={`brooks-chip regime-${summary.regime}`}>{summary.regimeText}</span>
                </div>
                <div className="brooks-kv">
                  <span className="k">Always In</span>
                  <span className={`brooks-chip dir-${summary.alwaysIn}`}>
                    {summary.alwaysIn === 'bull' ? '多头' : summary.alwaysIn === 'bear' ? '空头' : '方向不明'}
                  </span>
                </div>
                <div className="brooks-sub">{summary.alwaysInReason}（自第 {summary.alwaysInSince + 1} 根）</div>
                <div className="brooks-kv">
                  <span className="k">结构判定</span>
                  <span className="v">{summary.trendStructure}</span>
                </div>
                <div className="brooks-kv">
                  <span className="k">摆动序列</span>
                  <span className="v mono">{summary.swingSequence}</span>
                </div>
                {lastLeg && (
                  <div className="brooks-kv">
                    <span className="k">最近一腿</span>
                    <span className="v">
                      {lastLeg.direction === 'up' ? '↑' : '↓'} {lastLeg.barCount} 根 · 趋势棒 {lastLeg.trendBarCount}
                      {lastLeg.retracementOfPrev !== undefined
                        ? ` · 相对前腿 ${(lastLeg.retracementOfPrev * 100).toFixed(0)}%`
                        : ''}
                    </span>
                  </div>
                )}
                <div className="brooks-kv">
                  <span className="k">信号统计</span>
                  <span className="v">
                    共 {signals.length} 条 · 多头 {bullCount} · 空头 {bearCount}
                  </span>
                </div>
              </div>
            ) : (
              <div className="brooks-sub">加载中或K线不足（至少需要 30 根收盘K线）…</div>
            )}
          </section>

          <section className="panel brooks-signals-panel">
            <div className="panel-head">
              <h3 className="panel-title">
                <span className="title-glyph amber">◆</span>研究信号（新→旧）
              </h3>
              <div className="panel-head-tools brooks-filter">
                {(['all', 'bull', 'bear'] as SignalFilter[]).map((f) => (
                  <button key={f} className={f === filter ? 'on' : ''} onClick={() => setFilter(f)}>
                    {f === 'all' ? '全部' : f === 'bull' ? '多头' : '空头'}
                  </button>
                ))}
              </div>
            </div>
            <div className="brooks-signal-list">
              {visibleSignals.length === 0 && <div className="brooks-sub">暂无信号（该周期结构未触发规则）</div>}
              {visibleSignals.map((s, idx) => (
                <button
                  key={`${s.kind}-${s.index}-${idx}`}
                  className={`brooks-signal ${sigDirClass(s)}`}
                  onClick={() => chartRef.current?.scrollTo(s.index)}
                  title="点击定位到图上对应K线"
                >
                  <div className="brooks-signal-head">
                    <span className={`brooks-sig-chip ${sigDirClass(s)} strength-${s.strength}`}>{s.label}</span>
                    <span className="brooks-signal-title">{s.title}</span>
                    <span className="brooks-signal-time">{fmtDateTime(s.time)}</span>
                  </div>
                  <div className="brooks-signal-reason">{s.reason}</div>
                  <div className="brooks-signal-concept">{s.concept}</div>
                  {s.prior && <div className="brooks-signal-prior">先验：{s.prior}</div>}
                  {s.ref && (s.ref.entry !== undefined || s.ref.stop !== undefined || s.ref.target !== undefined) && (
                    <div className="brooks-signal-ref mono">
                      {s.ref.entry !== undefined && <span>突破 {s.ref.entry.toPrecision(6)}</span>}
                      {s.ref.stop !== undefined && <span>止损 {s.ref.stop.toPrecision(6)}</span>}
                      {s.ref.target !== undefined && <span>目标 {s.ref.target.toPrecision(6)}</span>}
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
              <h3>图例与规则速查（Al Brooks 价格行为）</h3>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowHelp(false)}>
                关闭
              </button>
            </div>
            <div className="modal-body">
              <h4>结构标注</h4>
              <ul>
                <li>
                  <b>HH / LH</b>（K线上方）：更高高顶 / 更低高顶；<b>HL / LL</b>（K线下方）：更高低底 / 更低低底。
                  HH+HL 交替 = 多头结构，LH+LL 交替 = 空头结构。
                </li>
                <li>
                  <b>i / O / ii / oo / ioi</b>：内包线 / 外包线 / 连续内包 / 连续外包 / 内包-外包-内包。
                  内包 = 突破模式（观望），ii 是日内最可靠的突破形态之一。
                </li>
                <li>
                  <b>顶部状态条</b>：绿=多头通道（亮绿=冲刺）、红=空头通道（亮红=冲刺）、琥珀=交易区间、紫=紧凑区间/铁丝网。
                </li>
                <li>
                  <b>EMA20</b>（青色虚线）：Brooks 判定趋势的基准——20 根收盘 ≥70% 在一侧 = 趋势，否则震荡。
                </li>
              </ul>
              <h4>信号</h4>
              <ul>
                <li>
                  <b>H1~H4 / L1~L4</b>：多头/空头回调中的进场计数。H2/L2 = 二次进场，是 Brooks 体系中胜率最高的结构（先验 ≈60%）。
                </li>
                <li>
                  <b>楔顶/楔底</b>：三推反转（跨度 ≤40 根），第三推动能衰减时可靠性更高。
                </li>
                <li>
                  <b>双顶/双底</b>：两个摆动点近似等高/等低（容差 0.3×ATR，间隔 ≥3 根）。
                </li>
                <li>
                  <b>破线↓/↑（TLB）</b>：趋势线被收盘穿越——只是警戒：约 50% 概率趋势恢复、50% 走向反转。
                </li>
                <li>
                  <b>MTR</b>：主要趋势反转 = 趋势线突破 + 测试 + 反转信号三步齐备。
                </li>
                <li>
                  <b>区间破↑/↓</b>：交易区间突破。先验：80% 的区间突破尝试失败，首次突破仅约 50% 存活——只作研究关注。
                </li>
                <li>
                  <b>冲刺↑/↓</b>：连续 ≥5 根同向趋势棒（spike），spike and channel 的起点。
                </li>
              </ul>
              <h4>摆动尺度 k</h4>
              <ul>
                <li>
                  摆动点需右侧 k 根K线确认（信号天然滞后 k 根，且不重绘）。k=1 微观（噪音多）→ k=3 标准（推荐）→ k=5 主要摆动。
                  Brooks 本人强调结构是分形的：换尺度看同一份K线，本身就是练习。
                </li>
              </ul>
              <p className="brooks-disclaimer">
                本工具把 Brooks 三部曲的K线结构规则量化为确定性代码，仅供学习复盘研究；信号是结构标注而非交易指令，不构成任何投资建议。
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
