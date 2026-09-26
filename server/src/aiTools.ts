import { restGet, tickerCache, tickerOf, topUsdtTickers } from './binance.js'
import type { RawKlineRow } from './types.js'
import { buildSystemPrompt, getAiNews, streamChatOnce } from './ai.js'
import type { AiProfile, ChatMessage } from './ai.js'
import { addManualMemory, clearMemories, deleteMemoriesByKeyword, listMemories, MEMORY_KINDS } from './aiMemory.js'
import { log, kv, fmtMs } from './logger.js'

// ---------------------------------------------------------------------------
// AI 工具调用（function calling）：模型决定调用哪个工具，本地执行后把结果
// 喂回模型作答。工具全部基于币安实时接口与本地计算，无第三方付费服务。
//
// render_chart 特殊：执行结果不经过模型转述（避免数据失真），由编排层把
// 图表 JSON 以 ```chart 代码块直接写进回复流，前端渲染为交互式图表卡片。
// ---------------------------------------------------------------------------

/** 前端图表卡片数据（聊天消息内 ```chart 代码块的 JSON 载荷） */
export interface ChartSpec {
  type: 'kline' | 'bar'
  title: string
  /** kline：秒级时间戳 */
  times?: number[]
  /** kline：[open, high, low, close] */
  ohlc?: number[][]
  volumes?: number[]
  /** bar：条目名与数值 */
  labels?: string[]
  values?: number[]
  /** bar 数值格式 */
  fmt?: 'pct' | 'price'
}

export interface AiToolResult {
  /** 喂给模型的文本结果（紧凑、面向模型消费） */
  result: string
  /** 前端图表（编排层注入回复流，模型只拿到 result 里的摘要） */
  chart?: ChartSpec
}

const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'] as const
type Interval = (typeof INTERVALS)[number]

/** 每年 K 线根数（年化波动率换算用） */
const PERIODS_PER_YEAR: Record<Interval, number> = {
  '1m': 525600,
  '3m': 175200,
  '5m': 105120,
  '15m': 35040,
  '30m': 17520,
  '1h': 8760,
  '2h': 4380,
  '4h': 2190,
  '6h': 1460,
  '8h': 1095,
  '12h': 730,
  '1d': 365,
}

const SYMBOL_RE = /^[A-Z0-9]{4,20}$/
const normSymbol = (s: unknown): string => (typeof s === 'string' ? s.trim().toUpperCase() : '')

function pickInterval(v: unknown, fallback: Interval): Interval {
  return typeof v === 'string' && (INTERVALS as readonly string[]).includes(v) ? (v as Interval) : fallback
}

function pickInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback
}

const fmtNum = (n: number, dp = 2): string =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: dp }) : '--'

const fmtVolU = (q: number): string => (q >= 1e8 ? `${(q / 1e8).toFixed(2)}亿` : q >= 1e4 ? `${(q / 1e4).toFixed(0)}万` : fmtNum(q))

// ---------------------------------------------------------------------------
// 工具 schema（OpenAI tools 格式）
// ---------------------------------------------------------------------------

