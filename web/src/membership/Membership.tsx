import {
  createContext,
  useContext,
  useMemo,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  createPollingStore,
  type MembershipStatus,
  type PollingStore,
} from 'biance-vision-brooks'
import { api } from '../api'
import { useAuth } from '../auth/AuthContext'
import { usePolling } from './polling'
const Context = createContext<PollingStore<MembershipStatus> | null>(null)
export function MembershipProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const store = useMemo(
    () =>
      createPollingStore<MembershipStatus>({
        load: (signal) => api('/users/me/membership', { signal }),
        intervalSeconds: (s) => s.refresh.userSeconds,
        boundaryAt: (s) =>
          Date.now() +
          Math.min(
            s.nextResetAt - s.serverTime,
            s.current?.endsAt && s.current.endsAt > s.serverTime
              ? s.current.endsAt - s.serverTime
              : Infinity,
          ),
      }),
    [user?.username],
  )
  useEffect(() => {
    const changed = () => store.invalidate()
    window.addEventListener('bv:membership-changed', changed)
    return () => window.removeEventListener('bv:membership-changed', changed)
  }, [store])
  return (
    <Context.Provider value={user ? store : null}>{children}</Context.Provider>
  )
}
export function useMembership() {
  const store = useContext(Context)
  return store
}
const emptySnapshot = {
  data: undefined,
  error: '',
  loading: false,
  updatedAt: 0,
}
const emptySubscribe = () => () => {}
const getEmpty = () => emptySnapshot
export function useMembershipState() {
  const store = useMembership()
  return useSyncExternalStore(
    store?.subscribe ?? emptySubscribe,
    store?.getSnapshot ?? getEmpty,
    store?.getSnapshot ?? getEmpty,
  )
}
export function MembershipCard() {
  const store = useMembership()
  return store ? <MembershipContent store={store} /> : null
}
function MembershipContent({
  store,
}: {
  store: PollingStore<MembershipStatus>
}) {
  const { user } = useAuth()
  const { i18n, t } = useTranslation('common'),
    zh = i18n.language.startsWith('zh'),
    { data: s, error, updatedAt } = usePolling(store)
  if (!s)
    return error ? (
      <p role="status">
        {error}{' '}
        <button onClick={() => void store.refresh()}>
          {t('membership.retry')}
        </button>
      </p>
    ) : null
  const labels = {
    legacy: t('membership.legacyAccount'),
    trial: t('membership.trial'),
    active: t('membership.active'),
    expired: t('membership.expired'),
    disabled: t('membership.disabled'),
  }
  const name = s.current
    ? zh
      ? s.current.name
      : s.current.nameEn
    : labels[s.status]
  const info = `Biance Vision\n${t('membership.account')}: ${user?.username ?? ''}\n${t('membership.plan')}: ${name}\n${t('membership.expires')}: ${s.current ? (s.current.endsAt ? new Date(s.current.endsAt).toLocaleString() : t('membership.lifetime')) : '—'}`
  const contact = s.contacts.telegram
    ? `https://t.me/${s.contacts.telegram}`
    : `mailto:${s.contacts.email}?subject=${encodeURIComponent('Biance Vision membership renewal')}&body=${encodeURIComponent(info)}`
  const progress = s.current?.endsAt
    ? Math.max(
        0,
        Math.min(
          100,
          ((s.serverTime +
            Math.max(0, Date.now() - updatedAt) -
            s.current.startsAt) /
            (s.current.endsAt - s.current.startsAt)) *
            100,
        ),
      )
    : 0
  return (
    <section
      className="membership-card"
      aria-label={t('membership.myMembership')}
    >
      <strong>{name}</strong> · <span>{labels[s.status]}</span>
      {s.current && (
        <>
          <p>
            {s.current.endsAt
              ? `${t('membership.expires2')} ${new Date(s.current.endsAt).toLocaleString()}`
              : t('membership.lifetime')}
          </p>
          {s.current.endsAt && (
            <progress
              max={100}
              value={progress}
              aria-label={t('membership.membershipProgress')}
            />
          )}
          <p>
            {t('membership.usedToday')} {s.usedToday} ·{' '}
            {t('membership.remaining')}{' '}
            {s.remainingToday ?? t('membership.unlimited')} ·{' '}
            {t('membership.resets')} {new Date(s.nextResetAt).toLocaleString()}
          </p>
        </>
      )}
      {s.legacyAccess && (
        <p>
          {t('membership.remaining')} {s.legacyAccess.remaining} /{' '}
          {s.legacyAccess.totalLimit}
        </p>
      )}
      {s.upcoming.map((p) => (
        <p key={p.id}>
          {t('membership.upcoming')}: {zh ? p.name : p.nameEn} ·{' '}
          {new Date(p.startsAt).toLocaleString()}
        </p>
      ))}
      {error && <p role="status">{error}</p>}
      {(s.contacts.telegram || s.contacts.email) && (
        <a href={contact} target="_blank" rel="noopener noreferrer">
          {t('membership.contactAdminToRenew')}
        </a>
      )}
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(info).catch(() => {})
        }}
      >
        {t('membership.copyMembershipDetails')}
      </button>
      <button type="button" onClick={() => void store.refresh()}>
        {t('membership.refresh')}
      </button>
    </section>
  )
}
