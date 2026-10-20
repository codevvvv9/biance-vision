/**
 * 研究中栏 K 线取数：无打开 run 时拉 /api/market/candles（可带 asOf 冻结）；
 * 打开 run 且有冻结输入包时读 /api/research/runs/:id/candles（评审 F3：图表与分析同一输入包，
 * 历史复盘图表可复现，修订历史 K 线不改变已发布 run 的对应图）。OHLC 为十进制字符串（numeric 同源契约），入图前转数值。
 */
import { useEffect, useMemo, useState } from 'react'
import i18n from '../i18n'
import { api } from '../api'
import type { KlineBar } from '../types'

export interface ResearchCandle {
  openTime: number
  open: number
  high: number
  low: number
  close: number
  closeTime: number
  isClosed: boolean
}

interface CandleRowDto {
  openTime: number
  open: string | number
  high: string | number
  low: string | number
  close: string | number
  closeTime: number
  volume: string | number | null
  isClosed: boolean
}

export interface ResearchCandles {
  candles: ResearchCandle[]
  /**  BrooksChart/klinecharts 入图形态（time = openTime） */
  bars: KlineBar[]
  loading: boolean
  error: string
  /** 数据来源（评审 R5：区分「已冻结输入包」与「实时库按历史时间重建」，拒绝静默替换） */
  source: 'snapshot' | 'live' | null
  /** run 冻结视图下回退实时库的原因（快照包不存在/读取失败/缺该周期） */
  fallbackReason: string | null
}

/** 冻结输入包不可用原因（服务端 /runs/:id/candles 的 reason 契约）→ research:candle.* 词典 key。
 * 未知原因回退旧文案；不再把「后端不一致/缺周期」混为一谈（2026-10-19 双后端分裂教训） */
const PACK_REASON_KEYS: Record<string, string> = {
  no_snapshot: 'research:candle.no_snapshot',
  no_key: 'research:candle.no_key',
  blob_missing: 'research:candle.blob_missing',
  hash_mismatch: 'research:candle.hash_mismatch',
  no_interval: 'research:candle.no_interval',
}

const packFallbackText = (reason?: string): string =>
  reason !== undefined && PACK_REASON_KEYS[reason] !== undefined
    ? i18n.t(PACK_REASON_KEYS[reason])
    : i18n.t('research:candle.fallbackGeneric')

export function useResearchCandles(
  symbol: string,
  marketType: 'spot' | 'usdm_perp',
  interval: string,
  asOf?: number,
  /** 打开的研究运行 id（评审 F3）：有冻结输入包时图表读快照，历史复盘可复现；无包自动回退实时库 */
  runId?: string | null,
): ResearchCandles {
  const [candles, setCandles] = useState<ResearchCandle[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [source, setSource] = useState<'snapshot' | 'live' | null>(null)
  const [fallbackReason, setFallbackReason] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    const mapRows = (rows: CandleRowDto[]): ResearchCandle[] =>
      rows.map((c) => ({
        openTime: c.openTime,
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        closeTime: c.closeTime,
        isClosed: c.isClosed,
      }))
    const fetchLive = async (): Promise<ResearchCandle[]> => {
      const params = new URLSearchParams({ marketType, priceType: 'trade', symbol, interval, limit: '300' })
      if (asOf !== undefined) params.set('asOf', String(asOf))
      const r = await api<{ candles: CandleRowDto[] }>(`/market/candles?${params.toString()}`)
      return mapRows(r.candles)
    }
    ;(async (): Promise<{ rows: ResearchCandle[]; source: 'snapshot' | 'live'; fallbackReason: string | null }> => {
      // 优先读 run 的冻结输入包（snapshot:true）；不可读时回退实时库但必须显式标记来源（评审 R5）
      if (runId !== undefined && runId !== null && runId !== '') {
        try {
          const r = await api<{ snapshot: boolean; candles: CandleRowDto[]; reason?: string }>(
            `/research/runs/${runId}/candles?${new URLSearchParams({ interval, priceType: 'trade' }).toString()}`,
          )
          if (r.snapshot && r.candles.length > 0) return { rows: mapRows(r.candles), source: 'snapshot', fallbackReason: null }
          return { rows: await fetchLive(), source: 'live', fallbackReason: packFallbackText(r.reason) }
        } catch (e) {
          return { rows: await fetchLive(), source: 'live', fallbackReason: i18n.t("research:candle.fallbackWithReason", { msg: (e as Error).message }) }
        }
      }
      return { rows: await fetchLive(), source: 'live', fallbackReason: null }
    })()
      .then((out) => {
        if (!alive) return
        setCandles(out.rows)
        setSource(out.source)
        setFallbackReason(out.fallbackReason)
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [symbol, marketType, interval, asOf, runId])

  const bars = useMemo<KlineBar[]>(
    () =>
      candles.map((c) => ({
        time: c.openTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: 0,
        closed: c.isClosed,
      })),
    [candles],
  )

  return { candles, bars, loading, error, source, fallbackReason }
}
