import { Form, Select, Input, InputNumber, Checkbox, Space, Alert } from 'antd'
import { useTranslation } from 'react-i18next'
import type {
  MembershipGrantInput,
  MembershipPlanRecord,
} from 'biance-vision-brooks'
export function useMemberLabel() {
  const { t } = useTranslation('admin')
  return (key: string) => t(`membership.${key}`)
}
export function newGrant(): MembershipGrantInput {
  return {
    operationId: crypto.randomUUID(),
    versionId: '',
    action: 'bind',
    confirmReplace: false,
    useIntro: false,
    paidAmount: '0',
    paidAt: Date.now(),
    paymentReference: '',
    note: '',
  }
}
export function MembershipGrantFields({
  value,
  onChange,
  plans,
  managed = false,
}: {
  value: MembershipGrantInput
  onChange: (v: MembershipGrantInput) => void
  plans: MembershipPlanRecord[]
  managed?: boolean
}) {
  const L = useMemberLabel(),
    set = (patch: Partial<MembershipGrantInput>) =>
      onChange({ ...value, ...patch })
  const published = plans.filter((p) => p.enabled && p.publishedVersionId),
    selected = published.find((p) => p.publishedVersionId === value.versionId),
    config = selected?.versions.find((v) => v.id === value.versionId)?.config
  return (
    <>
      {managed && (
        <Form.Item label={L('action')}>
          <Select
            value={value.action}
            onChange={(action) =>
              set({ action, confirmReplace: false, useIntro: false })
            }
            options={[
              { value: 'renew', label: L('renewAfterCurrentPeriod') },
              { value: 'switch', label: L('switchMigrateVersionNow') },
            ]}
          />
        </Form.Item>
      )}
      <Form.Item label={L('publishedPlan')} required>
        <Select
          aria-label="Membership plan"
          value={value.versionId || undefined}
          placeholder={L('selectAPublishedPlan')}
          onChange={(versionId) => {
            const p = published.find((p) => p.publishedVersionId === versionId),
              v = p?.versions.find((v) => v.id === versionId)
            set({
              versionId,
              paidAmount: value.useIntro
                ? (v?.config.introPrice ?? '0')
                : (v?.config.price ?? '0'),
            })
          }}
          options={published.map((p) => ({
            value: p.publishedVersionId!,
            // internal 套餐加「（内部）」标记，防止运营误当正式套餐授予
            label: `${p.draft.name} / ${p.draft.nameEn} · v${p.versions.find((v) => v.id === p.publishedVersionId)?.revision}${p.id === 'internal' ? ` · ${L('internalPlanTag')}` : ''}`,
          }))}
        />
      </Form.Item>
      {!published.length && (
        <Alert
          type="warning"
          message={L('configureAiAndPublishAPlanInMembershipFirst')}
        />
      )}
      {config && (
        <Alert
          type="info"
          message={`${config.name} / ${config.nameEn} · ${L('daily')} ${config.dailyLimit ?? '∞'} · ${config.price} USDT · ${config.durationCount} ${config.durationUnit}`}
          description={`${L('chatAi')}: ${config.chatProfile} · ${L('researchAi')}: ${config.researchProfile}`}
        />
      )}
      {value.action !== 'renew' && (
        <Form.Item>
          <Checkbox
            checked={value.useIntro}
            onChange={(e) =>
              set({
                useIntro: e.target.checked,
                paidAmount: e.target.checked
                  ? (config?.introPrice ?? '0')
                  : (config?.price ?? '0'),
              })
            }
          >
            {L('firstPaymentIntroductoryPriceSubjectToAvailability')}
          </Checkbox>
        </Form.Item>
      )}
      <Space wrap align="start">
        <Form.Item label={L('receivedUsdt')} required>
          <Input
            aria-label="Paid amount"
            value={value.paidAmount}
            onChange={(e) => set({ paidAmount: e.target.value })}
            inputMode="decimal"
          />
        </Form.Item>
        <Form.Item label={L('paymentTime')}>
          <Input
            type="datetime-local"
            value={new Date(
              value.paidAt - new Date(value.paidAt).getTimezoneOffset() * 60000,
            )
              .toISOString()
              .slice(0, 16)}
            onChange={(e) => {
              const t = Date.parse(e.target.value)
              if (Number.isFinite(t)) set({ paidAt: t })
            }}
          />
        </Form.Item>
      </Space>
      <Form.Item label={L('paymentReference')}>
        <Input
          value={value.paymentReference}
          maxLength={200}
          onChange={(e) => set({ paymentReference: e.target.value })}
        />
      </Form.Item>
      <Form.Item label={L('noteRequiredWhenPaymentDiffersFromPrice')}>
        <Input.TextArea
          value={value.note}
          maxLength={1000}
          onChange={(e) => set({ note: e.target.value })}
        />
      </Form.Item>
      {value.action === 'switch' && (
        <Form.Item>
          <Checkbox
            checked={value.confirmReplace}
            onChange={(e) => set({ confirmReplace: e.target.checked })}
          >
            {L('replaceCurrentAndScheduledAccessWithoutAutomaticProration')}
          </Checkbox>
        </Form.Item>
      )}
    </>
  )
}
