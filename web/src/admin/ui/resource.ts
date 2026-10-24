import { useCallback, useEffect, useRef, useState } from 'react'
/** Read lifecycle only. Domain endpoints, mutations and policies stay in features. */
export function useResource<T>(load: () => Promise<T>, pollMs = 0) {
  const [data, setData] = useState<T>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const sequence = useRef(0)
  const alive = useRef(true)
  const reload = useCallback(async () => {
    const request = ++sequence.current
    setLoading(true)
    try { const result = await load(); if (alive.current && request === sequence.current) { setData(result); setError('') } }
    catch (e) { if (alive.current && request === sequence.current) setError((e as Error).message) }
    finally { if (alive.current && request === sequence.current) setLoading(false) }
  }, [load])
  useEffect(() => { alive.current = true; setData(undefined); void reload(); const timer = pollMs ? window.setInterval(() => void reload(), pollMs) : undefined; return () => { alive.current = false; sequence.current++; clearInterval(timer) } }, [reload, pollMs])
  return { data, loading, error, reload }
}
