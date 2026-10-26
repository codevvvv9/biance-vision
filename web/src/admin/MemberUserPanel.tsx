import { useMemo, useState } from 'react'
import { App, Alert, Button, Form, Input, Space, Table, Typography } from 'antd'
import {
  createPollingStore,
  type MembershipStatus,
  type MembershipPlanRecord,
  type MembershipGrantInput,
} from 'biance-vision-brooks'
import { api } from '../api'
import { usePolling } from '../membership/polling'
import { Modal, overlayContainer } from './ui/overlays'
import { useDirtyForm, useConfirmDiscard } from './ui/forms'
import {
  MembershipGrantFields,
  newGrant,
  useMemberLabel,
} from './MembershipForms'
type Receipt = {
  id: string
  action: string
  expected_amount: string
  paid_amount: string
  currency: string
  paid_at: string
  payment_reference: string
  note: string
  voided_at: string | null
}
type Detail = {
  membership: MembershipStatus
  receipts: Receipt[]
  history: {
    id: string
    starts_at: string
    ends_at: string | null
    revoked_at: string | null
    config: { name: string }
    revision: number
  }[]
}
export function MemberUserPanel({
  username,
  onClose,
}: {
  username: string
  onClose: () => void
}) {
  const L = useMemberLabel(),
    discard = useConfirmDiscard(),
    { modal } = App.useApp()
  const store = useMemo(
    () =>
      createPollingStore<Detail>({
        load: (signal) =>
          api(`/admin/users/${encodeURIComponent(username)}/membership`, {
            signal,
          }),
        intervalSeconds: (d) => d.membership.refresh.adminSeconds ?? 60,
      }),
    [username],
  )
  const plansStore = useMemo(
    () =>
      createPollingStore<{
        plans: MembershipPlanRecord[]
        refresh: { adminSeconds: number }
      }>({
        load: (signal) => api('/admin/membership/plans', { signal }),
        intervalSeconds: (d) => d.refresh.adminSeconds,
      }),
    [],
  )
  const detail = usePolling(store),
    plans = usePolling(plansStore),
    [input, setInput] = useState<MembershipGrantInput>(newGrant),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reason, setReason] = useState('')
  useDirtyForm(dirty)
  const s = detail.data?.membership
  const close = async () => {
    if (!busy && (await discard(dirty))) onClose()
  }
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await fn()
      setDirty(false)
      setInput({ ...newGrant(), action: s?.managed ? 'renew' : 'migrate' })
      store.invalidate()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const value = {
    ...input,
    action: dirty
      ? input.action
      : s?.managed
        ? ('renew' as const)
        : ('migrate' as const),
  }
  return (
    <Modal
      open
      title={`${username} · ${L('membership')}`}
      onCancel={() => void close()}
      footer={null}
      width={860}
      closable={!busy}
      maskClosable={!busy}
    >
      {(error || detail.error || plans.error) && (
        <Alert type="error" message={error || detail.error || plans.error} />
      )}
      {s && (
        <>
          <Typography.Paragraph>
            {s.current?.name ?? L('legacyNoActivePlan')} · {s.status} ·{' '}
            {L('usedToday')} {s.usedToday} / {s.current?.dailyLimit ?? '∞'}
          </Typography.Paragraph>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={[...(s.current ? [s.current] : []), ...s.upcoming]}
            columns={[
              {
                title: L('currentScheduled'),
                render: (_, p) => `${p.name} · v${p.revision}`,
              },
              {
                title: L('starts'),
                render: (_, p) => new Date(p.startsAt).toLocaleString(),
              },
              {
                title: L('ends'),
                render: (_, p) =>
                  p.endsAt
                    ? new Date(p.endsAt).toLocaleString()
                    : L('lifetime'),
              },
            ]}
          />
          <Form
            layout="vertical"
            onFinish={() =>
              void run(() =>
                api(`/admin/users/${encodeURIComponent(username)}/membership`, {
                  method: 'POST',
                  body: value,
                }),
              )
            }
          >
            <MembershipGrantFields
              value={value}
              onChange={(v) => {
                setDirty(true)
                setInput(v)
              }}
              plans={plans.data?.plans ?? []}
              managed={s.managed}
            />
            <Button
              type="primary"
              htmlType="submit"
              loading={busy}
              disabled={
                !value.versionId ||
                (value.action === 'switch' && !value.confirmReplace)
              }
            >
              {L('saveMembershipAccess')}
            </Button>
          </Form>
          {s.managed && (
            <Space style={{ marginTop: 16 }}>
              <Input
                aria-label="Membership status reason"
                placeholder={L('reasonForDisablingRestoring')}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <Button
                danger={s.status !== 'disabled'}
                disabled={busy || !reason.trim()}
                onClick={() =>
                  void run(() =>
                    api(
                      `/admin/users/${encodeURIComponent(username)}/membership`,
                      {
                        method: 'PATCH',
                        body: {
                          disabled: s.status !== 'disabled',
                          note: reason,
                        },
                      },
                    ),
                  )
                }
              >
                {s.status === 'disabled' ? L('restore') : L('disableAi')}
              </Button>
            </Space>
          )}
          <Typography.Title level={5}>
            {L('paymentsRenewalsLatest50')}
          </Typography.Title>
          <Table<Receipt>
            size="small"
            rowKey="id"
            scroll={{ x: 720 }}
            dataSource={detail.data?.receipts ?? []}
            columns={[
              { title: L('action'), dataIndex: 'action' },
              {
                title: L('receivedExpected'),
                render: (_, r) => `${r.paid_amount} / ${r.expected_amount}`,
              },
              {
                title: L('paid'),
                render: (_, r) => new Date(r.paid_at).toLocaleString(),
              },
              {
                title: L('referenceNote'),
                render: (_, r) => `${r.payment_reference} ${r.note}`,
              },
              {
                title: L('correction'),
                render: (_, r) =>
                  r.voided_at ? (
                    L('voided')
                  ) : (
                    <Button
                      size="small"
                      danger
                      disabled={busy}
                      onClick={async () => {
                        let note = ''
                        const ok = await modal.confirm({
                          getContainer: overlayContainer,
                          title: L(
                            'voidPaymentAndAccessIntroductorySlotIsRetained',
                          ),
                          content: (
                            <Input.TextArea
                              placeholder={L('correctionReason')}
                              onChange={(e) => {
                                note = e.target.value
                              }}
                            />
                          ),
                        })
                        if (ok && note.trim())
                          void run(() =>
                            api(`/admin/membership/receipts/${r.id}/void`, {
                              method: 'POST',
                              body: { reason: note },
                            }),
                          )
                      }}
                    >
                      {L('void')}
                    </Button>
                  ),
              },
            ]}
          />
          <Typography.Title level={5}>
            {L('accessHistoryLatest50')}
          </Typography.Title>
          <Table
            size="small"
            rowKey="id"
            dataSource={detail.data?.history ?? []}
            columns={[
              {
                title: L('plan'),
                render: (_, r) => `${r.config.name} · v${r.revision}`,
              },
              { title: L('starts'), dataIndex: 'starts_at' },
              {
                title: L('ends'),
                render: (_, r) => r.ends_at ?? L('lifetime'),
              },
              { title: L('revoked'), render: (_, r) => r.revoked_at ?? '—' },
            ]}
          />
        </>
      )}
    </Modal>
  )
}
