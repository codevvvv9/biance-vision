import { Chart } from './Chart'
import { text, type Locale } from '@/lib/site'

export function ResearchFigure({ kind, locale }: { kind: 'timeline' | 'h2' | 'pullback' | 'breakout' | 'wait'; locale: Locale }) {
  const timeline = kind === 'timeline'
  const caption = timeline
    ? text(locale, 'Original timing diagram: an observation and its later confirmation are separate. Not to scale.', '原创时间示意：观察与后续确认是不同时间。图例不按比例。')
    : kind === 'h2' ? text(locale, 'Original schematic: first and second upward attempts within a pullback. Not a candle-by-candle signal or a trade recommendation.', '原创示意：回调中的第一次与第二次向上尝试。不是逐根 K 线信号，也不是交易建议。')
    : text(locale, 'Original synthetic teaching chart. Not live research, an executable price or a verified historical result.', '原创合成教学图。非实时研究，不提供可执行价格，也不是经过验证的历史结果。')
  return <figure className="research-figure">{kind === 'timeline' || kind === 'h2'
    ? <svg viewBox="0 0 660 210" role="img" aria-label={caption}><title>{caption}</title>
      {timeline ? <><path d="M45 100H615m-10-7 10 7-10 7" fill="none" stroke="#60f0d0" strokeWidth="2" />{[text(locale, 'Candle closes', 'K 线收盘'), text(locale, 'Structure confirmed', '结构确认'), text(locale, 'Research snapshot', '研究快照')].map((label,i) => <g key={label}><circle cx={70+i*245} cy="100" r="7" fill="#60f0d0" /><text x={70+i*245} y={i===1?65:145} textAnchor="middle" fill="#c7d7e5" fontSize="15">{label}</text></g>)}<text x="330" y="190" textAnchor="middle" fill="#8f9cb1" fontSize="13">{text(locale, 'A later quote has its own timestamp.', '后续实时报价有自己的时间标记。')}</text></>
      : <><path d="M35 170 85 130 120 145 180 70 230 110 275 90 325 135 380 105 425 125 490 80 545 95 620 45" fill="none" stroke="#60f0d0" strokeWidth="3" /><text x="180" y="45" textAnchor="middle" fill="#8f9cb1" fontSize="14">{text(locale, 'Upward context', '上行背景')}</text>{[[275,90,'1'],[490,80,'2']].map(([x,y,n]) => <g key={n}><circle cx={x} cy={y} r="14" fill="#112a29" stroke="#60f0d0" /><text x={x} y={Number(y)+5} textAnchor="middle" fill="#c7d7e5" fontSize="14">{n}</text></g>)}<text x="330" y="190" textAnchor="middle" fill="#8f9cb1" fontSize="13">{text(locale, 'Count attempts in context, not green candles.', '结合背景识别尝试，不能只数阳线。')}</text></>}
    </svg> : <Chart locale={locale} demo={kind} />}
    <figcaption>{caption}</figcaption></figure>
}
