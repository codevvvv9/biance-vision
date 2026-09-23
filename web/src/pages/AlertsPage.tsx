import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useMarket } from '../market/MarketContext'
import { fmtDateTime, fmtPct, fmtPrice } from '../utils'
import type { AlertRule, RuleType, Settings } from '../types'

const TYPE_LABEL: Record<RuleType, string> = {
  price_above: '价格突破',
  price_below: '价格跌破',
  change_above: '24h涨幅超过',
  change_below: '24h跌幅超过',
}

const condText = (r: { type: RuleType; value: number }): string =>
  `${TYPE_LABEL[r.type]} ${r.type.startsWith('price_') ? fmtPrice(r.value) : `${r.value}%`}`

interface FormState {
  symbol: string
  type: RuleType
  value: string
  note: string
}

interface PushGuide {
  key: string
  name: string
  chip: string
  chipClass: string
  badge?: string
  steps: string[]
  sample: string
}

const PUSH_GUIDES: PushGuide[] = [
  {
    key: 'ftqq',
    name: 'Server酱',
    chip: '微信',
    chipClass: 'chip-green',
    badge: '推荐',
    steps: [
      '打开 sct.ftqq.com，用微信扫码登录',
      '进入「SendKey」页面，复制你的 Key',
      '把 https://sctapi.ftqq.com/你的Key.send 填入上方输入框，点「保存」',
      '点「测试推送」，微信里的「方糖」服务号会收到一条测试消息',
    ],
    sample: 'https://sctapi.ftqq.com/SCTxxxxxxxxxxxx.send',
  },
  {
    key: 'wecom',
    name: '企业微信群机器人',
    chip: '企微',
    chipClass: 'chip-blue',
    steps: [
      '在企业微信目标群里：右键群名 → 添加群机器人 → 新建，随意命名',
      '复制生成的 Webhook 地址',
      '填入上方输入框，点「保存」',
      '点「测试推送」，群里会收到一条预警测试消息',
    ],
    sample: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx',
  },
  {
    key: 'feishu',
    name: '飞书自定义机器人',
    chip: '飞书',
    chipClass: 'chip-purple',
    steps: [
      '飞书目标群 → 设置 → 群机器人 → 添加「自定义机器人」',
      '安全设置选「自定义关键词」，填「预警」',
      '复制生成的 Webhook 地址，填入上方输入框并「保存」',
      '点「测试推送」，群里会收到一条预警测试消息',
    ],
    sample: 'https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx',
  },
]

