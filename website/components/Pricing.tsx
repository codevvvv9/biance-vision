'use client'
import { useMemo, useSyncExternalStore } from 'react'
import { createPollingStore } from 'biance-vision-brooks/polling'
import type { PublicMembershipCatalog } from 'biance-vision-brooks/membership'
import { toTraditional } from '@/lib/zh-tw'
import { text, type Locale } from '@/lib/site'
export function Pricing({
  locale,
  initial,
}: {
  locale: Locale
  initial?: PublicMembershipCatalog
}) {
  const zh = locale !== 'en', // simplified OR traditional share the zh data branch; admin strings convert below
    store = useMemo(
      () =>
        createPollingStore<PublicMembershipCatalog>({
          load: async (signal) => {
            const response = await fetch('/api/public/membership-plans', {
              signal,
            })
            if (!response.ok) {
              const retryHeader = response.headers.get('retry-after')
              const retrySeconds = retryHeader
                ? /^\d+$/.test(retryHeader)
                  ? Number(retryHeader)
                  : Math.max(0, (Date.parse(retryHeader) - Date.now()) / 1000)
                : 0
              const e = Object.assign(
                new Error(
                  text(locale, 'Plans temporarily unavailable', '套餐暂不可用，请稍后重试', '套餐暫不可用，請稍後重試'),
                ),
                {
                  retryAfterSeconds: Number.isFinite(retrySeconds)
                    ? retrySeconds
                    : null,
                },
              )
              throw e
            }
            return response.json()
          },
          intervalSeconds: (d) => d.refreshSeconds,
          initial,
          initialUpdatedAt: initial?.serverTime,
        }),
      [zh, initial],
    ),
    { data, error, loading, updatedAt } = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    )
  return (
    <>
      <section className="container section">
        <div className="eyebrow">DuckStrat MEMBERSHIP</div>
        <h1>{text(locale, 'Choose your membership', '选择你的会员套餐', '選擇你的會員套餐')}</h1>
        <p>
          {text(locale, 'Access is enabled after manual payment confirmation. No automatic billing. Chat, research and translation share a daily interaction quota.', '人工确认收款后开通；不自动扣款。聊天、研究与翻译共用每日 AI 交互次数。', '人工確認收款後開通；不自動扣款。聊天、研究與翻譯共用每日 AI 互動次數。')}
        </p>
        {error && (
          <p role="status">
            {error}
            {updatedAt
              ? ` · ${text(locale, 'Last updated', '上次更新', '上次更新')} ${new Date(updatedAt).toLocaleTimeString()}`
              : ''}{' '}
            <button
              type="button"
              className="retry-link"
              onClick={() => void store.refresh(true)}
              disabled={loading}
            >
              {loading
                ? text(locale, 'Retrying…', '正在重试…', '正在重試…')
                : text(locale, 'Retry', '重试', '重試')}
            </button>
          </p>
        )}
        {!data && !error && (
          <p role="status">{text(locale, 'Loading plans…', '正在读取套餐…', '正在讀取套餐…')}</p>
        )}
        {data?.campaign && (
          <aside className="article-source">
            <strong>{locale === 'zh-TW' ? toTraditional(data.campaign.name) : data.campaign.name}</strong>
            <p>
              {text(locale, 'Claimed', '已开通', '已開通')} {data.campaign.used} /{' '}
              {data.campaign.capacity} · {text(locale, 'Remaining', '剩余名额', '剩餘名額')}{' '}
              {data.campaign.remaining}
            </p>
            <p>
              {text(locale, 'Introductory pricing applies to the first payment only. Renewals use the current regular price. Availability is confirmed when access is enabled.', '仅首次付费享内测价；续费采用届时正式价。以管理员确认开通时的剩余名额为准。', '僅首次付費享內測價；續費採用屆時正式價。以管理員確認開通時的剩餘名額為準。')}
            </p>
            {data.campaign.endsAt && (
              <p>
                {text(locale, 'Offer ends', '活动截止', '活動截止')}:{' '}
                {new Date(data.campaign.endsAt).toLocaleString()}
              </p>
            )}
          </aside>
        )}
        {data && !data.plans.length && (
          <p>
            {text(locale, 'Plans have not been published yet. Contact us to discuss access.', '套餐尚未发布，请联系管理员了解开通安排。', '套餐尚未釋出，請聯絡管理員瞭解開通安排。')}
          </p>
        )}
        <div className="pricing-grid">
          {data?.plans.map((p) => (
            <article className="contact-channel" key={p.versionId}>
              <h2>{zh ? (locale === 'zh-TW' ? toTraditional(p.name) : p.name) : p.nameEn}</h2>
              <p>{zh ? (locale === 'zh-TW' ? toTraditional(p.description) : p.description) : p.descriptionEn}</p>
              <p className="pricing-amount">
                {p.price} <span>USDT</span>
              </p>
              {data.campaign &&
                data.campaign.remaining > 0 &&
                Number(p.price) > 0 && (
                  <p>
                    {text(locale, 'First-payment offer', '首次内测价', '首次內測價')}:{' '}
                    <strong>{p.introPrice} USDT</strong>
                  </p>
                )}
              <p>
                {p.durationUnit === 'lifetime'
                  ? text(locale, 'Lifetime', '长期有效', '長期有效')
                  : `${p.durationCount} ${{ day: text(locale, 'days', '天', '天'), month: text(locale, 'calendar months', '自然月', '自然月'), year: text(locale, 'calendar years', '自然年', '自然年') }[p.durationUnit]}`}
              </p>
              <ul>
                <li>
                  {text(locale, 'Daily AI interactions', '每日 AI 交互', '每日 AI 互動')}:{' '}
                  {p.dailyLimit ?? (text(locale, 'Unlimited', '不限', '不限'))}
                </li>
                {p.features.chat && (
                  <li>{text(locale, 'AI conversation', 'AI 问答', 'AI 問答')}</li>
                )}
                {p.features.research && (
                  <li>{text(locale, 'Research reports', '研究报告', '研究報告')}</li>
                )}
                {p.features.translate && <li>{text(locale, 'Translation', '翻译', '翻譯')}</li>}
              </ul>
              <a
                className="button button-primary"
                href={`/${locale}/contact?plan=${encodeURIComponent(p.id)}`}
              >
                {text(locale, 'Contact us for access', '联系管理员开通', '聯絡管理員開通')}
              </a>
            </article>
          ))}
        </div>
        <p>
          {text(locale, 'Each accepted interaction counts once, including research submissions; internal model calls do not add charges. Market data and previous research remain accessible after expiry.', '研究按成功受理计次，内部多次模型调用不重复计次。到期后可继续查看行情与已有研究。', '研究按成功受理計次，內部多次模型呼叫不重複計次。到期後可繼續檢視行情與已有研究。')}
        </p>
      </section>
    </>
  )
}
