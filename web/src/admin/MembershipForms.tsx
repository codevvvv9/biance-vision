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
/** 金额格式契约（与服务端 zod 一致）：1-8 位整数，可选 1-6 位小数 */
export const AMOUNT_RE = /^\d{1,8}(\.\d{1,6})?$/
/** 与服务端 micros() 等价的金额相等判定：去小数尾零后字符串比较 */
export function sameAmount(a: string, b: string): boolean {
  const norm = (s: string) => {
    const m = /^(\d+)(?:\.(\d*))?$/.exec(s.trim())
    return m ? `${m[1]}.${(m[2] ?? '').replace(/0+$/, '')}` : null
  }
  const x = norm(a),
    y = norm(b)
  return x !== null && y !== null && x === y
}
export type GrantFieldErrors = Partial<
  Record<'versionId' | 'paidAmount' | 'note', string>
>
/** 授予表单提交前校验（规则对应服务端契约），返回待翻译的词典 key；
 * 空对象 = 可提交。versionId 必选；实收须为金额格式；实收与套餐价
 * 不一致时备注必填（useIntro 生效时预期价为优惠价）。 */
export function grantFieldErrors(
  value: MembershipGrantInput,
  plans: MembershipPlanRecord[],
): GrantFieldErrors {
  const e: GrantFieldErrors = {},
    published = plans.filter((p) => p.enabled && p.publishedVersionId),
    config = published
      .find((p) => p.publishedVersionId === value.versionId)
      ?.versions.find((v) => v.id === value.versionId)?.config
  if (!value.versionId) e.versionId = 'planRequired'
  if (!AMOUNT_RE.test(value.paidAmount)) e.paidAmount = 'amountFormat'
  const expected = value.useIntro ? config?.introPrice : config?.price
  if (
    config &&
    expected !== undefined &&
    !sameAmount(expected, value.paidAmount) &&
    !value.note.trim()
  )
    e.note = 'noteRequiredOnMismatch'
  return e
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
  submitted = false,
}: {
  value: MembershipGrantInput
  onChange: (v: MembershipGrantInput) => void
  plans: MembershipPlanRecord[]
  managed?: boolean
  /** 首次提交后置 true：字段错误文案随填写实时消隐，避免一打开就满屏红 */
  submitted?: boolean
}) {
  const L = useMemberLabel(),
    set = (patch: Partial<MembershipGrantInput>) =>
      onChange({ ...value, ...patch })
  const published = plans.filter((p) => p.enabled && p.publishedVersionId),
    selected = published.find((p) => p.publishedVersionId === value.versionId),
    config = selected?.versions.find((v) => v.id === value.versionId)?.config,
    err = submitted ? grantFieldErrors(value, plans) : {},
    fieldProps = (k: keyof GrantFieldErrors) =>
      err[k]
        ? { validateStatus: 'error' as const, help: L(err[k]!) }
        : {},
    /** 实收与预期价不一致 → 备注变为必填，红星即时提示（不必等提交） */
    noteRequired =
      !!config &&
      !sameAmount(
        value.useIntro ? config.introPrice : config.price,
        value.paidAmount,
      )
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
      <Form.Item label={L('publishedPlan')} required {...fieldProps('versionId')}>
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
        <Form.Item
          label={L('receivedUsdt')}
          required
          {...fieldProps('paidAmount')}
        >
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
      <Form.Item
        label={L('noteRequiredWhenPaymentDiffersFromPrice')}
        required={noteRequired}
        {...fieldProps('note')}
      >
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
