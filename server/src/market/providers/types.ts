/**
 * 行情提供者接口：新增交易所/市场 = 新增一个实现并注册进 registry.ts。
 * 返回数据必须符合 shared 契约（CandleRow 等），边界处统一做 zod 校验。
 */
import type { CandleRow, FundingRate, Interval, MarketType, OpenInterest, PriceType } from 'biance-vision-brooks'

export interface FetchKlinesParams {
  priceType: PriceType
  symbol: string
  interval: Interval
  /** UTC 毫秒（含）；缺省拉取最新 limit 根 */
  startTime?: number
  /** UTC 毫秒（含） */
  endTime?: number
  limit?: number
}

export interface FetchFundingParams {
  symbol: string
  startTime?: number
  limit?: number
}

export interface FetchOpenInterestParams {
  symbol: string
  /** Binance period 粒度（5m/15m/30m/1h/2h/4h/6h/12h/1d），与 Interval 子集对齐 */
  interval: Interval
  limit?: number
}

export interface MarketDataProvider {
  readonly marketType: MarketType
  /** 拉取 K 线（含未收盘尾根，由调用方按 closeTime 过滤）；指数类成交量的占位值已归一化为 null */
  fetchKlines(params: FetchKlinesParams): Promise<CandleRow[]>
  /** 资金费率历史（仅永续 provider 实现） */
  fetchFundingRates?(params: FetchFundingParams): Promise<FundingRate[]>
  /** 持仓量 OI 历史（仅永续 provider 实现） */
  fetchOpenInterest?(params: FetchOpenInterestParams): Promise<OpenInterest[]>
  /** 实时价（快照 priceAsOf 用）；失败返回 null */
  fetchPrice?(symbol: string): Promise<{ price: string; time: number } | null>
  /** 该市场可采集的交易对列表 */
  listSymbols(): Promise<string[]>
}
