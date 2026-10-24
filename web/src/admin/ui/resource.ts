import { useCallback, useEffect, useRef, useState } from "react";
/** Read lifecycle only. Domain endpoints, mutations and policies stay in features. */
export function useResource<T>(load: () => Promise<T>, pollMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const sequence = useRef(0);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    if (!alive.current) return;
    const request = ++sequence.current;
    setLoading(true);
    try {
      const result = await load();
      if (alive.current && request === sequence.current) {
        setData(result);
        setError("");
      }
    } catch (e) {
      if (alive.current && request === sequence.current)
        setError((e as Error).message);
    } finally {
      if (alive.current && request === sequence.current) setLoading(false);
    }
  }, [load]);
  useEffect(() => {
    alive.current = true;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setData(undefined);
    const tick = async (): Promise<void> => {
      await reload();
      if (current && pollMs) timer = setTimeout(() => void tick(), pollMs);
    };
    void tick();
    return () => {
      current = false;
      alive.current = false;
      sequence.current++;
      clearTimeout(timer);
    };
  }, [reload, pollMs]);
  return { data, loading, error, reload };
}
