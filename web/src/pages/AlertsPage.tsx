import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import { useMarket } from '../market/MarketContext'
import { fmtDateTime, fmtPct, fmtPrice } from '../utils'
import type { AlertRule, RuleType, Settings } from '../types'

const TYPE_KEYS: Record<RuleType, string> = {
  price_above: 'alerts:type.price_above',
  price_below: 'alerts:type.price_below',
  change_above: 'alerts:type.change_above',
  change_below: 'alerts:type.change_below',
}

interface FormState {
  symbol: string
  type: RuleType
  value: string
  note: string
}

/** 平台绑定指引：文案存于 alerts 词典（guides.<key>.*），sample 为 URL 无需翻译 */
const PUSH_GUIDES: { key: string; chipClass: string; sample: string }[] = [
  { key: 'ftqq', chipClass: 'chip-green', sample: 'https://sctapi.ftqq.com/SCTxxxxxxxxxxxx.send' },
  { key: 'wecom', chipClass: 'chip-blue', sample: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx' },
  { key: 'feishu', chipClass: 'chip-purple', sample: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx' },
]

export default function AlertsPage(): JSX.Element {
  const { t } = useTranslation()
  const [sp] = useSearchParams()
  const { alertsHistory, order, pushToast } = useMarket()

  const condText = (r: { type: RuleType; value: number }): string =>
    `${t(TYPE_KEYS[r.type])} ${r.type.startsWith('price_') ? fmtPrice(r.value) : `${r.value}%`}`

  const [rules, setRules] = useState<AlertRule[] | null>(null)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [helpOpen, setHelpOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<FormState>(() => ({
    symbol: sp.get('symbol') || 'BTCUSDT',
    type: 'price_above',
    value: '',
    note: '',
  }))

  const load = useCallback((): void => {
    void api<{ rules: AlertRule[] }>('/alerts')
      .then((d) => setRules(d.rules))
      .catch((e: Error) => pushToast({ kind: 'info', title: t('alerts:toast.loadFailed'), body: e.message }))
    void api<{ settings: Settings }>('/settings')
      .then((d) => setWebhookUrl(d.settings.webhookUrl || ''))
      .catch(() => {})
  }, [pushToast, t])

  useEffect(load, [load])

  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    setBusy(true)
    api<{ rule: AlertRule }>('/alerts', {
      method: 'POST',
      body: { symbol: form.symbol, type: form.type, value: form.value, note: form.note },
    })
      .then(() => {
        pushToast({
          kind: 'info',
          title: t('alerts:toast.added'),
          body: `${form.symbol} ${t(TYPE_KEYS[form.type])} ${form.value}`,
        })
        setForm((f) => ({ ...f, value: '', note: '' }))
        load()
      })
      .catch((err: Error) => {
        pushToast({ kind: 'info', title: t('alerts:toast.addFailed'), body: err.message })
      })
      .finally(() => setBusy(false))
  }

  const toggleRule = (r: AlertRule): void => {
    api<{ rule: AlertRule }>(`/alerts/${r.id}`, { method: 'PUT', body: { enabled: !r.enabled } })
      .then(load)
      .catch((e: Error) => pushToast({ kind: 'info', title: t('alerts:toast.toggleFailed'), body: e.message }))
  }

  const removeRuleOf = (r: AlertRule): void => {
    api<{ ok: boolean }>(`/alerts/${r.id}`, { method: 'DELETE' })
      .then(load)
      .catch((e: Error) => pushToast({ kind: 'info', title: t('alerts:toast.deleteFailed'), body: e.message }))
  }

  const saveWebhook = (): void => {
    api<{ settings: Settings }>('/settings', { method: 'PUT', body: { webhookUrl } })
      .then(() => {
        pushToast({ kind: 'info', title: t('alerts:toast.saved'), body: webhookUrl || t('alerts:toast.cleared') })
      })
      .catch((e: Error) => pushToast({ kind: 'info', title: t('alerts:toast.saveFailed'), body: e.message }))
  }

  const testPush = (): void => {
    api<{ ok: boolean }>('/settings/test', { method: 'POST' }).catch((e: Error) => {
      pushToast({ kind: 'info', title: t('alerts:toast.testFailed'), body: e.message })
    })
  }

  useEffect(() => {
    if (!helpOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setHelpOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [helpOpen])

  return (
    <div className="page">
      <div className="alerts-grid">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">
              <i className="title-glyph" />
              {t('alerts:rules.title')}
            </h2>
          </div>

          <form className="alert-form" onSubmit={submit}>
            <div className="form-row">
              <label>
                <span>{t('alerts:form.symbol')}</span>
                <input
                  list="symbol-list"
                  value={form.symbol}
                  onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value.toUpperCase() }))}
                  placeholder="BTCUSDT"
                  spellCheck={false}
                  required
                />
                <datalist id="symbol-list">
                  {order.slice(0, 60).map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </label>
              <label>
                <span>{t('alerts:form.cond')}</span>
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as RuleType }))}
                >
                  {(Object.keys(TYPE_KEYS) as RuleType[]).map((v) => (
                    <option key={v} value={v}>
                      {t(TYPE_KEYS[v])}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{form.type.startsWith('price_') ? t('alerts:form.targetPrice') : t('alerts:form.threshold')}</span>
                <input
                  type="number"
                  step="any"
                  value={form.value}
                  onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                  placeholder={form.type.startsWith('price_') ? '65000' : '3.2'}
                  required
                />
              </label>
            </div>
            <div className="form-row">
              <label className="grow">
                <span>{t('alerts:form.note')}</span>
                <input
                  value={form.note}
                  onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                  placeholder={t('alerts:form.notePlaceholder')}
                  maxLength={80}
                />
              </label>
              <button className="btn btn-primary" disabled={busy} type="submit">
                {busy ? t('alerts:form.busy') : t('alerts:form.submit')}
              </button>
            </div>
            <p className="form-hint muted">{t('alerts:form.hint')}</p>
          </form>

          <div className="table-wrap rules-table">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-sym">{t('alerts:rules.col.symbol')}</th>
                  <th>{t('alerts:rules.col.cond')}</th>
                  <th>{t('alerts:rules.col.note')}</th>
                  <th>{t('alerts:rules.col.status')}</th>
                  <th>{t('alerts:rules.col.lastTriggered')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(rules ?? []).map((r) => (
                  <tr key={r.id} className={!r.enabled ? 'disabled-row' : ''}>
                    <td className="col-sym">
                      <b>{r.symbol.replace('USDT', '')}</b>
                      <em>/USDT</em>
                    </td>
                    <td className="mono">{condText(r)}</td>
                    <td className="dim note-cell">{r.note || '—'}</td>
                    <td>
                      <button
                        className={`switch ${r.enabled ? 'on' : ''}`}
                        onClick={() => toggleRule(r)}
                        title={r.enabled ? t('alerts:rules.switchOn') : t('alerts:rules.switchOff')}
                      >
                        <i />
                      </button>
                    </td>
                    <td className="mono dim">
                      {r.lastTriggeredAt ? fmtDateTime(r.lastTriggeredAt) : '—'}
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm danger" onClick={() => removeRuleOf(r)}>
                        {t('alerts:rules.remove')}
                      </button>
                    </td>
                  </tr>
                ))}
                {rules?.length === 0 && (
                  <tr className="empty-row">
                    <td colSpan={6}>{t('alerts:rules.empty')}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <div className="alerts-side">
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">
                <i className="title-glyph amber" />
                {t('alerts:history.title')}
              </h2>
            </div>
            <div className="history-list">
              {alertsHistory.length === 0 && <div className="empty-tip">{t('alerts:history.empty')}</div>}
              {alertsHistory.map((a) => (
                <div className={`ra-item ${a.test ? 'test' : ''}`} key={a.id}>
                  <i className={`ra-dot ${a.test || a.changePct >= 0 ? 'up' : 'down'}`} />
                  <div className="ra-main">
                    <div className="ra-msg">{a.message}</div>
                    <div className="ra-time muted">
                      {fmtDateTime(a.triggeredAt)}
                      {!a.test && (
                        <>
                          {' · '}{t('alerts:history.nowPrice')} <span className="mono">{fmtPrice(a.price)}</span>
                          {' · '}
                          <span className={a.changePct >= 0 ? 'up' : 'down'}>{fmtPct(a.changePct)}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">
                <i className="title-glyph teal" />
                {t('alerts:webhook.title')}
              </h2>
            </div>
            <div className="webhook-box">
              <p className="muted webhook-desc">
                {t('alerts:webhook.desc', { payload: '{ event: "alert.fired", data: {...} }' })}
                <button
                  className="help-dot"
                  onClick={() => setHelpOpen(true)}
                  title={t('alerts:webhook.help')}
                  aria-label={t('alerts:webhook.help')}
                >
                  !
                </button>
              </p>
              <div className="form-row">
                <input
                  className="grow mono"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  placeholder="https://example.com/webhook"
                  spellCheck={false}
                />
                <button className="btn btn-ghost" onClick={saveWebhook}>
                  {t('alerts:webhook.save')}
                </button>
                <button className="btn btn-primary" onClick={testPush}>
                  {t('alerts:webhook.test')}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>

      {helpOpen && (
        <div className="modal-overlay" onClick={() => setHelpOpen(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('alerts:help.title')}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h3>
                <i className="title-glyph teal" />
                {t('alerts:help.title')}
              </h3>
              <button className="modal-close" onClick={() => setHelpOpen(false)} aria-label={t('alerts:help.close')}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              {PUSH_GUIDES.map((g) => (
                <section className="guide-item" key={g.key}>
                  <h4>
                    <span className={`chip ${g.chipClass}`}>{t(`alerts:guides.${g.key}.chip`)}</span>
                    {t(`alerts:guides.${g.key}.name`)}
                    {t(`alerts:guides.${g.key}.badge`) !== '' && (
                      <span className="guide-badge">{t(`alerts:guides.${g.key}.badge`)}</span>
                    )}
                  </h4>
                  <ol>
                    {(t(`alerts:guides.${g.key}.steps`, { returnObjects: true }) as string[]).map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                  <p className="guide-sample">
                    {t('alerts:help.sample')}<code className="mono">{g.sample}</code>
                  </p>
                </section>
              ))}
              <section className="guide-item">
                <h4>
                  <span className="chip chip-cyan">{t('alerts:help.custom.chip')}</span>{t('alerts:help.custom.name')}
                </h4>
                <ol>
                  {(t('alerts:help.custom.steps', { returnObjects: true }) as string[]).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
