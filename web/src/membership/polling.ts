import { useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { PollingStore } from 'biance-vision-brooks'
export function usePolling<T>(store: PollingStore<T>) {
  const { t } = useTranslation('common')
  useEffect(() => {
    const changed = () => store.invalidate()
    window.addEventListener('bv:admin-membership-changed', changed)
    return () =>
      window.removeEventListener('bv:admin-membership-changed', changed)
  }, [store])
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  return {
    ...snapshot,
    error:
      snapshot.error && snapshot.updatedAt
        ? `${snapshot.error} · ${t('membership.lastUpdated')} ${new Date(snapshot.updatedAt).toLocaleTimeString()}`
        : snapshot.error,
  }
}
