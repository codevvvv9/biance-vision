import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { beep, sysNotify } from '../notify'
import { lsGet, lsSet, readUpColor, writeUpColor } from '../utils'
import type { UpColorMode } from '../utils'
import type { AlertEntry, ConnStatus, KlineBar, MarketStats, ServerMessage, ToastItem, Ticker } from '../types'

interface ToastInput {
  kind?: 'alert' | 'info'
  title: string
  body?: string
}

interface MarketContextValue {
  tickers: Record<string, Ticker>
  order: string[]
  stats: MarketStats | null
  status: ConnStatus
  alertsHistory: AlertEntry[]
  toasts: ToastItem[]
  pushToast: (toast: ToastInput) => number
  dismissToast: (id: number) => void
  subscribeKline: (symbol: string, interval: string, cb: (k: KlineBar) => void) => () => void
  soundOn: boolean
  toggleSound: () => void
  upColor: UpColorMode
  toggleUpColor: () => void
}

const Ctx = createContext<MarketContextValue | null>(null)

export function MarketProvider({ children }: { children: ReactNode }): JSX.Element {
  const [tickers, setTickers] = useState<Record<string, Ticker>>({})
  const [order, setOrder] = useState<string[]>([])
  const [stats, setStats] = useState<MarketStats | null>(null)
  const [status, setStatus] = useState<ConnStatus>('connecting')
  const [alertsHistory, setAlertsHistory] = useState<AlertEntry[]>([])
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [soundOn, setSoundOn] = useState<boolean>(() => lsGet<boolean>('bv.sound', true))
  const [upColor, setUpColor] = useState<UpColorMode>(() => readUpColor())

  const wsRef = useRef<WebSocket | null>(null)
  const aliveRef = useRef(true)
  const backoffRef = useRef(1000)
  const klineSubs = useRef(new Map<string, Set<(k: KlineBar) => void>>())
  const toastIdRef = useRef(0)
  const soundRef = useRef(soundOn)
  soundRef.current = soundOn

  const pushToast = useCallback((toast: ToastInput): number => {
    const id = ++toastIdRef.current
    const t: ToastItem = { id, kind: toast.kind ?? 'info', title: toast.title, body: toast.body }
    setToasts((list) => [...list.slice(-5), t])
    const ttl = t.kind === 'alert' ? 14000 : 5000
    setTimeout(() => {
      setToasts((list) => list.filter((x) => x.id !== id))
    }, ttl)
    return id
  }, [])

  const dismissToast = useCallback((id: number): void => {
    setToasts((list) => list.filter((x) => x.id !== id))
  }, [])

  const handleAlert = useCallback(
    (entry: AlertEntry): void => {
      setAlertsHistory((h) => [entry, ...h].slice(0, 100))
      pushToast({ kind: 'alert', title: `${entry.symbol} · 预警触发`, body: entry.message })
      sysNotify(`${entry.symbol} 预警触发`, entry.message)
      if (soundRef.current) beep()
    },
    [pushToast],
  )

  const handleMessage = useCallback(
    (msg: ServerMessage): void => {
      if (msg.type === 'market') {
        const map: Record<string, Ticker> = {}
        for (const t of msg.tickers) {
          map[t.s] = {
            symbol: t.s,
            last: +t.c,
            changePct: +t.P,
            high: +t.h,
            low: +t.l,
            quoteVolume: +t.q,
          }
        }
        setTickers(map)
        setOrder(Object.keys(map).sort((a, b) => map[b].quoteVolume - map[a].quoteVolume))
        setStats(msg.stats)
      } else if (msg.type === 'alert') {
        handleAlert(msg.alert)
      } else if (msg.type === 'kline') {
        const cbs = klineSubs.current.get(`${msg.symbol}|${msg.interval}`)
        if (cbs) for (const cb of cbs) cb(msg.kline)
      }
    },
    [handleAlert],
  )

  useEffect(() => {
    aliveRef.current = true
    let ws: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const sendSub = (obj: unknown): void => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
    }
    const connect = (): void => {
      if (!aliveRef.current) return
      setStatus('connecting')
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      wsRef.current = ws
      ws.onopen = () => {
        backoffRef.current = 1000
        setStatus('connected')
        sendSub({ type: 'subscribe', channel: 'market' })
        for (const key of klineSubs.current.keys()) {
          const [symbol, interval] = key.split('|')
          sendSub({ type: 'subscribe', channel: 'kline', symbol, interval })
        }
      }
      ws.onmessage = (e: MessageEvent) => {
        try {
          handleMessage(JSON.parse(e.data as string) as ServerMessage)
        } catch {
          /* noop */
        }
      }
      ws.onclose = () => {
        if (!aliveRef.current) return
        setStatus('offline')
        timer = setTimeout(connect, backoffRef.current)
        backoffRef.current = Math.min(backoffRef.current * 2, 10000)
      }
      ws.onerror = () => {
        try {
          ws?.close()
        } catch {
          /* noop */
        }
      }
    }
    connect()

    void api<{ history: AlertEntry[] }>('/alerts/history?limit=50')
      .then((d) => setAlertsHistory(d.history))
      .catch(() => {})

    return () => {
      aliveRef.current = false
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {
        /* noop */
      }
    }
  }, [handleMessage])

  /** 订阅某交易对某周期的实时 K 线推送，返回取消函数（引用计数，多组件共享连接） */
  const subscribeKline = useCallback((symbol: string, interval: string, cb: (k: KlineBar) => void): (() => void) => {
    const key = `${symbol}|${interval}`
    let set = klineSubs.current.get(key)
    const fresh = !set
    if (!set) {
      set = new Set()
      klineSubs.current.set(key, set)
    }
    set.add(cb)
    if (fresh && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'subscribe', channel: 'kline', symbol, interval }))
    }
    return () => {
      const s = klineSubs.current.get(key)
      if (!s) return
      s.delete(cb)
      if (s.size === 0) {
        klineSubs.current.delete(key)
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(
            JSON.stringify({ type: 'unsubscribe', channel: 'kline', symbol, interval }),
          )
        }
      }
    }
  }, [])

  const toggleSound = useCallback((): void => {
    setSoundOn((v) => {
      lsSet('bv.sound', !v)
      return !v
    })
  }, [])

  const toggleUpColor = useCallback((): void => {
    setUpColor((m) => {
      const next: UpColorMode = m === 'green' ? 'red' : 'green'
      writeUpColor(next)
      return next
    })
  }, [])

  const value = useMemo<MarketContextValue>(
    () => ({
      tickers,
      order,
      stats,
      status,
      alertsHistory,
      toasts,
      pushToast,
      dismissToast,
      subscribeKline,
      soundOn,
      toggleSound,
      upColor,
      toggleUpColor,
    }),
    [tickers, order, stats, status, alertsHistory, toasts, pushToast, dismissToast, subscribeKline, soundOn, toggleSound, upColor, toggleUpColor],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useMarket(): MarketContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useMarket 必须在 MarketProvider 内使用')
  return v
}
