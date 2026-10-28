import { text, type Locale } from './site'

type Bilingual = readonly [en: string, zh: string, tw?: string]
const pick = (locale: Locale, pair: Bilingual) => text(locale, ...pair)
export type DemoId = 'pullback' | 'breakout' | 'wait'

const demoContent = [
  {
    id: 'pullback' as const, number: '01',
    label: ['Trend pullback', '趋势回调', '趨勢回撥'] as Bilingual,
    title: ['A pullback is a question. Not a conclusion.', '回调是一个问题，不是一个结论。', '回撥是一個問題，不是一個結論。'] as Bilingual,
    context: ['An illustrative upward structure pulls back toward its previous breakout area. The structure alone does not establish an entry.', '教学图中的上行结构回调至前期突破区域。仅凭这个结构，还不能形成入场结论。', '教學圖中的上行結構回撥至前期突破區域。僅憑這個結構，還不能形成入場結論。'] as Bilingual,
    conclusion: ['Wait for the response at the prior breakout area.', '等待价格在前期突破区域的反应。', '等待價格在前期突破區域的反應。'] as Bilingual,
    evidence: [
      ['Higher swing lows preserve the upward context.', '摆动低点抬高，保留了上行背景。', '擺動低點抬高，保留了上行背景。'],
      ['The pullback reaches a previously contested area.', '回调来到此前多空争夺的区域。', '回撥來到此前多空爭奪的區域。'],
    ] as Bilingual[],
    counter: ['Recent candles overlap. Buying pressure is not yet decisive.', '近期 K 线重叠，买方压力尚不明确。', '近期 K 線重疊，買方壓力尚不明確。'] as Bilingual,
    invalidation: ['A sustained break below the structural low requires a fresh assessment.', '若持续跌破结构低点，需要重新评估。', '若持續跌破結構低點，需要重新評估。'] as Bilingual,
    level: 136, start: 13, end: 20,
  },
  {
    id: 'breakout' as const, number: '02',
    label: ['Range breakout', '区间突破', '區間突破'] as Bilingual,
    title: ['A breakout needs evidence that it can hold.', '突破之后，还需要站稳的证据。', '突破之後，還需要站穩的證據。'] as Bilingual,
    context: ['Price tests the upper boundary of an illustrative range. A brief move beyond resistance can still reverse.', '价格测试教学区间的上边界。短暂越过阻力后，仍可能回到区间。', '價格測試教學區間的上邊界。短暫越過阻力後，仍可能回到區間。'] as Bilingual,
    conclusion: ['Separate the breakout attempt from its confirmation.', '区分突破尝试与突破确认。', '區分突破嘗試與突破確認。'] as Bilingual,
    evidence: [
      ['Price closes above the range boundary.', '价格收在区间边界上方。', '價格收在區間邊界上方。'],
      ['A retest can reveal whether the boundary holds.', '回测有助于观察边界能否守住。', '回測有助於觀察邊界能否守住。'],
    ] as Bilingual[],
    counter: ['A single candle does not establish sustained acceptance above the range.', '单根 K 线不能证明价格已持续被区间上方接受。', '單根 K 線不能證明價格已持續被區間上方接受。'] as Bilingual,
    invalidation: ['A return into the range weakens the breakout interpretation.', '若重新回到区间，突破解释将被削弱。', '若重新回到區間，突破解釋將被削弱。'] as Bilingual,
    level: 160, start: 22, end: 29,
  },
  {
    id: 'wait' as const, number: '03',
    label: ['Wait for clarity', '等待确认', '等待確認'] as Bilingual,
    title: ['Sometimes the most useful result is “wait”.', '有时，最有用的研究结果是“等待”。', '有時，最有用的研究結果是“等待”。'] as Bilingual,
    context: ['An illustrative range contains repeated reversals and overlapping candles. Directional evidence remains mixed.', '教学区间中反复出现反转和重叠 K 线，方向证据仍然矛盾。', '教學區間中反覆出現反轉和重疊 K 線，方向證據仍然矛盾。'] as Bilingual,
    conclusion: ['There is not enough directional evidence yet.', '目前还没有足够的方向证据。', '目前還沒有足夠的方向證據。'] as Bilingual,
    evidence: [
      ['Both sides have failed to sustain a move.', '多空双方都未能维持单向走势。', '多空雙方都未能維持單向走勢。'],
      ['Overlapping candles suggest unresolved balance.', '重叠 K 线表明平衡尚未被打破。', '重疊 K 線表明平衡尚未被打破。'],
    ] as Bilingual[],
    counter: ['Forcing a direction would hide the uncertainty in the evidence.', '强行选择方向，会掩盖证据中的不确定性。', '強行選擇方向，會掩蓋證據中的不確定性。'] as Bilingual,
    invalidation: ['Revisit the research after a sustained break and a new confirmed structure.', '持续突破并形成新的已确认结构后，再重新研究。', '持續突破並形成新的已確認結構後，再重新研究。'] as Bilingual,
    level: 154, start: 8, end: 16,
  },
]

export function demos(locale: Locale) {
  return demoContent.map(d => ({ ...d, label: pick(locale, d.label), title: pick(locale, d.title),
    context: pick(locale, d.context), conclusion: pick(locale, d.conclusion), evidence: d.evidence.map(e => pick(locale, e)),
    counter: pick(locale, d.counter), invalidation: pick(locale, d.invalidation) }))
}

export const demoPaths = { pullback: 'trend-pullback', breakout: 'range-breakout', wait: 'wait-for-confirmation' } as const
