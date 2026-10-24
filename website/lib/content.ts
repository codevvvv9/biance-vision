import { published } from './publications'
import { text, type Locale } from './site'
export { demos, type DemoId } from './demo-content'

export function guides(locale: Locale) {
  return published.filter(p => p.kind === 'guide').map(p => ({ slug: p.path.slice(7), category: p.topic[locale], title: p.translations[locale].title, description: p.translations[locale].summary }))
}

export const methodSteps = (locale: Locale) => [
  [text(locale, 'Freeze the context', '冻结上下文'), text(locale, 'Start with a market snapshot and a clear information cutoff.', '从行情快照与明确的信息截止时间开始。')],
  [text(locale, 'Read the structure', '解读结构'), text(locale, 'Understand trend, range and the sequence of confirmed price action.', '识别趋势、区间与已确认价格行为的推进顺序。')],
  [text(locale, 'Consider both sides', '同时考虑两面'), text(locale, 'Connect supporting evidence with the strongest opposing case.', '将支持证据与有力的反对解释一起检验。')],
  [text(locale, 'State the conditions', '明确成立条件'), text(locale, 'Show what is uncertain, what would invalidate the view, and when to wait.', '说明不确定性、失效条件，以及何时应该等待。')],
]
