/** Framework-independent, single-flight polling. Environment injection makes lifecycle tests deterministic. */
export interface PollingEnvironment {
  now(): number
  random(): number
  active(): boolean
  schedule(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
  listen(wake: () => void, pause: () => void): () => void
}
export interface PollingSnapshot<T> {
  data: T | undefined
  error: string
  loading: boolean
  updatedAt: number
}
export interface PollingStore<T> {
  subscribe(listener: () => void): () => void
  getSnapshot(): PollingSnapshot<T>
  /** `force` bypasses the failure backoff gate — reserved for explicit user retries. */
  refresh(force?: boolean): Promise<void>
  invalidate(): void
}
export function browserPollingEnvironment(): PollingEnvironment {
  // Structural types avoid coupling the shared engine to browser/React types.
  const host = globalThis as unknown as {
    document?: {
      visibilityState: string
      addEventListener(t: string, f: () => void): void
      removeEventListener(t: string, f: () => void): void
    }
    navigator?: { onLine: boolean }
    addEventListener?: (t: string, f: () => void) => void
    removeEventListener?: (t: string, f: () => void) => void
  }
  return {
    now: Date.now,
    random: Math.random,
    active: () =>
      !!host.document &&
      host.document.visibilityState === 'visible' &&
      host.navigator?.onLine !== false,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    listen: (wake, pause) => {
      const check = () => {
        if (
          host.document?.visibilityState === 'visible' &&
          host.navigator?.onLine !== false
        )
          wake()
        else pause()
      }
      host.document?.addEventListener('visibilitychange', check)
      host.addEventListener?.('focus', check)
      host.addEventListener?.('online', check)
      host.addEventListener?.('offline', check)
      return () => {
        host.document?.removeEventListener('visibilitychange', check)
        host.removeEventListener?.('focus', check)
        host.removeEventListener?.('online', check)
        host.removeEventListener?.('offline', check)
      }
    },
  }
}
export function createPollingStore<T>(options: {
  load: (signal: AbortSignal) => Promise<T>
  intervalSeconds: (data: T) => number
  boundaryAt?: (data: T) => number | undefined
  environment?: PollingEnvironment
  /** Server-rendered seed: the first snapshot carries it so SSR and hydration agree. */
  initial?: T
  initialUpdatedAt?: number
}): PollingStore<T> {
  const env = options.environment ?? browserPollingEnvironment(),
    listeners = new Set<() => void>()
  let snapshot: PollingSnapshot<T> = {
    data: options.initial,
    error: '',
    loading: false,
    updatedAt: options.initial === undefined ? 0 : options.initialUpdatedAt ?? 0,
  }
  let timer: unknown,
    timeout: unknown,
    controller: AbortController | undefined,
    flight: Promise<void> | undefined,
    unlisten: (() => void) | undefined
  let generation = 0,
    failures = 0,
    retryNotBefore = 0,
    pending = false,
    lastWake = -Infinity
  const emit = (patch: Partial<PollingSnapshot<T>>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach((fn) => fn())
  }
  const clear = () => {
    if (timer !== undefined) env.cancel(timer)
    timer = undefined
  }
  const interval = () => {
    let seconds = 60
    try {
      const configured = snapshot.data
        ? options.intervalSeconds(snapshot.data)
        : 60
      if (Number.isFinite(configured)) seconds = configured
    } catch {
      /* Malformed data must never create a zero-delay polling loop. */
    }
    return Math.max(30, Math.min(300, seconds)) * 1000
  }
  const plan = (retryAfter = 0) => {
    clear()
    if (!listeners.size || !env.active()) return
    const backoff = failures
      ? Math.min(300000, interval() * 2 ** Math.min(failures, 4))
      : interval()
    let delay = Math.max(
      Math.min(300000, backoff * (1 + env.random() * 0.1)),
      retryAfter,
    )
    if (!failures && snapshot.data && options.boundaryAt) {
      const boundary = options.boundaryAt(snapshot.data)
      if (boundary && boundary > env.now() && boundary - env.now() < delay) {
        delay = boundary - env.now()
      }
    }
    if (failures) {
      delay = Math.max(delay, retryNotBefore - env.now())
      retryNotBefore = env.now() + delay
    }
    timer = env.schedule(() => {
      timer = undefined
      void refresh()
    }, delay)
  }
  const refresh = (force = false): Promise<void> => {
    if (flight) return flight
    clear()
    if (!listeners.size || !env.active()) return Promise.resolve()
    if (!force && retryNotBefore > env.now()) {
      timer = env.schedule(() => void refresh(), retryNotBefore - env.now())
      return Promise.resolve()
    }
    const gen = generation,
      abort = new AbortController()
    controller = abort
    lastWake = env.now()
    emit({ loading: !snapshot.data })
    let retryAfter = 0
    const timeoutError = new Error('状态查询超时 / Status request timed out')
    let callTimeout: unknown
    const timeoutPromise = new Promise<never>((_, reject) => {
      callTimeout = env.schedule(() => {
        abort.abort()
        reject(timeoutError)
      }, 8000)
      timeout = callTimeout
    })
    flight = (async () => {
      try {
        const data = await Promise.race([
          Promise.resolve().then(() => options.load(abort.signal)),
          timeoutPromise,
        ])
        if (gen !== generation || abort.signal.aborted) return
        failures = 0
        retryNotBefore = 0
        emit({ data, error: '', updatedAt: env.now(), loading: false })
      } catch (error) {
        if (gen !== generation) return
        failures++
        const e = error as {
          message?: string
          retryAfterSeconds?: number | null
        }
        const seconds = Number(e.retryAfterSeconds ?? 0)
        retryAfter = Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : 0
        emit({ error: e.message ?? String(error), loading: false })
      } finally {
        if (callTimeout !== undefined) env.cancel(callTimeout)
        if (gen === generation) {
          timeout = undefined
          controller = undefined
          flight = undefined
          if (pending && !failures) {
            pending = false
            void refresh()
          } else {
            pending = false
            plan(retryAfter)
          }
        }
      }
    })()
    return flight
  }
  const pause = () => {
    clear()
  } // An in-flight read may finish; only future requests pause.
  const wake = () => {
    if (flight) return
    if (env.now() - lastWake < 1000) {
      if (timer === undefined) plan()
      return
    }
    void refresh()
  }
  return {
    getSnapshot: () => snapshot,
    refresh,
    invalidate: () => {
      if (flight) pending = true
      else {
        clear()
        // Merge mutation completion and all subscribers' invalidations in the same turn.
        if (listeners.size && env.active())
          timer = env.schedule(() => void refresh(), 0)
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      if (listeners.size === 1) {
        unlisten = env.listen(wake, pause)
        void refresh()
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          generation++
          clear()
          if (timeout !== undefined) env.cancel(timeout)
          timeout = undefined
          controller?.abort()
          controller = undefined
          flight = undefined
          pending = false
          unlisten?.()
          unlisten = undefined
        }
      }
    },
  }
}
