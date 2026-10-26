/** Public identity only. No framework, browser API or deployment configuration. */
export const brand = Object.freeze({
  name: 'DuckStrat',
  domain: 'duckstrat.com',
  positioning: Object.freeze({ en: 'Price action & strategy research workspace', zh: '价格行为与策略研究工作台' }),
  promise: Object.freeze({ en: 'Navigate risk. Make informed decisions.', zh: '先避风险，再做判断。' }),
  yellow: '#f5cc58',
})

/** The same original silhouette is used in the mark, hero and social card. */
export const duck = Object.freeze({
  body: 'M12 43C7 40 5 34 6 29C12 33 17 32 21 28C20 25 19 22 19 18C19 10 25 5 33 5C41 5 46 11 45 19C44 24 40 28 36 30C43 32 46 35 46 40C46 49 36 55 24 55C14 55 7 51 5 45Z',
  beak: 'M43 17L57 21L44 25C46 22 46 20 43 17Z',
  wing: 'M17 38C23 35 31 36 34 39C30 46 22 47 17 42',
})

export const brandMarkSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><path d="${duck.body}" fill="${brand.yellow}"/><path d="${duck.beak}" fill="#ed9949"/><path d="${duck.wing}" stroke="#b88726" stroke-width="2" stroke-linecap="round"/><circle cx="36" cy="16" r="2.2" fill="#182125"/></svg>\n`
