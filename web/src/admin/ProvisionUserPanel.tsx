import { useMemo, useState } from 'react'
import { Alert, Button, Form, Input, Space, Typography } from 'antd'
import {
  createPollingStore,
  type MembershipGrantInput,
  type MembershipPlanRecord,
  type MembershipRefresh,
  type MembershipStatus,
} from 'biance-vision-brooks'
import { api } from '../api'
import { usePolling } from '../membership/polling'
import { useDirtyForm, useConfirmDiscard } from './ui/forms'
import { Modal } from './ui/overlays'
import {
  MembershipGrantFields,
  newGrant,
  useMemberLabel,
} from './MembershipForms'
export function ProvisionUserPanel({
  onCreated,
}: {
  onCreated: () => void
}): JSX.Element {
  const L = useMemberLabel(),
    [open, setOpen] = useState(false)
  return (
    <>
      <Button type="primary" onClick={() => setOpen(true)}>
        {L('createUserAndAiAccess')}
      </Button>
      {open && (
        <ProvisionDialog onCreated={onCreated} onClose={() => setOpen(false)} />
      )}
    </>
  )
}
type Delivery = {
  username: string
  password: string
  publicOrigin: string | null
  loginPath: string
  membership: MembershipStatus
}
function ProvisionDialog({
  onCreated,
  onClose,
}: {
  onCreated: () => void
  onClose: () => void
}): JSX.Element {
  const L = useMemberLabel(),
    discard = useConfirmDiscard(),
    [username, setUsername] = useState(''),
    [value, setValue] = useState<MembershipGrantInput>(newGrant),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [delivery, setDelivery] = useState<Delivery | null>(null),
    [copied, setCopied] = useState(false),
    [dirty, setDirty] = useState(false)
  const store = useMemo(
      () =>
        createPollingStore<{
          plans: MembershipPlanRecord[]
          refresh: MembershipRefresh
        }>({
          load: (signal) => api('/admin/membership/plans', { signal }),
          intervalSeconds: (d) => d.refresh.adminSeconds,
        }),
      [],
    ),
    r = usePolling(store)
  useDirtyForm(dirty || !!delivery)
  const close = async () => {
    if (!busy && (await discard(dirty || !!delivery))) onClose()
  }
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const d = await api<Delivery>('/admin/users/provision', {
        method: 'POST',
        body: {
          ...value,
          ...(username.trim() ? { username: username.trim() } : {}),
        },
      })
      setDelivery(d)
      setDirty(false)
      onCreated()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={L('createAccountWithMembership')}
      footer={null}
      onCancel={() => void close()}
      width={720}
      closable={!busy}
      maskClosable={!busy}
    >
      {(error || r.error) && <Alert type="error" message={error || r.error} />}
      {delivery ? (
        <div role="status">
          <Typography.Paragraph>
            {L('passwordIsDisplayedOnlyHereCopyItBeforeClosing')}
          </Typography.Paragraph>
          <Form layout="vertical">
            <Form.Item label={L('username2')}>
              <Input
                aria-label={L('username2')}
                readOnly
                value={delivery.username}
              />
            </Form.Item>
            <Form.Item label={L('password')}>
              <Input.Password
                aria-label={L('password')}
                readOnly
                autoComplete="off"
                value={delivery.password}
              />
            </Form.Item>
          </Form>
          <p>
            {delivery.membership.current?.name} /{' '}
            {delivery.membership.current?.nameEn} ·{' '}
            {delivery.membership.current?.endsAt
              ? new Date(delivery.membership.current.endsAt).toLocaleString()
              : L('lifetime')}
          </p>
          <Space>
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    `Biance Vision\n${L('login')}: ${delivery.publicOrigin ?? ''}${delivery.loginPath}\n${L('username2')}: ${delivery.username}\n${L('password')}: ${delivery.password}\n${L('plan')}: ${delivery.membership.current?.name} / ${delivery.membership.current?.nameEn}\n${L('expires')}: ${delivery.membership.current?.endsAt ? new Date(delivery.membership.current.endsAt).toLocaleString() : L('lifetime')}`,
                  )
                  setCopied(true)
                } catch {
                  setError(L('copyFailedSelectAndCopyManually'))
                }
              }}
            >
              {copied ? L('copied') : L('copyDelivery')}
            </Button>
            <Button
              type="primary"
              onClick={() => {
                setDelivery(null)
                onClose()
              }}
            >
              {L('clearAndClose')}
            </Button>
          </Space>
        </div>
      ) : (
        <Form layout="vertical" onFinish={() => void submit()}>
          <Form.Item label={L('usernameOptional')}>
            <Input
              value={username}
              autoComplete="off"
              maxLength={32}
              onChange={(e) => {
                setUsername(e.target.value)
                setDirty(true)
              }}
            />
          </Form.Item>
          <MembershipGrantFields
            value={value}
            onChange={(v) => {
              setValue(v)
              setDirty(true)
            }}
            plans={r.data?.plans ?? []}
          />
          <Alert
            type="info"
            message={L(
              'accountAccessPaymentAndIntroductorySlotAreSavedAtomically',
            )}
          />
          <Button
            style={{ marginTop: 16 }}
            type="primary"
            htmlType="submit"
            loading={busy}
            disabled={!value.versionId}
          >
            {L('createAndDeliver')}
          </Button>
        </Form>
      )}
    </Modal>
  )
}
