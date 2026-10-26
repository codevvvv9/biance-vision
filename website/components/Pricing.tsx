'use client'
import { useMemo, useSyncExternalStore } from 'react'
import { createPollingStore } from 'biance-vision-brooks/polling'
import type { PublicMembershipCatalog } from 'biance-vision-brooks/membership'
import type { Locale } from '@/lib/site'
export function Pricing({
  locale,
  initial,
}: {
  locale: Locale
  initial?: PublicMembershipCatalog
}) {
  const zh = locale === 'zh',
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
                  zh
                    ? '套餐暂不可用，请稍后重试'
                    : 'Plans temporarily unavailable',
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
    { data, error, updatedAt } = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    )
  return (
    <>
      <section className="container section">
        <div className="eyebrow">DuckStrat MEMBERSHIP</div>
        <h1>{zh ? '选择你的会员套餐' : 'Choose your membership'}</h1>
        <p>
          {zh
            ? '人工确认收款后开通；不自动扣款。聊天、研究与翻译共用每日 AI 交互次数。'
            : 'Access is enabled after manual payment confirmation. No automatic billing. Chat, research and translation share a daily interaction quota.'}
        </p>
        {error && (
          <p role="status">
            {error}
            {updatedAt
              ? ` · ${zh ? '上次更新' : 'Last updated'} ${new Date(updatedAt).toLocaleTimeString()}`
              : ''}{' '}
            <button
              className="button button-outline"
              onClick={() => void store.refresh()}
            >
              {zh ? '重试' : 'Retry'}
            </button>
          </p>
        )}
        {!data && !error && (
          <p role="status">{zh ? '正在读取套餐…' : 'Loading plans…'}</p>
        )}
        {data?.campaign && (
          <aside className="article-source">
            <strong>{data.campaign.name}</strong>
            <p>
              {zh ? '已开通' : 'Claimed'} {data.campaign.used} /{' '}
              {data.campaign.capacity} · {zh ? '剩余名额' : 'Remaining'}{' '}
              {data.campaign.remaining}
            </p>
            <p>
              {zh
                ? '仅首次付费享内测价；续费采用届时正式价。以管理员确认开通时的剩余名额为准。'
                : 'Introductory pricing applies to the first payment only. Renewals use the current regular price. Availability is confirmed when access is enabled.'}
            </p>
            {data.campaign.endsAt && (
              <p>
                {zh ? '活动截止' : 'Offer ends'}:{' '}
                {new Date(data.campaign.endsAt).toLocaleString()}
              </p>
            )}
          </aside>
        )}
        {data && !data.plans.length && (
          <p>
            {zh
              ? '套餐尚未发布，请联系管理员了解开通安排。'
              : 'Plans have not been published yet. Contact us to discuss access.'}
          </p>
        )}
        <div className="pricing-grid">
          {data?.plans.map((p) => (
            <article className="contact-channel" key={p.versionId}>
              <h2>{zh ? p.name : p.nameEn}</h2>
              <p>{zh ? p.description : p.descriptionEn}</p>
              <p className="pricing-amount">
                {p.price} <span>USDT</span>
              </p>
              {data.campaign &&
                data.campaign.remaining > 0 &&
                Number(p.price) > 0 && (
                  <p>
                    {zh ? '首次内测价' : 'First-payment offer'}:{' '}
                    <strong>{p.introPrice} USDT</strong>
                  </p>
                )}
              <p>
                {p.durationUnit === 'lifetime'
                  ? zh
                    ? '长期有效'
                    : 'Lifetime'
                  : `${p.durationCount} ${{ day: zh ? '天' : 'days', month: zh ? '自然月' : 'calendar months', year: zh ? '自然年' : 'calendar years' }[p.durationUnit]}`}
              </p>
              <ul>
                <li>
                  {zh ? '每日 AI 交互' : 'Daily AI interactions'}:{' '}
                  {p.dailyLimit ?? (zh ? '不限' : 'Unlimited')}
                </li>
                {p.features.chat && (
                  <li>{zh ? 'AI 问答' : 'AI conversation'}</li>
                )}
                {p.features.research && (
                  <li>{zh ? '研究报告' : 'Research reports'}</li>
                )}
                {p.features.translate && <li>{zh ? '翻译' : 'Translation'}</li>}
              </ul>
              <a
                className="button button-primary"
                href={`/${locale}/contact?plan=${encodeURIComponent(p.id)}`}
              >
                {zh ? '联系管理员开通' : 'Contact us for access'}
              </a>
            </article>
          ))}
        </div>
        <p>
          {zh
            ? '研究按成功受理计次，内部多次模型调用不重复计次。到期后可继续查看行情与已有研究。'
            : 'Each accepted interaction counts once, including research submissions; internal model calls do not add charges. Market data and previous research remain accessible after expiry.'}
        </p>
      </section>
    </>
  )
}
