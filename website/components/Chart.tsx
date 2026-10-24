import type { DemoId } from '@/lib/demo-content'
import { text, type Locale } from '@/lib/site'

/** Deterministic, original teaching data. Never represents a live market. */
function candles(id: DemoId) {
  let close = 245
  return Array.from({ length: 42 }, (_, i) => {
    const open = close
    const change = id === 'pullback'
      ? (i < 15 ? -5.4 : i < 23 ? 4.8 : -3.1) + Math.sin(i * 1.7) * 8
      : id === 'breakout'
        ? (i < 26 ? Math.sin(i * .65) * 6 : -5.7) + Math.sin(i * 2.1) * 5
        : Math.sin(i * .66) * 7.8 + Math.cos(i * 2) * 4
    close = open + change
    return { x: 24 + i * 12.7, open, close, high: Math.min(open, close) - 5 - (i % 4), low: Math.max(open, close) + 6 + (i % 3) }
  })
}

export function Chart({ locale, demo = 'pullback', active = 0, hero = false }: { locale: Locale; demo?: DemoId; active?: number; hero?: boolean }) {
  const data = candles(demo)
  const level = demo === 'pullback' ? 177 : demo === 'breakout' ? 227 : 245
  const title = text(locale, 'Illustrative BTC / USDT price action chart', 'BTC / USDT 价格行为教学图')
  return <svg className={`research-chart ${hero ? 'hero-chart' : ''}`} viewBox="0 0 620 355" role="img" aria-label={title}>
    <title>{title}</title><desc>{text(locale, 'Original teaching chart, not live prices. A shaded region highlights the evidence under review.', '原创教学图，非实时价格。阴影区域标记当前阅读的证据。')}</desc>
    <defs><linearGradient id={`chart-fill-${demo}-${hero}`} x1="0" x2="0" y1="0" y2="1"><stop stopColor="#60f0d0" stopOpacity=".1" /><stop offset="1" stopColor="#60f0d0" stopOpacity="0" /></linearGradient></defs>
    {[65, 125, 185, 245, 305].map((y, i) => <g key={y}><line x1="16" x2="555" y1={y} y2={y} stroke="#b2cbdf" strokeOpacity=".075" /><text x="570" y={y + 4} fill="#56667c" fontSize="10" fontFamily="monospace">{['HIGH', '·', 'MID', '·', 'LOW'][i]}</text></g>)}
    {[90, 205, 320, 435, 550].map(x => <line key={x} x1={x} x2={x} y1="36" y2="315" stroke="#b2cbdf" strokeOpacity=".04" />)}
    <rect className="chart-highlight" x={active === 0 ? 155 : active === 1 ? 325 : 440} y="45" width="105" height="265" rx="5" fill={active === 2 ? '#b5a6ed' : '#60f0d0'} opacity=".055" />
    <path d={`M ${data.map(d => `${d.x},${(d.open + d.close) / 2 + 28}`).join(' L ')}`} fill="none" stroke="#b5a6ed" strokeWidth="1.5" opacity=".45" />
    <line x1="20" x2="555" y1={level} y2={level} stroke="#60f0d0" strokeOpacity=".45" strokeDasharray="4 5" />
    <text x="24" y={level - 10} fill="#74ad9f" fontSize="9.5" fontFamily="monospace">{text(locale, 'STRUCTURE ZONE', '结构观察区域')}</text>
    {data.map((d, i) => {
      const color = d.close < d.open ? '#64cfb5' : '#b17986'
      return <g key={i}><line x1={d.x} x2={d.x} y1={d.high} y2={d.low} stroke={color} strokeWidth="1" /><rect x={d.x - 3} y={Math.min(d.open, d.close)} width="6" height={Math.max(2, Math.abs(d.close - d.open))} rx=".5" fill={color} /></g>
    })}
    <g fill="#526177" fontSize="10" fontFamily="monospace"><text x="24" y="340">08:00</text><text x="190" y="340">10:00</text><text x="360" y="340">12:00</text><text x="520" y="340">14:00</text></g>
    <circle cx={active === 0 ? 207 : active === 1 ? 375 : 488} cy={level} r="13" fill="#112a29" stroke="#60f0d0" strokeOpacity=".6" /><text x={active === 0 ? 207 : active === 1 ? 375 : 488} y={level + 3.5} textAnchor="middle" fill="#8af8da" fontSize="10" fontFamily="monospace">{active + 1}</text>
  </svg>
}
