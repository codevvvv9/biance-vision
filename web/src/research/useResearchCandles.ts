/**
 * 研究中栏 K 线取数：无打开 run 时拉 /api/market/candles（可带 asOf 冻结）；
 * 打开 run 且有冻结输入包时读 /api/research/runs/:id/candles（评审 F3：图表与分析同一输入包，
 * 历史复盘图表可复现，修订历史 K 线不改变已发布 run 的对应图）。OHLC 为十进制字符串（numeric 同源契约），入图前转数值。
 */
import { useEffect, useMemo, useState } from 'react'
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
}

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
    ;(async () => {
      // 优先读 run 的冻结输入包（snapshot:true）；无包/无对应周期回退实时库（带 asOf）
      if (runId !== undefined && runId !== null && runId !== '') {
        try {
          const r = await api<{ snapshot: boolean; candles: CandleRowDto[] }>(
            `/research/runs/${runId}/candles?${new URLSearchParams({ interval, priceType: 'trade' }).toString()}`,
          )
          if (r.snapshot && r.candles.length > 0) return mapRows(r.candles)
        } catch {
          /* 快照包不可读 → 回退实时库 */
        }
      }
      return fetchLive()
    })()
      .then((rows) => {
        if (alive) setCandles(rows)
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

  return { candles, bars, loading, error }
}
