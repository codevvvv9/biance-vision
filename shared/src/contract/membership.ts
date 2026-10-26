import { z } from 'zod'

export const MembershipFeaturesSchema = z
  .object({ chat: z.boolean(), research: z.boolean(), translate: z.boolean() })
  .strict()
export const MembershipPlanSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    nameEn: z.string().trim().min(1).max(80),
    description: z.string().max(1000),
    descriptionEn: z.string().max(1000),
    durationUnit: z.enum(['day', 'month', 'year', 'lifetime']),
    durationCount: z.number().int().min(1).max(3650),
    price: z.string().regex(/^\d{1,8}(\.\d{1,6})?$/),
    introPrice: z.string().regex(/^\d{1,8}(\.\d{1,6})?$/),
    currency: z.literal('USDT'),
    dailyLimit: z.number().int().min(1).max(100000).nullable(),
    requestsPerMinute: z.number().int().min(1).max(60),
    chatProfile: z.string().regex(/^[\w-]{1,24}$/),
    researchProfile: z.string().regex(/^[\w-]{1,24}$/),
    features: MembershipFeaturesSchema,
    public: z.boolean(),
    sortOrder: z.number().int().min(0).max(10000),
  })
  .strict()
export type MembershipPlan = z.infer<typeof MembershipPlanSchema>
export const MembershipRefreshSchema = z
  .object({
    userSeconds: z.number().int().min(30).max(300),
    adminSeconds: z.number().int().min(30).max(300),
    publicSeconds: z.number().int().min(30).max(300),
  })
  .strict()
export type MembershipRefresh = z.infer<typeof MembershipRefreshSchema> & {
  revision: number
  updatedAt: number
  updatedBy: string
}
export const MembershipGrantInputSchema = z
  .object({
    operationId: z.string().uuid(),
    versionId: z.string().uuid(),
    action: z.enum(['bind', 'renew', 'switch', 'migrate']),
    confirmReplace: z.boolean().default(false),
    useIntro: z.boolean().default(false),
    paidAmount: z.string().regex(/^\d{1,8}(\.\d{1,6})?$/),
    paidAt: z.number().int().positive(),
    paymentReference: z.string().trim().max(200),
    note: z.string().trim().max(1000),
  })
  .strict()
export type MembershipGrantInput = z.infer<typeof MembershipGrantInputSchema>
export interface MembershipPeriod {
  id: string
  planId: string
  versionId: string
  revision: number
  name: string
  nameEn: string
  startsAt: number
  endsAt: number | null
  dailyLimit: number | null
  requestsPerMinute: number
  features: z.infer<typeof MembershipFeaturesSchema>
}
export interface MembershipStatus {
  legacyAccess?: { totalLimit: number; used: number; remaining: number }
  managed: boolean
  status: 'legacy' | 'trial' | 'active' | 'expired' | 'disabled'
  current: MembershipPeriod | null
  upcoming: MembershipPeriod[]
  usedToday: number
  remainingToday: number | null
  nextResetAt: number
  serverTime: number
  refresh: { userSeconds: number; revision: number; adminSeconds?: number }
  contacts: { telegram: string; email: string }
}
export interface MembershipPlanRecord {
  id: string
  draft: MembershipPlan
  revision: number
  publishedVersionId: string | null
  enabled: boolean
  versions: {
    id: string
    revision: number
    config: MembershipPlan
    createdAt: number
  }[]
}
export interface MembershipCampaign {
  id: string
  name: string
  enabled: boolean
  capacity: number
  used: number
  remaining: number
  startsAt: number | null
  endsAt: number | null
  revision: number
}
export interface PublicMembershipCatalog {
  plans: {
    id: string
    versionId: string
    revision: number
    name: string
    nameEn: string
    description: string
    descriptionEn: string
    durationUnit: MembershipPlan['durationUnit']
    durationCount: number
    price: string
    introPrice: string
    currency: 'USDT'
    dailyLimit: number | null
    features: MembershipPlan['features']
  }[]
  campaign: MembershipCampaign | null
  refreshSeconds: number
  serverTime: number
}
