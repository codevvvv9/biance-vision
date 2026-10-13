/**
 * 行情数据基础集成 smoke：真实 Binance REST + 本地 PostgreSQL（docker compose，127.0.0.1:5434）。
 * 运行：pnpm market:smoke
 *
 * 覆盖（docs/specs/market-data.md 验收用例）：
 * 1) BTCUSDT 现货 trade 1m 与永续 trade/mark/index 1m 各拉最近 100 根落库
 * 2) createSnapshot：各周期 closeTime<=asOf、实时价独立 priceAsOf
 * 3) 重复 ingest 幂等（复合主键 upsert，行数不增）
 * 4) SQL 检查：spot 与 perp 同名交易对分别存在；index/mark 占位成交量归一化为 null
 * 5) asOf 过滤、资金费率 / 持仓量落库、quality 缺口与延迟
 *
 * 注意：每次运行会先清理 BTCUSDT 的 1m 行情/funding/OI/快照数据，保证从零可重复验证。
 */
import { initDb, getDb, sql } from '../server/src/db.js'
import { ingestSeries } from '../server/src/market/ingest.js'
import { createSnapshot } from '../server/src/market/snapshot.js'
import { ingestFunding } from '../server/src/market/funding.js'
import { ingestOpenInterest } from '../server/src/market/oi.js'
import { getQuality } from '../server/src/market/quality.js'
import { readCandles } from '../server/src/market/read.js'
import type { SeriesKey } from '../server/src/market/watchlist.js'

let failures = 0
function check(name: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✔ PASS' : '✖ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const ok = await initDb()
if (!ok) {
  console.error('PostgreSQL 不可用（默认 127.0.0.1:5434；先 docker compose up -d postgres），smoke 无法执行')
  process.exit(1)
}
const db = getDb()!

const seriesList: SeriesKey[] = [
  { marketType: 'spot', priceType: 'trade', symbol: 'BTCUSDT', interval: '1m' },
  { marketType: 'usdm_perp', priceType: 'trade', symbol: 'BTCUSDT', interval: '1m' },
  { marketType: 'usdm_perp', priceType: 'mark', symbol: 'BTCUSDT', interval: '1m' },
  { marketType: 'usdm_perp', priceType: 'index', symbol: 'BTCUSDT', interval: '1m' },
]

// 0) 清理 BTCUSDT 历史验证数据，保证每次从零开始
await db.execute(sql`delete from market_candles where symbol = 'BTCUSDT' and interval = '1m'`)
await db.execute(sql`delete from ingest_state where symbol = 'BTCUSDT' and interval = '1m'`)
await db.execute(sql`delete from market_funding_rates where symbol = 'BTCUSDT'`)
await db.execute(sql`delete from market_open_interest where symbol = 'BTCUSDT'`)
await db.execute(sql`delete from market_snapshots where symbol = 'BTCUSDT'`)

// 1) 首次采集：最近 100 根
const since = Date.now() - 100 * 60_000
for (const s of seriesList) {
  const r = await ingestSeries(s, { sinceOpenTime: since, limit: 200 })
  console.log(`ingest ${s.marketType}/${s.priceType}: fetched=${r.fetched} closed=${r.closed} gaps=${r.gaps} skipped=${r.skippedInvalid}`)
  check(`采集 ${s.marketType}/${s.priceType} 有落库`, r.closed >= 95, `closed=${r.closed}`)
}

// 2) 快照
const snapshot = await createSnapshot({ symbol: 'BTCUSDT', marketType: 'usdm_perp', asOf: Date.now() })
check('快照含 1m 周期', snapshot.perInterval['1m'] !== undefined)
check('快照 lastClosedOpenTime 满足 closeTime<=asOf', (() => {
  const lot = snapshot.perInterval['1m']?.lastClosedOpenTime
  return lot !== undefined && lot + 60_000 - 1 <= snapshot.asOf
})())
check('快照实时价 priceAsOf 非空', snapshot.priceAsOf !== null, `priceAsOf=${snapshot.priceAsOf}`)

// 3) 幂等：以固定收盘边界计数（排除两轮之间新收盘的 bar）→ 重复 ingest → 行数不增
const bound = Date.now()
const countRows = async (): Promise<number> => {
  const r = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from market_candles where symbol = 'BTCUSDT' and interval = '1m' and close_time <= ${bound}`,
  )
  return Number(r[0].n)
}
const before = await countRows()
for (const s of seriesList) await ingestSeries(s, { sinceOpenTime: since, limit: 200 })
const after = await countRows()
check('重复 ingest 幂等（行数不增）', before === after, `before=${before} after=${after}`)

// 4) SQL 检查：spot 与 perp 分离、index/mark 占位成交量为 null
const grouped = await db.execute<{ market_type: string; price_type: string; n: number }>(
  sql`select market_type, price_type, count(*)::int as n from market_candles where symbol='BTCUSDT' and interval='1m' group by 1,2 order by 1,2`,
)
console.log('分组计数:', JSON.stringify(grouped))
check('spot/trade 存在', grouped.some((g) => g.market_type === 'spot' && g.price_type === 'trade' && Number(g.n) > 0))
check('usdm_perp/trade 存在', grouped.some((g) => g.market_type === 'usdm_perp' && g.price_type === 'trade' && Number(g.n) > 0))
const idxNonNull = await db.execute<{ n: number }>(
  sql`select count(*)::int as n from market_candles where market_type='usdm_perp' and price_type='index' and (volume is not null or quote_volume is not null or trades is not null)`,
)
check('index 价格类型 volume/quoteVolume/trades 全为 null', Number(idxNonNull[0].n) === 0)
const markNonNull = await db.execute<{ n: number }>(
  sql`select count(*)::int as n from market_candles where market_type='usdm_perp' and price_type='mark' and volume is not null`,
)
check('mark 价格类型 volume 为 null', Number(markNonNull[0].n) === 0)

// asOf 过滤：历史 asOf 只返回当时已收盘数据
const asOf = Date.now() - 30 * 60_000
const candlesAsOf = await readCandles({ marketType: 'usdm_perp', priceType: 'trade', symbol: 'BTCUSDT', interval: '1m', asOf, limit: 500 })
check('asOf 过滤生效（closeTime <= asOf）', candlesAsOf.length > 0 && candlesAsOf.every((c) => c.closeTime <= asOf), `n=${candlesAsOf.length}`)

// 5) funding / OI / quality
const fundingN = await ingestFunding('BTCUSDT')
check('资金费率落库', fundingN > 0, `新增=${fundingN}`)
const oiN = await ingestOpenInterest('BTCUSDT', '1h')
check('持仓量落库', oiN > 0, `新增=${oiN}`)
const quality = await getQuality({ symbol: 'BTCUSDT', marketType: 'usdm_perp', interval: '1m' })
check('quality 返回 trade/mark/index 三序列', quality.length === 3, `n=${quality.length}`)
check('quality lagMs 合理（<5m）', quality.every((q) => q.lagMs < 5 * 60_000), quality.map((q) => `${q.priceType}:${q.lagMs}ms`).join(' '))
check('quality gapCount=0', quality.every((q) => q.gapCount === 0))

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