export const AI_TOOLS_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'get_ticker',
      description: '查询单个交易对的实时行情：现价、24h 涨跌幅、最高/最低、成交额。用户问「XX 现在多少钱」时用',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string', description: '交易对，如 SOLUSDT、BTCUSDT' } },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'top_movers',
      description: '获取 24h 涨幅榜或跌幅榜（按成交额前 150 的 USDT 交易对）',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['gainers', 'losers'], description: 'gainers 涨幅榜 / losers 跌幅榜' },
          limit: { type: 'number', description: '条数，默认 10，最大 15' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_klines',
      description: '获取 K 线原始数据（OHLCV），需要逐根看数据时用；只需统计结论时优先用 analyze_klines',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '交易对，如 BTCUSDT' },
          interval: { type: 'string', enum: INTERVALS, description: 'K 线周期' },
          limit: { type: 'number', description: '根数，默认 100，最大 200' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analyze_klines',
      description:
        '技术分析：区间涨跌幅、年化波动率、最大回撤、MA7/25/99、RSI14、布林带位置、量能变化。用户问「走势如何/超买超卖/风险多大」时用',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '交易对，如 ETHUSDT' },
          interval: { type: 'string', enum: INTERVALS, description: 'K 线周期，默认 1h' },
          limit: { type: 'number', description: '根数，默认 100，最大 300' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'correlation',
      description: '计算两个交易对收盘价的相关系数（-1~1），用于「A 和 B 走势是否联动 / 哪个和 BTC 相关」类问题',
      parameters: {
        type: 'object',
        properties: {
          symbol_a: { type: 'string' },
          symbol_b: { type: 'string' },
          interval: { type: 'string', enum: INTERVALS, description: '默认 1h' },
          limit: { type: 'number', description: '根数，默认 100，最大 300' },
        },
        required: ['symbol_a', 'symbol_b'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calc',
      description:
        '精确算术计算器（支持 + - * / ( ) 和百分数如 3%）。仓位大小、盈亏、杠杆倍数、收益率等涉及数字计算时必须用它，不要心算',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: '算式，如 10000*3% 或 (90000-85000)/85000*100' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'render_chart',
      description:
        '画图并直接展示给用户：K 线蜡烛图（含成交量）或涨跌榜条形图。用户说「画一下/看看图/可视化」时用；图表会展示给用户，你只需在回复中解读要点',
      parameters: {
        type: 'object',
        properties: {
          chart_type: { type: 'string', enum: ['kline', 'bar'], description: 'kline 蜡烛图 / bar 涨跌榜条形图' },
          symbol: { type: 'string', description: 'kline 必填：交易对' },
          interval: { type: 'string', enum: INTERVALS, description: 'kline 周期，默认 1h' },
          limit: { type: 'number', description: 'kline 根数，默认 120，最大 300' },
          direction: { type: 'string', enum: ['gainers', 'losers'], description: 'bar 必填：涨/跌榜' },
          title: { type: 'string', description: '图表标题（可选，默认自动生成）' },
        },
        required: ['chart_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_news',
      description: '获取最新币圈要闻标题（Decrypt / Cointelegraph，约 6 条）。用户问「有什么新闻/消息面」时用',
      parameters: { type: 'object', properties: {} },
    },
  },
] as const

/** 有工具可用时追加到 system prompt 的使用纪律 */
export const TOOL_SYSTEM_HINT = `# 工具使用纪律
你可以在回答前调用工具（function calling），规则：
- 用户问及具体币种的详细行情、K 线走势、技术指标、两币相关性时，必须先调用相应工具获取真实数据，禁止凭快照或记忆编造精确数字
- 用户要求画图 / 可视化时调用 render_chart：图表会直接展示给用户，你的回复只需给出解读要点，不要用文字复述全部数据
- 涉及仓位、盈亏、收益率等数字计算时用 calc 保证准确
- 工具返回失败或数据为空时如实告知，不要编造`

// ---------------------------------------------------------------------------
// K 线获取与统计（技术分析核心）
// ---------------------------------------------------------------------------

interface KlineSeries {
  times: number[]
  closes: number[]
  ohlc: number[][]
  volumes: number[]
}

async function fetchKlines(symbol: string, interval: Interval, limit: number): Promise<KlineSeries> {
  const rows = await restGet<RawKlineRow[]>(
    `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
  )
  return {
    times: rows.map((r) => Math.floor(r[0] / 1000)),
    closes: rows.map((r) => +r[4]),
    ohlc: rows.map((r) => [+r[1], +r[2], +r[3], +r[4]]),
    volumes: rows.map((r) => +r[5]),
  }
}

function sma(values: number[], n: number): number {
  if (values.length < n) return NaN
  let s = 0
  for (let i = values.length - n; i < values.length; i++) s += values[i]
  return s / n
}

function stdev(values: number[]): number {
  const n = values.length
  if (n < 2) return NaN
  const mean = values.reduce((a, b) => a + b, 0) / n
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
}

function rsiWilder(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  let avgGain = gain / period
  let avgLoss = loss / period
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period
  }
  if (avgLoss === 0) return 100
  return 100 - 100 / (1 + avgGain / avgLoss)
}

function maxDrawdown(closes: number[]): number {
  let peak = closes[0]
  let mdd = 0
  for (const c of closes) {
    if (c > peak) peak = c
    if (peak > 0) mdd = Math.max(mdd, (peak - c) / peak)
  }
  return mdd
}

/** K 线技术统计（区间收益 / 年化波动 / 回撤 / 均线 / RSI / 布林带 / 量能） */
export function analyzeSeries(s: KlineSeries, interval: Interval): string {
  const { closes, volumes } = s
  if (closes.length < 30) return `数据不足（仅 ${closes.length} 根），无法做技术统计`
  const first = closes[0]
  const last = closes[closes.length - 1]
  const retPct = ((last - first) / first) * 100
  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]))
  const retStd = stdev(rets)
  const annVol = retStd * Math.sqrt(PERIODS_PER_YEAR[interval]) * 100
  const mdd = maxDrawdown(closes) * 100
  const rsi = rsiWilder(closes)
  const ma7 = sma(closes, 7)
  const ma25 = sma(closes, 25)
  const ma99 = sma(closes, 99)
  const bbN = 20
  const bbSlice = closes.slice(-bbN)
  const bbMid = bbSlice.reduce((a, b) => a + b, 0) / bbN
  const bbSd = stdev(bbSlice)
  const pb = bbSd > 0 ? ((last - (bbMid - 2 * bbSd)) / (4 * bbSd)) * 100 : NaN
  const recentVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length)
  const priorVol = volumes.slice(-40, -20).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(20, volumes.length - 20))
  const volRatio = priorVol > 0 ? recentVol / priorVol : NaN
  const maLine = [ma7, ma25, ma99]
  const maTrend = maLine.every((m) => Number.isFinite(m))
    ? ma7 > ma25 && ma25 > ma99
      ? '多头排列（MA7>MA25>MA99）'
      : ma7 < ma25 && ma25 < ma99
        ? '空头排列（MA7<MA25<MA99）'
        : '均线缠绕（方向不明）'
    : '样本不足'
  const lines = [
    `区间：${closes.length} 根 ${interval} K 线，首收盘 ${fmtNum(first, 2)} → 末收盘 ${fmtNum(last, 2)}`,
    `区间涨跌：${retPct >= 0 ? '+' : ''}${retPct.toFixed(2)}%；最大回撤 ${(mdd).toFixed(2)}%`,
    `年化波动率：${fmtNum(annVol, 1)}%（按 ${interval} 周期折算）`,
    `均线：MA7 ${fmtNum(ma7, 2)} / MA25 ${fmtNum(ma25, 2)} / MA99 ${fmtNum(ma99, 2)}，形态 ${maTrend}`,
    `RSI14：${fmtNum(rsi, 1)}（>70 超买区，<30 超卖区）`,
    `布林带(20,2)：中轨 ${fmtNum(bbMid, 2)}，现价位于带宽 ${fmtNum(pb, 0)}% 处（0=下轨，100=上轨）`,
  ]
  if (Number.isFinite(volRatio)) lines.push(`量能：近 20 根均值是前 20 根的 ${volRatio.toFixed(2)} 倍`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 工具执行器
// ---------------------------------------------------------------------------

/** 安全算术：白名单字符 + 百分数归一，杜绝任意代码执行 */
function safeCalc(expr: string): number {
  const normalized = expr.replace(/(\d+(?:\.\d+)?)\s*%/g, '($1/100)')
  if (!/^[0-9+\-*/().\s]+$/.test(normalized)) throw new Error('表达式含不支持的字符')
  // eslint-disable-next-line no-new-func
  const value = Function(`"use strict"; return (${normalized})`)() as unknown
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('表达式无法计算')
  return value
}

async function tickerText(symbol: string): Promise<string> {
  const cached = tickerOf(symbol)
  const t = cached
    ? cached
    : // 缓存未覆盖（非主流币）时直接查 REST
      await restGet<{ lastPrice: string; priceChangePercent: string; highPrice: string; lowPrice: string; quoteVolume: string }>(
        `/api/v3/ticker/24hr?symbol=${symbol}`,
      ).then((r) => ({
        last: parseFloat(r.lastPrice),
        changePct: parseFloat(r.priceChangePercent),
        high: parseFloat(r.highPrice),
        low: parseFloat(r.lowPrice),
        quoteVolume: parseFloat(r.quoteVolume),
      }))
  if (!t || !Number.isFinite(t.last)) throw new Error(`未找到交易对 ${symbol}（请确认名称，如 BTCUSDT）`)
  return [
    `${symbol} 现价 ${fmtNum(t.last, 8)} USDT`,
    `24h ${t.changePct >= 0 ? '+' : ''}${t.changePct.toFixed(2)}%（高 ${fmtNum(t.high, 8)} / 低 ${fmtNum(t.low, 8)}）`,
    `24h 成交额 ${fmtVolU(t.quoteVolume)} USDT`,
  ].join('，')
}

function moversText(direction: 'gainers' | 'losers', limit: number): string {
  const sorted = [...topUsdtTickers(150)].sort((a, b) => parseFloat(b.P) - parseFloat(a.P))
  const list = (direction === 'gainers' ? sorted.slice(0, limit) : sorted.slice(-limit).reverse())
  if (list.length === 0) throw new Error('行情数据尚未就绪')
  const head = direction === 'gainers' ? `24h 涨幅前 ${list.length}` : `24h 跌幅前 ${list.length}`
  return [
    `${head}（USDT 交易对，按成交额前 150 内筛选）：`,
    ...list.map((t) => `${t.s} ${parseFloat(t.P) >= 0 ? '+' : ''}${parseFloat(t.P).toFixed(2)}% 现${fmtNum(parseFloat(t.c), 8)} 额${fmtVolU(parseFloat(t.q))}`),
  ].join('\n')
}

export async function executeAiTool(name: string, argsJson: string): Promise<AiToolResult> {
  let args: Record<string, unknown> = {}
  try {
    args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
  } catch {
    throw new Error('工具参数不是合法 JSON')
  }
  switch (name) {
    case 'get_ticker': {
      const symbol = normSymbol(args.symbol)
      if (!SYMBOL_RE.test(symbol)) throw new Error('symbol 不合法')
      return { result: await tickerText(symbol) }
    }
    case 'top_movers': {
      const direction = args.direction === 'losers' ? 'losers' : 'gainers'
      return { result: moversText(direction, pickInt(args.limit, 3, 15, 10)) }
    }
    case 'get_klines': {
      const symbol = normSymbol(args.symbol)
      if (!SYMBOL_RE.test(symbol)) throw new Error('symbol 不合法')
      const interval = pickInterval(args.interval, '1h')
      const limit = pickInt(args.limit, 10, 200, 100)
      const s = await fetchKlines(symbol, interval, limit)
      const head = `${symbol} ${interval} K 线 ${s.times.length} 根，格式：时间戳,开,高,低,收,量`
      const body = s.times
        .map((t, i) => `${t},${s.ohlc[i][0]},${s.ohlc[i][1]},${s.ohlc[i][2]},${s.ohlc[i][3]},${s.volumes[i]}`)
        .join('\n')
      return { result: `${head}\n${body}` }
    }
    case 'analyze_klines': {
      const symbol = normSymbol(args.symbol)
      if (!SYMBOL_RE.test(symbol)) throw new Error('symbol 不合法')
      const interval = pickInterval(args.interval, '1h')
      const limit = pickInt(args.limit, 30, 300, 100)
      const s = await fetchKlines(symbol, interval, limit)
      return { result: `${symbol} ${interval} 技术统计（币安实时数据）：\n${analyzeSeries(s, interval)}` }
    }
    case 'correlation': {
      const a = normSymbol(args.symbol_a)
      const b = normSymbol(args.symbol_b)
      if (!SYMBOL_RE.test(a) || !SYMBOL_RE.test(b)) throw new Error('symbol 不合法')
      if (a === b) return { result: `${a} 与自身相关系数为 1` }
      const interval = pickInterval(args.interval, '1h')
      const limit = pickInt(args.limit, 30, 300, 100)
      const [sa, sb] = await Promise.all([fetchKlines(a, interval, limit), fetchKlines(b, interval, limit)])
      const mapB = new Map(sb.times.map((t, i) => [t, sb.closes[i]]))
      const pairs = sa.times
        .map((t, i) => [sa.closes[i], mapB.get(t)] as const)
        .filter((p): p is readonly [number, number] => p[1] !== undefined)
      if (pairs.length < 30) throw new Error('两币重叠样本不足（K 线时间未对齐或数据过短）')
      const n = pairs.length
      const ma = pairs.reduce((s, p) => s + p[0], 0) / n
      const mb = pairs.reduce((s, p) => s + p[1], 0) / n
      let cov = 0
      let va = 0
      let vb = 0
      for (const [x, y] of pairs) {
        cov += (x - ma) * (y - mb)
        va += (x - ma) ** 2
        vb += (y - mb) ** 2
      }
      const r = cov / Math.sqrt(va * vb)
      const strength = r > 0.8 ? '强正相关（走势高度联动，同涨同跌）' : r > 0.5 ? '中等正相关' : r > 0.2 ? '弱正相关' : r > -0.2 ? '基本不相关（可作分散配置）' : r > -0.5 ? '弱负相关' : '强负相关（走势相反）'
      return { result: `${a} 与 ${b} 在最近 ${n} 根 ${interval} 收盘价上的 Pearson 相关系数为 ${r.toFixed(3)}：${strength}` }
    }
    case 'calc': {
      const expr = typeof args.expression === 'string' ? args.expression : ''
      if (!expr.trim()) throw new Error('expression 为空')
      const value = safeCalc(expr)
      return { result: `${expr.trim()} = ${value}` }
    }
    case 'render_chart': {
      const chartType = args.chart_type === 'bar' ? 'bar' : 'kline'
      if (chartType === 'kline') {
        const symbol = normSymbol(args.symbol)
        if (!SYMBOL_RE.test(symbol)) throw new Error('kline 图需要合法的 symbol')
        const interval = pickInterval(args.interval, '1h')
        const limit = pickInt(args.limit, 30, 300, 120)
        const s = await fetchKlines(symbol, interval, limit)
        const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 60) : `${symbol} · ${interval}`
        const ret = ((s.closes[s.closes.length - 1] - s.closes[0]) / s.closes[0]) * 100
        const chart: ChartSpec = {
          type: 'kline',
          title,
          times: s.times,
          ohlc: s.ohlc.map((k) => [+k[0].toFixed(8), +k[1].toFixed(8), +k[2].toFixed(8), +k[3].toFixed(8)]),
          volumes: s.volumes.map((v) => +v.toFixed(4)),
        }
        return {
          result: `已生成 ${title} 蜡烛图（${s.times.length} 根，含成交量）并展示给用户。数据要点：区间涨跌 ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%，首 ${s.closes[0]} 末 ${s.closes[s.closes.length - 1]}。请基于此图给出简短解读。`,
          chart,
        }
      }
      // bar：涨跌榜
      const direction = args.direction === 'losers' ? 'losers' : 'gainers'
      const limit = pickInt(args.limit, 5, 12, 8)
      const sorted = [...topUsdtTickers(150)].sort((a, b) => parseFloat(b.P) - parseFloat(a.P))
      const list = direction === 'gainers' ? sorted.slice(0, limit) : sorted.slice(-limit).reverse()
      if (list.length === 0) throw new Error('行情数据尚未就绪')
      const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim().slice(0, 60) : `24h ${direction === 'gainers' ? '涨幅榜' : '跌幅榜'} · 前 ${list.length}`
      const chart: ChartSpec = {
        type: 'bar',
        title,
        labels: list.map((t) => t.s.replace(/USDT$/, '')),
        values: list.map((t) => +parseFloat(t.P).toFixed(2)),
        fmt: 'pct',
      }
      return {
        result: `已生成「${title}」条形图并展示给用户。前三：${list.slice(0, 3).map((t) => `${t.s} ${parseFloat(t.P) >= 0 ? '+' : ''}${parseFloat(t.P).toFixed(2)}%`).join('、')}。请给出简短点评。`,
        chart,
      }
    }
    case 'get_news': {
      const items = await getAiNews()
      if (items.length === 0) return { result: '暂无可用新闻' }
      return {
        result: items.map((n, i) => `${i + 1}. [${n.source}] ${n.title}（${new Date(n.publishedAt).toLocaleString('zh-CN', { hour12: false })}）\n   ${n.url}`).join('\n'),
      }
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}

// ---------------------------------------------------------------------------
// 编排：多轮工具循环（流式输出全程保留）
// ---------------------------------------------------------------------------

const TOOL_ROUNDS_MAX = 4

/** 把图表以 ```chart 代码块写入流（前端渲染为图表卡片；不经过模型转述） */
function chartBlock(spec: ChartSpec): string {
  return `\n\`\`\`chart\n${JSON.stringify(spec)}\n\`\`\`\n\n`
}

/**
 * 带工具的对话编排：模型请求工具 → 本地执行 → 结果回填 → 模型继续，
 * 最多 TOOL_ROUNDS_MAX 轮；文本全程流式转发，图表块在生成时立即写入流。
 * 返回完整回复文本（含 chart 代码块，持久化后由前端渲染）。
 */
export async function runToolLoop(
  profile: AiProfile,
  history: ChatMessage[],
  onDelta: (delta: string) => void,
  operator?: string,
  memories?: string,
): Promise<string> {
  const toolsEnabled = profile.enableTools !== false
  const systemContent = [buildSystemPrompt(profile, memories)]
  if (toolsEnabled) systemContent.push(TOOL_SYSTEM_HINT)
  const messages: Record<string, unknown>[] = [
    { role: 'system', content: systemContent.join('\n\n') },
    ...history.slice(-20),
  ]
  const startedAt = Date.now()
  let ttft = 0
  let full = ''
  let toolCallsTotal = 0
  log.info('ai', 'AI 对话开始', kv({ 用户: operator, 模型: profile.model, 消息数: history.length, 工具: toolsEnabled ? '开' : '关' }))
  const emit = (t: string): void => {
    if (!ttft) ttft = Date.now() - startedAt
    full += t
    onDelta(t)
  }

  for (let round = 0; round <= TOOL_ROUNDS_MAX; round++) {
    // streamChatOnce 内部已把文本 delta 即时转发（emit）；这里不再重发 content
    const res = await streamChatOnce(
      profile,
      messages,
      emit,
      toolsEnabled ? (AI_TOOLS_SCHEMA as unknown as unknown[]) : undefined,
    )
    if (res.toolCalls.length === 0 || round === TOOL_ROUNDS_MAX) break

    // 回填 assistant(tool_calls)，执行每个工具并把结果作为 tool 消息追加
    const calls = res.toolCalls.map((c, i) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      name: c.name,
      arguments: c.arguments || '{}',
    }))
    messages.push({
      role: 'assistant',
      content: res.content || '',
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    })
    for (const call of calls) {
      toolCallsTotal++
      try {
        const toolStartedAt = Date.now()
        const r = await executeAiTool(call.name, call.arguments)
        if (r.chart) emit(chartBlock(r.chart))
        log.info('ai', '工具执行完成', kv({
          用户: operator,
          工具: call.name,
          耗时: fmtMs(Date.now() - toolStartedAt),
          图表: r.chart ? r.chart.title : undefined,
        }))
        messages.push({ role: 'tool', tool_call_id: call.id, content: r.result })
      } catch (err) {
        const msg = (err as Error).message || '执行失败'
        log.warn('ai', '工具执行失败', kv({ 用户: operator, 工具: call.name, 错误: msg }))
        messages.push({ role: 'tool', tool_call_id: call.id, content: `工具执行失败：${msg}` })
      }
    }
  }

  log.info('ai', 'AI 对话完成', kv({
    用户: operator,
    模型: profile.model,
    耗时: fmtMs(Date.now() - startedAt),
    首字延迟: ttft ? fmtMs(ttft) : '?',
    工具调用: toolCallsTotal || undefined,
    回复长度: `${full.length} 字`,
  }))
  return full
}

// ---------------------------------------------------------------------------
// 斜杠命令（/cmd 参数）：用户显式触发的能力入口——本地直接执行，不调用
// 大模型、不占每日对话配额；结果（含图表）与普通消息一样落入会话历史。
// ---------------------------------------------------------------------------

export interface SlashCommandResult {
  reply: string
  chart?: ChartSpec
}

interface BadRequestError extends Error {
  statusCode: number
}
function badRequest(msg: string): BadRequestError {
  return Object.assign(new Error(msg), { statusCode: 400 })
}

/** 命令别名归一 */
const SLASH_ALIASES: Record<string, string> = {
  chart: 'chart',
  kline: 'chart',
  analyze: 'analyze',
  ana: 'analyze',
  movers: 'movers',
  rank: 'movers',
  corr: 'corr',
  correlation: 'corr',
  calc: 'calc',
  news: 'news',
  remember: 'remember',
  forget: 'forget',
  mem: 'mem',
  memories: 'mem',
}

/** symbol 智能补全：SOL → SOLUSDT（短代码补 USDT 后再按全名格式校验） */
function resolveSymbol(input: string): string {
  const raw = normSymbol(input)
  if (!raw) throw badRequest('缺少交易对（例：/chart SOL 1h）')
  const candidate = tickerCache.has(raw) ? raw : `${raw}USDT`
  if (!SYMBOL_RE.test(candidate)) throw badRequest(`交易对「${raw}」格式不合法（例：SOL 或 SOLUSDT）`)
  return candidate
}

/**
 * 执行一条斜杠命令。数据类命令复用 AI 工具执行器（同一套数据源与统计），
 * 记忆类命令直接操作长期记忆存储。
 */
export async function runSlashCommand(username: string, text: string): Promise<SlashCommandResult> {
  const m = text.trim().match(/^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/)
  if (!m) throw badRequest('命令格式：/命令 参数（输入 / 可查看全部命令）')
  const cmd = SLASH_ALIASES[m[1].toLowerCase()]
  if (!cmd) throw badRequest(`未知命令 /${m[1]}（输入 / 可查看全部命令）`)
  const args = (m[2] ?? '').trim()
  switch (cmd) {
    case 'chart': {
      const parts = args.split(/\s+/)
      const r = await executeAiTool(
        'render_chart',
        JSON.stringify({
          chart_type: 'kline',
          symbol: resolveSymbol(parts[0] ?? ''),
          interval: pickInterval(parts[1], '1h'),
          limit: parts[2] ? pickInt(parts[2], 30, 300, 120) : 120,
        }),
      )
      const summary = r.result
        .replace(/并展示给用户。/, '')
        .replace(/请基于此图给出简短解读。?/, '')
        .trim()
      return {
        reply: `📊 ${summary}\n\n> 想要 AI 解读？直接用自然语言继续提问即可（如「解读一下这张图」）`,
        chart: r.chart,
      }
    }
    case 'analyze': {
      const parts = args.split(/\s+/)
      const r = await executeAiTool(
        'analyze_klines',
        JSON.stringify({
          symbol: resolveSymbol(parts[0] ?? ''),
          interval: pickInterval(parts[1], '1h'),
          limit: parts[2] ? pickInt(parts[2], 30, 300, 100) : 100,
        }),
      )
      return { reply: `📊 ${r.result}` }
    }
    case 'movers': {
      const direction = /跌|down|loser/i.test(args) ? 'losers' : 'gainers'
      const limit = (args.match(/\d+/) ?? [])[0]
      const n = limit ? pickInt(limit, 5, 12, 8) : 8
      const bar = await executeAiTool('render_chart', JSON.stringify({ chart_type: 'bar', direction, limit: n }))
      const summary = bar.result.replace(/并展示给用户。/, '').replace(/请给出简短点评。?/, '').trim()
      return { reply: `📊 ${summary}\n\n> 想要 AI 点评？继续用自然语言提问即可`, chart: bar.chart }
    }
    case 'corr': {
      const parts = args.split(/\s+/)
      if (parts.length < 2) throw badRequest('用法：/corr 币A 币B [周期]，如 /corr BTC ETH 1d')
      const r = await executeAiTool(
        'correlation',
        JSON.stringify({
          symbol_a: resolveSymbol(parts[0]),
          symbol_b: resolveSymbol(parts[1]),
          interval: pickInterval(parts[2], '1h'),
        }),
      )
      return { reply: `📊 ${r.result}` }
    }
    case 'calc': {
      if (!args) throw badRequest('用法：/calc 算式，如 /calc 10000*3% 或 /calc (90000-85000)/85000*100')
      const r = await executeAiTool('calc', JSON.stringify({ expression: args }))
      return { reply: `🧮 ${r.result}` }
    }
    case 'news': {
      const r = await executeAiTool('get_news', '{}')
      return { reply: `📰 最新要闻\n\n${r.result}` }
    }
    case 'remember': {
      if (!args) throw badRequest('用法：/remember 要记住的内容，如 /remember 我的止损纪律是单笔 2%')
      const item = addManualMemory(username, args)
      return { reply: `✅ 已记入长期记忆（跨会话生效，可用 /forget 删除）：\n\n- ${item.content}` }
    }
    case 'forget': {
      if (!args || args.toLowerCase() === 'all' || args === '全部') {
        const n = clearMemories(username)
        return { reply: n > 0 ? `🗑️ 已清空全部长期记忆（${n} 条）` : '当前没有长期记忆' }
      }
      const n = deleteMemoriesByKeyword(username, args)
      return { reply: n > 0 ? `🗑️ 已删除 ${n} 条含「${args}」的记忆` : `没有找到含「${args}」的记忆`
      }
    }
    case 'mem': {
      const list = listMemories(username)
      if (list.length === 0) return { reply: '还没有长期记忆——多聊几句，或用 /remember 手动添加' }
      return {
        reply: `🧠 我的长期记忆（${list.length} 条，跨会话生效）\n\n${list
          .map((x) => `- [${MEMORY_KINDS[x.kind] ?? x.kind}] ${x.content}`)
          .join('\n')}\n\n> 可在「记忆」面板编辑或删除，或用 /forget 关键词 删除`,
      }
    }
    default:
      throw badRequest('未知命令')
  }
}