export default function AlertsPage(): JSX.Element {
  const [sp] = useSearchParams()
  const { alertsHistory, order, pushToast } = useMarket()

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
      .catch((e: Error) => pushToast({ kind: 'info', title: '规则加载失败', body: e.message }))
    void api<{ settings: Settings }>('/settings')
      .then((d) => setWebhookUrl(d.settings.webhookUrl || ''))
      .catch(() => {})
  }, [pushToast])

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
          title: '规则已添加',
          body: `${form.symbol} ${TYPE_LABEL[form.type]} ${form.value}`,
        })
        setForm((f) => ({ ...f, value: '', note: '' }))
        load()
      })
      .catch((err: Error) => {
        pushToast({ kind: 'info', title: '添加失败', body: err.message })
      })
      .finally(() => setBusy(false))
  }

  const toggleRule = (r: AlertRule): void => {
    api<{ rule: AlertRule }>(`/alerts/${r.id}`, { method: 'PUT', body: { enabled: !r.enabled } })
      .then(load)
      .catch((e: Error) => pushToast({ kind: 'info', title: '操作失败', body: e.message }))
  }

  const removeRuleOf = (r: AlertRule): void => {
    api<{ ok: boolean }>(`/alerts/${r.id}`, { method: 'DELETE' })
      .then(load)
      .catch((e: Error) => pushToast({ kind: 'info', title: '删除失败', body: e.message }))
  }

  const saveWebhook = (): void => {
    api<{ settings: Settings }>('/settings', { method: 'PUT', body: { webhookUrl } })
      .then(() => {
        pushToast({ kind: 'info', title: '推送接口已保存', body: webhookUrl || '已清空 Webhook' })
      })
      .catch((e: Error) => pushToast({ kind: 'info', title: '保存失败', body: e.message }))
  }

  const testPush = (): void => {
    api<{ ok: boolean }>('/settings/test', { method: 'POST' }).catch((e: Error) => {
      pushToast({ kind: 'info', title: '测试发送失败', body: e.message })
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
              预警规则
            </h2>
          </div>

          <form className="alert-form" onSubmit={submit}>
            <div className="form-row">
              <label>
                <span>交易对</span>
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
                <span>条件</span>
                <select
                  value={form.type}
                  onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as RuleType }))}
                >
                  {(Object.entries(TYPE_LABEL) as [RuleType, string][]).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{form.type.startsWith('price_') ? '目标价' : '阈值 (%)'}</span>
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
                <span>备注（可选）</span>
                <input
                  value={form.note}
                  onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
                  placeholder="例如：突破压力位，关注回踩"
                  maxLength={80}
                />
              </label>
              <button className="btn btn-primary" disabled={busy} type="submit">
                {busy ? '添加中…' : '+ 添加规则'}
              </button>
            </div>
            <p className="form-hint muted">
              价格类规则按「突破 / 跌破」边缘触发：创建时若价格已在目标位另一侧，需回落复位后再次突破才会提醒；
              涨跌幅类规则在超过阈值时立即提醒一次，回落低于阈值后可再次触发。
            </p>
          </form>

          <div className="table-wrap rules-table">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-sym">交易对</th>
                  <th>条件</th>
                  <th>备注</th>
                  <th>状态</th>
                  <th>最近触发</th>
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
                        title={r.enabled ? '点击停用' : '点击启用'}
                      >
                        <i />
                      </button>
                    </td>
                    <td className="mono dim">
                      {r.lastTriggeredAt ? fmtDateTime(r.lastTriggeredAt) : '—'}
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm danger" onClick={() => removeRuleOf(r)}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
                {rules?.length === 0 && (
                  <tr className="empty-row">
                    <td colSpan={6}>还没有预警规则，用上方表单添加第一条</td>
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
                触发历史
              </h2>
            </div>
            <div className="history-list">
              {alertsHistory.length === 0 && <div className="empty-tip">暂无触发记录</div>}
              {alertsHistory.map((a) => (
                <div className={`ra-item ${a.test ? 'test' : ''}`} key={a.id}>
                  <i className={`ra-dot ${a.test || a.changePct >= 0 ? 'up' : 'down'}`} />
                  <div className="ra-main">
                    <div className="ra-msg">{a.message}</div>
                    <div className="ra-time muted">
                      {fmtDateTime(a.triggeredAt)}
                      {!a.test && (
                        <>
                          {' · '}现价 <span className="mono">{fmtPrice(a.price)}</span>
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
                实时推送接口
              </h2>
            </div>
            <div className="webhook-box">
              <p className="muted webhook-desc">
                触发预警时，除页面弹窗 + 系统通知 + 提示音外，服务端还会向该 Webhook 地址
                POST 一条 JSON，自动适配 Server 酱 / 企业微信 / 飞书机器人格式（自定义地址为{' '}
                <code>{`{ event: "alert.fired", data: {...} }`}</code>），实现手机推送。
                <button
                  className="help-dot"
                  onClick={() => setHelpOpen(true)}
                  title="查看各平台绑定步骤"
                  aria-label="查看各平台绑定步骤"
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
                  保存
                </button>
                <button className="btn btn-primary" onClick={testPush}>
                  测试推送
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
            aria-label="Webhook 推送绑定步骤"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h3>
                <i className="title-glyph teal" />
                Webhook 推送绑定步骤
              </h3>
              <button className="modal-close" onClick={() => setHelpOpen(false)} aria-label="关闭">
                ✕
              </button>
            </div>
            <div className="modal-body">
              {PUSH_GUIDES.map((g) => (
                <section className="guide-item" key={g.key}>
                  <h4>
                    <span className={`chip ${g.chipClass}`}>{g.chip}</span>
                    {g.name}
                    {g.badge && <span className="guide-badge">{g.badge}</span>}
                  </h4>
                  <ol>
                    {g.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                  <p className="guide-sample">
                    地址示例：<code className="mono">{g.sample}</code>
                  </p>
                </section>
              ))}
              <section className="guide-item">
                <h4>
                  <span className="chip chip-cyan">自定义</span>自己的服务
                </h4>
                <ol>
                  <li>
                    填入任意可公网访问的 http(s) 地址，服务端会 POST{' '}
                    <code>{`{ event: "alert.fired", data: {...} }`}</code>，JSON 格式，超时 5 秒
                  </li>
                </ol>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
