import { useEffect, useMemo, useState } from 'react'
import {
  App,
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd'
import {
  createPollingStore,
  type MembershipPlanRecord,
  type MembershipPlan,
  type MembershipCampaign,
  type MembershipRefresh,
} from 'biance-vision-brooks'
import { api } from '../api'
import { usePolling } from '../membership/polling'
import { useMemberLabel } from './MembershipForms'
import { MemberUserPanel } from './MemberUserPanel'
import { Modal, overlayContainer } from './ui/overlays'
import { useDirtyForm, useConfirmDiscard } from './ui/forms'
import styles from './ui/admin.module.css'
type Catalog = { plans: MembershipPlanRecord[]; refresh: MembershipRefresh }
function PlanEditor({
  record,
  onClose,
  onSaved,
}: {
  record: MembershipPlanRecord
  onClose: () => void
  onSaved: () => void
}) {
  const L = useMemberLabel(),
    discard = useConfirmDiscard(),
    [id, setId] = useState(record.id),
    [value, setValue] = useState(record.draft),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const dirty =
    id !== record.id || JSON.stringify(value) !== JSON.stringify(record.draft)
  useDirtyForm(dirty)
  const field = <K extends keyof MembershipPlan>(
    key: K,
    v: MembershipPlan[K],
  ) => setValue({ ...value, [key]: v })
  const close = async () => {
    if (!busy && (await discard(dirty))) onClose()
  }
  const profileStore = useMemo(
      () =>
        createPollingStore<{
          profiles: Record<string, { model: string; apiKeyMasked: string }>
        }>({
          load: (signal) => api('/admin/ai/config', { signal }),
          intervalSeconds: () => 300,
        }),
      [],
    ),
    profiles = usePolling(profileStore)
  const choices = Object.entries(profiles.data?.profiles ?? {}).map(
    ([value, p]) => ({
      value,
      label: `${value} · ${p.model}`,
      disabled: !p.apiKeyMasked,
    }),
  )
  return (
    <Modal
      open
      title={L('editPlanDraft')}
      footer={null}
      onCancel={() => void close()}
      width={760}
      closable={!busy}
      maskClosable={!busy}
    >
      {(error || profiles.error) && (
        <Alert type="error" message={error || profiles.error} />
      )}
      <Form
        layout="vertical"
        onFinish={async () => {
          setBusy(true)
          setError('')
          try {
            await api(`/admin/membership/plans/${encodeURIComponent(id)}`, {
              method: 'PUT',
              body: { config: value, expectedRevision: record.revision },
            })
            onSaved()
            onClose()
          } catch (e) {
            setError((e as Error).message)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Form.Item label={L('planIdentifier')}>
          <Input
            aria-label="Plan identifier"
            value={id}
            disabled={record.revision > 0}
            maxLength={40}
            onChange={(e) => setId(e.target.value)}
          />
        </Form.Item>
        <Space wrap>
          <Form.Item label={L('chineseName')}>
            <Input
              aria-label="Chinese plan name"
              value={value.name}
              onChange={(e) => field('name', e.target.value)}
            />
          </Form.Item>
          <Form.Item label="English name">
            <Input
              value={value.nameEn}
              onChange={(e) => field('nameEn', e.target.value)}
            />
          </Form.Item>
        </Space>
        <Form.Item label={L('chineseDescription')}>
          <Input.TextArea
            value={value.description}
            maxLength={1000}
            onChange={(e) => field('description', e.target.value)}
          />
        </Form.Item>
        <Form.Item label="English description">
          <Input.TextArea
            value={value.descriptionEn}
            maxLength={1000}
            onChange={(e) => field('descriptionEn', e.target.value)}
          />
        </Form.Item>
        <Space wrap>
          <Form.Item label={L('durationUnit')}>
            <Select
              style={{ width: 150 }}
              value={value.durationUnit}
              onChange={(v) => field('durationUnit', v)}
              options={[
                { value: 'day', label: L('days') },
                { value: 'month', label: L('calendarMonths') },
                { value: 'year', label: L('calendarYears') },
                { value: 'lifetime', label: L('lifetime') },
              ]}
            />
          </Form.Item>
          <Form.Item label={L('durationCount')}>
            <InputNumber
              min={1}
              max={3650}
              disabled={value.durationUnit === 'lifetime'}
              value={value.durationCount}
              onChange={(v) => field('durationCount', v ?? 1)}
            />
          </Form.Item>
        </Space>
        <Space wrap>
          <Form.Item label={L('regularPriceUsdt')}>
            <Input
              aria-label="Regular price"
              value={value.price}
              onChange={(e) => field('price', e.target.value)}
            />
          </Form.Item>
          <Form.Item label={L('introductoryPriceUsdt')}>
            <Input
              value={value.introPrice}
              onChange={(e) => field('introPrice', e.target.value)}
            />
          </Form.Item>
        </Space>
        <Space wrap>
          <Form.Item label={L('dailyLimitBlankUnlimited')}>
            <InputNumber
              min={1}
              max={100000}
              value={value.dailyLimit}
              onChange={(v) => field('dailyLimit', v)}
            />
          </Form.Item>
          <Form.Item label={L('requestsPerMinute')}>
            <InputNumber
              min={1}
              max={60}
              value={value.requestsPerMinute}
              onChange={(v) => field('requestsPerMinute', v ?? 6)}
            />
          </Form.Item>
          <Form.Item label={L('displayOrder')}>
            <InputNumber
              min={0}
              max={10000}
              value={value.sortOrder}
              onChange={(v) => field('sortOrder', v ?? 0)}
            />
          </Form.Item>
        </Space>
        <Form.Item label={L('chatAiConversationIntentTranslation')}>
          <Select
            aria-label="Chat AI profile"
            value={value.chatProfile}
            options={choices}
            onChange={(v) => field('chatProfile', v)}
          />
        </Form.Item>
        <Form.Item label={L('researchAiResearchPipeline')}>
          <Select
            aria-label="Research AI profile"
            value={value.researchProfile}
            options={choices}
            onChange={(v) => field('researchProfile', v)}
          />
        </Form.Item>
        <Form.Item label={L('features')}>
          <Space wrap>
            {(['chat', 'research', 'translate'] as const).map((k) => (
              <Checkbox
                key={k}
                checked={value.features[k]}
                onChange={(e) =>
                  field('features', {
                    ...value.features,
                    [k]: e.target.checked,
                  })
                }
              >
                {
                  {
                    chat: L('chat'),
                    research: L('research'),
                    translate: L('translation'),
                  }[k]
                }
              </Checkbox>
            ))}
          </Space>
        </Form.Item>
        <Form.Item>
          <Checkbox
            checked={value.public}
            onChange={(e) => field('public', e.target.checked)}
          >
            {L('showOnPublicWebsite')}
          </Checkbox>
        </Form.Item>
        <Alert
          type="info"
          message={L('saveAsDraftThenPublishForNewActivationsAnd')}
        />
        <Button
          style={{ marginTop: 16 }}
          type="primary"
          htmlType="submit"
          loading={busy}
          disabled={!id}
        >
          {L('saveDraft')}
        </Button>
      </Form>
    </Modal>
  )
}
function Plans() {
  const L = useMemberLabel(),
    { modal } = App.useApp(),
    store = useMemo(
      () =>
        createPollingStore<Catalog>({
          load: (signal) => api('/admin/membership/plans', { signal }),
          intervalSeconds: (d) => d.refresh.adminSeconds,
        }),
      [],
    ),
    r = usePolling(store),
    [editing, setEditing] = useState<MembershipPlanRecord | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      store.invalidate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const create = () => {
    const source = r.data?.plans[0]
    if (!source) return
    setEditing({
      id: '',
      revision: 0,
      publishedVersionId: null,
      enabled: false,
      versions: [],
      draft: { ...source.draft, name: '', nameEn: '', sortOrder: 10 },
    })
  }
  return (
    <Card>
      <Space wrap>
        <Button
          type="primary"
          onClick={create}
          disabled={!r.data?.plans.length}
        >
          {L('addPlan')}
        </Button>
        <Button onClick={() => void store.refresh()}>{L('refresh')}</Button>
      </Space>
      {(error || r.error) && <Alert type="error" message={error || r.error} />}
      <Table<MembershipPlanRecord>
        rowKey="id"
        loading={r.loading}
        dataSource={r.data?.plans ?? []}
        scroll={{ x: 900 }}
        columns={[
          {
            title: L('planDraft'),
            render: (_, p) =>
              `${p.draft.name} / ${p.draft.nameEn} · v${p.revision}`,
          },
          {
            title: L('publishedVersion'),
            render: (_, p) =>
              p.versions.find((v) => v.id === p.publishedVersionId)?.revision ??
              '—',
          },
          {
            title: L('status'),
            render: (_, p) => (
              <Tag color={p.enabled ? 'success' : 'default'}>
                {p.enabled ? L('listed') : L('unlisted')}
              </Tag>
            ),
          },
          {
            title: L('regularIntro'),
            render: (_, p) => `${p.draft.price} / ${p.draft.introPrice} USDT`,
          },
          {
            title: L('dailyQuota'),
            render: (_, p) => p.draft.dailyLimit ?? '∞',
          },
          {
            title: L('actions'),
            render: (_, p) => (
              <Space wrap>
                <Button disabled={busy} onClick={() => setEditing(p)}>
                  {L('edit')}
                </Button>
                <Button
                  disabled={
                    busy || p.versions.some((v) => v.revision === p.revision)
                  }
                  onClick={async () => {
                    if (
                      await modal.confirm({
                        getContainer: overlayContainer,
                        title: L('publishForNewActivationsAndRenewals'),
                        content: `${p.draft.name} · v${p.revision}`,
                      })
                    )
                      void run(() =>
                        api(`/admin/membership/plans/${p.id}/publish`, {
                          method: 'POST',
                          body: { expectedRevision: p.revision },
                        }),
                      )
                  }}
                >
                  {L('publish')}
                </Button>
                <Button
                  disabled={busy || !p.publishedVersionId}
                  onClick={() =>
                    void run(() =>
                      api(`/admin/membership/plans/${p.id}`, {
                        method: 'PATCH',
                        body: {
                          enabled: !p.enabled,
                          expectedRevision: p.revision,
                        },
                      }),
                    )
                  }
                >
                  {p.enabled ? L('unlist') : L('list')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {editing && (
        <PlanEditor
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={() => store.invalidate()}
        />
      )}
      <Typography.Paragraph type="secondary">
        {L('accessDurationAndAiReferencesAreVersionedKeysRemain')}
      </Typography.Paragraph>
    </Card>
  )
}
function CampaignForm({
  initial,
  onSaved,
}: {
  initial: MembershipCampaign
  onSaved: () => void
}) {
  const L = useMemberLabel(),
    [value, setValue] = useState(initial),
    [baseline, setBaseline] = useState(initial),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    dirty = JSON.stringify(value) !== JSON.stringify(baseline)
  useEffect(() => {
    if (!dirty) {
      setValue(initial)
      setBaseline(initial)
    }
  }, [initial, dirty])
  useDirtyForm(dirty)
  return (
    <Form
      layout="vertical"
      onFinish={async () => {
        setBusy(true)
        setError('')
        try {
          await api(`/admin/membership/campaigns/${value.id}`, {
            method: 'PUT',
            body: {
              name: value.name,
              enabled: value.enabled,
              capacity: value.capacity,
              startsAt: value.startsAt,
              endsAt: value.endsAt,
              expectedRevision: value.revision,
            },
          })
          setBaseline(value)
          onSaved()
        } catch (e) {
          setError((e as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      {error && <Alert type="error" message={error} />}
      <p>
        {L('capacityUsedRemaining')}: {initial.capacity} / {initial.used} /{' '}
        {initial.remaining}
      </p>
      <Form.Item label={L('campaignName')}>
        <Input
          value={value.name}
          onChange={(e) => setValue({ ...value, name: e.target.value })}
        />
      </Form.Item>
      <Form.Item label={L('capacity')}>
        <InputNumber
          min={initial.used}
          max={1000000}
          value={value.capacity}
          onChange={(v) => setValue({ ...value, capacity: v ?? 0 })}
        />
      </Form.Item>
      {(['startsAt', 'endsAt'] as const).map((k) => (
        <Form.Item
          key={k}
          label={k === 'startsAt' ? L('startsOptional') : L('endsOptional')}
        >
          <Input
            type="datetime-local"
            value={
              value[k]
                ? new Date(
                    value[k]! - new Date(value[k]!).getTimezoneOffset() * 60000,
                  )
                    .toISOString()
                    .slice(0, 16)
                : ''
            }
            onChange={(e) =>
              setValue({
                ...value,
                [k]: e.target.value ? Date.parse(e.target.value) : null,
              })
            }
          />
        </Form.Item>
      ))}
      <Form.Item>
        <Checkbox
          checked={value.enabled}
          onChange={(e) => setValue({ ...value, enabled: e.target.checked })}
        >
          {L('enableFirstPaymentOffer')}
        </Checkbox>
      </Form.Item>
      <Button htmlType="submit" type="primary" loading={busy} disabled={!dirty}>
        {L('saveCampaign')}
      </Button>
    </Form>
  )
}
function Campaigns() {
  const L = useMemberLabel(),
    store = useMemo(
      () =>
        createPollingStore<{
          campaigns: MembershipCampaign[]
          refresh: MembershipRefresh
        }>({
          load: (signal) => api('/admin/membership/campaigns', { signal }),
          intervalSeconds: (d) => d.refresh.adminSeconds,
        }),
      [],
    ),
    r = usePolling(store)
  return (
    <Card>
      {r.error && <Alert type="error" message={r.error} />}
      <Alert
        type="info"
        message={L('monthlyAnnualAndLifetimeShareSlotsFirstPaymentOnly')}
      />
      {r.data?.campaigns.map((c) => (
        <CampaignForm
          key={c.id}
          initial={c}
          onSaved={() => store.invalidate()}
        />
      ))}
    </Card>
  )
}
function RefreshSettings() {
  const L = useMemberLabel(),
    store = useMemo(
      () =>
        createPollingStore<{ refresh: MembershipRefresh }>({
          load: (signal) =>
            api('/admin/membership/refresh-settings', { signal }),
          intervalSeconds: (d) => d.refresh.adminSeconds,
        }),
      [],
    ),
    r = usePolling(store)
  return (
    <Card>
      {r.error && <Alert type="error" message={r.error} />}
      <Alert
        type="info"
        message={L('pollingRunsOnlyWhileVisibleAndOnlineRequestsAre')}
      />
      {r.data && (
        <RefreshForm
          key="refresh-settings"
          initial={r.data.refresh}
          onSaved={() => store.invalidate()}
        />
      )}
    </Card>
  )
}
function RefreshForm({
  initial,
  onSaved,
}: {
  initial: MembershipRefresh
  onSaved: () => void
}) {
  const L = useMemberLabel(),
    [value, setValue] = useState(initial),
    [baseline, setBaseline] = useState(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    dirty = JSON.stringify(value) !== JSON.stringify(baseline)
  useEffect(() => {
    if (!dirty) {
      setValue(initial)
      setBaseline(initial)
    }
  }, [initial, dirty])
  useDirtyForm(dirty)
  return (
    <Form
      layout="vertical"
      onFinish={async () => {
        setBusy(true)
        setError('')
        try {
          await api('/admin/membership/refresh-settings', {
            method: 'PUT',
            body: {
              userSeconds: value.userSeconds,
              adminSeconds: value.adminSeconds,
              publicSeconds: value.publicSeconds,
              expectedRevision: baseline.revision,
            },
          })
          setBaseline(value)
          onSaved()
        } catch (e) {
          setError((e as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      {error && <Alert type="error" message={error} />}
      <p>
        v{initial.revision} · {initial.updatedBy} ·{' '}
        {new Date(initial.updatedAt).toLocaleString()}
      </p>
      {(['userSeconds', 'adminSeconds', 'publicSeconds'] as const).map((k) => (
        <Form.Item
          key={k}
          label={
            {
              userSeconds: L('memberRefreshSeconds'),
              adminSeconds: L('adminRefreshSeconds'),
              publicSeconds: L('publicRefreshSeconds'),
            }[k]
          }
        >
          <InputNumber
            aria-label={k}
            min={30}
            max={300}
            precision={0}
            value={value[k]}
            onChange={(v) => setValue({ ...value, [k]: v ?? 60 })}
          />
        </Form.Item>
      ))}
      <Button type="primary" htmlType="submit" loading={busy} disabled={!dirty}>
        {L('saveRefreshSettings')}
      </Button>
    </Form>
  )
}
type MemberRow = {
  username: string
  managed: boolean
  membership_disabled: boolean
  chat_policy: { disabled?: boolean } | null
  config: MembershipPlan | null
  revision: number
  used: number
  ends_at: string | null
}
function Members() {
  const L = useMemberLabel(),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [selected, setSelected] = useState<string | null>(null)
  const store = useMemo(
      () =>
        createPollingStore<{
          users: MemberRow[]
          total: number
          refresh: MembershipRefresh
        }>({
          load: (signal) =>
            api(
              `/admin/membership/users?page=${page}&pageSize=20&username=${encodeURIComponent(query)}`,
              { signal },
            ),
          intervalSeconds: (d) => d.refresh.adminSeconds,
        }),
      [page, query],
    ),
    r = usePolling(store)
  return (
    <Card>
      <Input.Search
        aria-label="Search member"
        placeholder={L('searchUsername')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onSearch={(v) => {
          setPage(1)
          setQuery(v)
        }}
        style={{ maxWidth: 360, marginBottom: 16 }}
      />
      {r.error && <Alert type="error" message={r.error} />}
      <Table<MemberRow>
        rowKey="username"
        loading={r.loading}
        dataSource={r.data?.users ?? []}
        pagination={{
          current: page,
          pageSize: 20,
          total: r.data?.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        scroll={{ x: 800 }}
        columns={[
          { title: L('username'), dataIndex: 'username' },
          {
            title: L('planStatus'),
            render: (_, u) =>
              !u.managed
                ? L('legacy')
                : u.membership_disabled || u.chat_policy?.disabled
                  ? L('disabled')
                  : u.config
                    ? `${u.config.name} / ${u.config.nameEn} · v${u.revision}`
                    : L('expired'),
          },
          {
            title: L('expires'),
            render: (_, u) =>
              u.config
                ? u.ends_at
                  ? new Date(u.ends_at).toLocaleString()
                  : L('lifetime')
                : '—',
          },
          {
            title: L('usedDaily'),
            render: (_, u) => `${u.used} / ${u.config?.dailyLimit ?? '∞'}`,
          },
          {
            title: L('actions'),
            render: (_, u) => (
              <Button onClick={() => setSelected(u.username)}>
                {L('accessRenewDetails')}
              </Button>
            ),
          },
        ]}
      />
      {selected && (
        <MemberUserPanel
          username={selected}
          onClose={() => {
            setSelected(null)
            store.invalidate()
          }}
        />
      )}
    </Card>
  )
}
function MembershipStats() {
  const L = useMemberLabel(),
    store = useMemo(
      () =>
        createPollingStore<{
          stats: { managed: number; active: number; internalActive: number; received: string }
          refresh: MembershipRefresh
        }>({
          load: (signal) => api('/admin/membership/stats', { signal }),
          intervalSeconds: (d) => d.refresh.adminSeconds,
        }),
      [],
    ),
    r = usePolling(store)
  return (
    <Card>
      {r.error && <Alert type="error" message={r.error} />}
      <Space wrap>
        {L('managedMembers')}: {r.data?.stats?.managed ?? '—'} ·{' '}
        {L('activeMembers')}: {r.data?.stats?.active ?? '—'} ·{' '}
        {L('internalMembers')}: {r.data?.stats?.internalActive ?? '—'} ·{' '}
        {L('receivedTotalUsdt')}: {r.data?.stats?.received ?? '—'}
      </Space>
    </Card>
  )
}
export default function AdminMembershipPage() {
  const L = useMemberLabel(),
    discard = useConfirmDiscard(),
    [tab, setTab] = useState('plans')
  return (
    <div className={styles.stack}>
      <MembershipStats />
      <Tabs
        activeKey={tab}
        onChange={async (key) => {
          if (await discard()) setTab(key)
        }}
        destroyOnHidden
        items={[
          { key: 'plans', label: L('plans'), children: <Plans /> },
          { key: 'members', label: L('members'), children: <Members /> },
          {
            key: 'campaigns',
            label: L('introductoryOffer'),
            children: <Campaigns />,
          },
          {
            key: 'refresh',
            label: L('refreshSettings'),
            children: <RefreshSettings />,
          },
        ]}
      />
    </div>
  )
}
