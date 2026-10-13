/**
 * /api/market/* 请求/响应契约。
 * 对应 docs/specs/market-data.md 与 docs/specs/api-storage.md；
 * 响应中的 K 线使用 shared/src/market.ts 的 CandleRow 序列化形态。
 */

import { z } from 'zod'
import {
  CandleRowSchema,
  DataQualitySchema,
  DecimalStringSchema,
  IntervalSchema,
  MarketTypeSchema,
  PriceTypeSchema,
  SnapshotRefSchema,
  SymbolSchema,
} from '../market.js'

/** GET /api/market/candles 查询参数；带 asOf 时只返回当时已收盘数据 */
export const GetCandlesQuerySchema = z.object({
  marketType: MarketTypeSchema,
  priceType: PriceTypeSchema,
  symbol: SymbolSchema,
  interval: IntervalSchema,
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  asOf: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(1500).default(500),
})
export type GetCandlesQuery = z.infer<typeof GetCandlesQuerySchema>

export const GetCandlesResponseSchema = z.object({
  candles: z.array(CandleRowSchema),
})
export type GetCandlesResponse = z.infer<typeof GetCandlesResponseSchema>

/** GET /api/market/snapshot 查询参数 */
export const GetSnapshotQuerySchema = z.object({
  symbol: SymbolSchema,
  marketType: MarketTypeSchema,
  asOf: z.coerce.number().int(),
})
export type GetSnapshotQuery = z.infer<typeof GetSnapshotQuerySchema>

export const GetSnapshotResponseSchema = z.object({
  snapshot: SnapshotRefSchema,
})
export type GetSnapshotResponse = z.infer<typeof GetSnapshotResponseSchema>

/** GET /api/market/funding 查询参数（仅 usdm_perp） */
export const GetFundingQuerySchema = z.object({
  symbol: SymbolSchema,
  limit: z.coerce.number().int().min(1).max(1000).default(100),
})
export type GetFundingQuery = z.infer<typeof GetFundingQuerySchema>

/** 单次资金费率记录（独立数据，不得从 OHLC 推断） */
export const FundingRateSchema = z.object({
  symbol: SymbolSchema,
  fundingRate: DecimalStringSchema,
  fundingTime: z.number().int(),
  markPrice: DecimalStringSchema.nullable(),
})
export type FundingRate = z.infer<typeof FundingRateSchema>

export const GetFundingResponseSchema = z.object({
  funding: z.array(FundingRateSchema),
})
export type GetFundingResponse = z.infer<typeof GetFundingResponseSchema>

/** GET /api/market/open-interest 查询参数（仅 usdm_perp） */
export const GetOpenInterestQuerySchema = z.object({
  symbol: SymbolSchema,
  interval: IntervalSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
})
export type GetOpenInterestQuery = z.infer<typeof GetOpenInterestQuerySchema>

export const OpenInterestSchema = z.object({
  symbol: SymbolSchema,
  openInterest: DecimalStringSchema,
  openInterestValue: DecimalStringSchema.nullable(),
  time: z.number().int(),
})
export type OpenInterest = z.infer<typeof OpenInterestSchema>

export const GetOpenInterestResponseSchema = z.object({
  openInterest: z.array(OpenInterestSchema),
})
export type GetOpenInterestResponse = z.infer<typeof GetOpenInterestResponseSchema>

/** GET /api/market/symbols 查询参数（spot/usdm_perp 分别返回） */
export const MarketSymbolsQuerySchema = z.object({
  marketType: MarketTypeSchema,
})
export type MarketSymbolsQuery = z.infer<typeof MarketSymbolsQuerySchema>

export const MarketSymbolsResponseSchema = z.object({
  symbols: z.array(SymbolSchema),
})
export type MarketSymbolsResponse = z.infer<typeof MarketSymbolsResponseSchema>

/** GET /api/market/quality 响应：各序列缺口/延迟/修订统计 */
export const GetQualityResponseSchema = z.object({
  items: z.array(DataQualitySchema),
})
export type GetQualityResponse = z.infer<typeof GetQualityResponseSchema>
