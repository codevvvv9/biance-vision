import { brand } from '@biance/brand/identity'
import type { ComponentType, ReactNode } from 'react'
import type { MDXComponents } from 'mdx/types'
import { publicationBodies } from '@/lib/publication-bodies'
import { sourceUrl, sources, type Publication } from '@/lib/publications'
import { disclaimer, loginUrl, text, type Locale } from '@/lib/site'
import { Arrow } from './Icons'

export async function PublicationPage({ item, locale }: { item: Publication; locale: Locale }) {
  const article = item.translations[locale]
  const key = `${item.id}:${locale}` as keyof typeof publicationBodies
  const { default: Body } = await publicationBodies[key]() as { default: ComponentType<{ components?: MDXComponents }> }
  const ids = new Map(article.toc.map(t => [t.title, t.id]))
  const components: MDXComponents = { h2: ({ children }: { children?: ReactNode }) => <h2 id={ids.get(String(children))}>{children}</h2> }
  return <article className="container article-page">
    <nav className="breadcrumb" aria-label={text(locale, 'Breadcrumb', '面包屑导航')}><a href={`/${locale}`}>{brand.name}</a><span>/</span><a href={`/${locale}/${item.kind === 'guide' ? 'guides' : item.kind === 'demo' ? 'demo' : 'about'}`}>{text(locale, item.kind === 'guide' ? 'FIELD NOTES' : item.kind === 'demo' ? 'TEACHING CASE' : 'PROJECT', item.kind === 'guide' ? '使用指南' : item.kind === 'demo' ? '教学案例' : '项目说明')}</a></nav>
    <div className="article-header"><span className="eyebrow">{item.topic[locale]}</span><h1>{article.title}</h1><p>{article.summary}</p><div className="article-byline"><a href={`/${locale}/about`}>{text(locale, 'DuckStrat project maintainers', 'DuckStrat 项目维护者')}</a><span>{text(locale, 'Updated', '更新于')} <time dateTime={article.modifiedAt}>{article.modifiedAt}</time></span></div></div>
    <div className="article-grid"><aside className="article-toc"><span className="eyebrow">{text(locale, 'ON THIS PAGE', '本页内容')}</span>{article.toc.map(t => <a key={t.id} href={`#${t.id}`}>{t.title}</a>)}<a href="#sources">{text(locale, 'Sources & scope', '来源与适用范围')}</a><a href="#next-step">{text(locale, 'Next step', '下一步')}</a></aside>
    <div className="article-body"><Body components={components} />
      <aside className="article-source" id="sources"><h2>{text(locale, 'Sources & scope', '来源与适用范围')}</h2><ul>{article.sources.map(id => <li key={id}><a href={sourceUrl(id, locale)} {...(sources[id].url.startsWith('https:') ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{sources[id].title} ↗</a><p>{sources[id].scope[locale === 'en' ? 0 : 1]}</p></li>)}</ul><p>{text(locale, 'The explanations and diagrams are our own editorial synthesis. Sources define terms or document product behavior; they do not validate the interpretation or endorse DuckStrat.', '解释与图例为本项目整理创作。来源用于定义术语或说明产品行为，不验证研究解释，也不为 DuckStrat 背书。')}</p><p>{disclaimer(locale)}</p></aside>
      <div className="article-next" id="next-step"><span className="eyebrow">{text(locale, 'PUT THE IDEAS IN CONTEXT', '将方法放回上下文')}</span><h2>{text(locale, 'Continue with the evidence.', '继续沿证据阅读。')}</h2><div className="button-row"><a className="button button-primary" href={item.kind === 'demo' ? `/${locale}/demo` : `/${locale}/demo/${item.relatedDemo}`}>{item.kind === 'demo' ? text(locale, 'Explore the interactive demo', '查看交互演示') : text(locale, 'Read the related case', '阅读相关案例')} <Arrow /></a><a className="button button-outline" href={`/${locale}/contact`}>{text(locale, 'Request access', '申请开通')}</a><a className="text-link" href={loginUrl(locale)}>{text(locale, 'Have an account? Log in', '已有账号？登录终端')} ↗</a></div><p><a href={`/${locale}/guides/reading-research-results`}>{text(locale, 'How to read research results', '如何阅读研究结果')}</a> · <a href={`/${locale}/guides/getting-started`}>{text(locale, 'Your first research', '第一次研究')}</a></p></div>
    </div></div>
  </article>
}
