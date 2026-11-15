/**
 * 标的注册表（单一数据源）：预置标的的资产类别、数据源归属与多语言显示名。
 * 新增标的 = 注册表加一条；采集清单（watchlist）、前端候选列表、股票判定、
 * 图表显示名全部从这里派生，禁止在消费方散点硬编码。
 * 加密货币候选的其余部分（交易所全量交易对）由 provider 动态发现，注册表只登记预置项。
 */

export type AssetClass = 'crypto' | 'stock'

/** 显示名 locale 键（与 shared SIGNAL_MESSAGES 的语言键风格一致） */
export type InstrumentLocale = 'zh-CN' | 'zh-TW' | 'en-US'

/** 显示名字段（跟随注册表走，不进 i18n json） */
export interface InstrumentNames extends Record<InstrumentLocale, string> {}

export interface InstrumentDef {
  symbol: string
  assetClass: AssetClass
  /** 数据源归属（决定 provider 路由） */
  venue: 'binance' | 'yahoo'
  /** 采集/查询所用市场类型：加密货币采集走 spot 序列；证券专用 stock */
  marketType: 'spot' | 'stock'
  /** 证券类必填显示名；加密货币缺省（图表按惯例去 USDT 后缀展示） */
  names?: InstrumentNames
}

/**
 * 预置标的清单。
 * 证券说明：DXYZ（Destiny Tech100）为重仓 SpaceX 的封闭式基金——SpaceX 未上市、
 * 无公开行情，以 DXYZ 作为公开可交易的 SpaceX 概念代理，UI 展示须带「概念基金」标注。
 */
export const PRESET_INSTRUMENTS: readonly InstrumentDef[] = [
  { symbol: 'BTCUSDT', assetClass: 'crypto', venue: 'binance', marketType: 'spot' },
  { symbol: 'ETHUSDT', assetClass: 'crypto', venue: 'binance', marketType: 'spot' },
  { symbol: 'SOLUSDT', assetClass: 'crypto', venue: 'binance', marketType: 'spot' },
  {
    symbol: 'TSLA', assetClass: 'stock', venue: 'yahoo', marketType: 'stock',
    names: { 'zh-CN': '特斯拉', 'zh-TW': '特斯拉', 'en-US': 'Tesla' },
  },
  {
    symbol: 'DXYZ', assetClass: 'stock', venue: 'yahoo', marketType: 'stock',
    names: { 'zh-CN': 'SpaceX 概念基金', 'zh-TW': 'SpaceX 概念基金', 'en-US': 'SpaceX proxy fund' },
  },
  {
    symbol: '005930.KS', assetClass: 'stock', venue: 'yahoo', marketType: 'stock',
    names: { 'zh-CN': '三星电子', 'zh-TW': '三星電子', 'en-US': 'Samsung Electronics' },
  },
  {
    symbol: '000660.KS', assetClass: 'stock', venue: 'yahoo', marketType: 'stock',
    names: { 'zh-CN': 'SK 海力士', 'zh-TW': 'SK 海力士', 'en-US': 'SK Hynix' },
  },
]

/** 预置加密货币采集/候选清单（watchlist 与前端兜底列表从这里派生） */
export const PRESET_CRYPTO_SYMBOLS: readonly string[] = PRESET_INSTRUMENTS
  .filter((i) => i.assetClass === 'crypto')
  .map((i) => i.symbol)

/** 证券标的注册清单（采集序列、前端候选、股票判定从这里派生） */
export const STOCK_INSTRUMENTS: readonly InstrumentDef[] = PRESET_INSTRUMENTS.filter(
  (i): i is InstrumentDef & { assetClass: 'stock'; names: InstrumentNames } =>
    i.assetClass === 'stock' && i.names !== undefined,
)

export const STOCK_SYMBOLS: readonly string[] = STOCK_INSTRUMENTS.map((i) => i.symbol)

/** 证券可采周期（Yahoo 原生无 10m/4h：10m 由 5m 聚合，4h 不采集） */
export const STOCK_INTERVALS = ['1m', '5m', '10m', '15m', '1h', '1d'] as const

/** 是否为注册表内的证券标的（数据路由/研究门禁的判定单点） */
export function isStockSymbol(symbol: string): boolean {
  return STOCK_SYMBOLS.includes(symbol.toUpperCase())
}

/** 注册表查询（未注册返回 null） */
export function instrumentOf(symbol: string): InstrumentDef | null {
  const s = symbol.toUpperCase()
  return PRESET_INSTRUMENTS.find((i) => i.symbol === s) ?? null
}

/** 展示名：证券取注册表多语言名；加密货币去 USDT 后缀；未注册标的原样返回 */
export function displayName(symbol: string, locale: InstrumentLocale): string {
  const def = instrumentOf(symbol)
  if (def?.names) return def.names[locale]
  return symbol.toUpperCase().replace('USDT', '')
}
