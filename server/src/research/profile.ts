/**
 * 用户画像存取（P1-4，vertical-agent-architecture.md §4.D 第一层）：
 * 长期研究偏好，独立 PG 表（trader_profiles，红线 #6：不挂 users JSON 镜像）。
 * run 创建时 loadTraderProfile 快照进 frozenConfig.raw.traderProfile（store.freezeRunConfig）；
 * GET/PATCH /api/users/me/profile 用户自改；admin 可代改（PUT /api/admin/users/:username/profile）。
 * leverageHabitMax 为描述性字段（历史习惯），不作为授权上限——接口注释与前端文案均须明示。
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../db.js'
import { traderProfiles } from '../models.js'
import type { TraderProfile } from 'biance-vision-brooks'

export interface TraderProfilePatch {
  riskProfile?: 'conservative' | 'balanced' | 'aggressive' | null
  experienceLevel?: 'novice' | 'intermediate' | 'pro' | null
  leverageHabitMax?: number | null
  disclaimerAck?: boolean
}

function rowToProfile(row: typeof traderProfiles.$inferSelect | undefined): TraderProfile | null {
  if (row === undefined) return null
  return {
    riskProfile:
      row.riskProfile === 'conservative' || row.riskProfile === 'balanced' || row.riskProfile === 'aggressive' ? row.riskProfile : null,
    experienceLevel: row.experienceLevel === 'novice' || row.experienceLevel === 'intermediate' || row.experienceLevel === 'pro' ? row.experienceLevel : null,
    leverageHabitMax: row.leverageHabitMax ?? null,
    disclaimerAck: row.disclaimerAck,
    confirmedAt: row.confirmedAt ?? null,
  }
}

export async function loadTraderProfile(userId: string): Promise<TraderProfile | null> {
  const rows = await getDb()!.select().from(traderProfiles).where(eq(traderProfiles.userId, userId)).limit(1)
  return rowToProfile(rows[0])
}

/** 写画像（upsert）：任何字段变更即视为一次用户确认（confirmedAt=now） */
export async function saveTraderProfile(userId: string, patch: TraderProfilePatch): Promise<TraderProfile> {
  const db = getDb()!
  const existing = rowToProfile((await db.select().from(traderProfiles).where(eq(traderProfiles.userId, userId)).limit(1))[0])
  const next: TraderProfile = {
    riskProfile: patch.riskProfile !== undefined ? patch.riskProfile : existing?.riskProfile ?? null,
    experienceLevel: patch.experienceLevel !== undefined ? patch.experienceLevel : existing?.experienceLevel ?? null,
    leverageHabitMax: patch.leverageHabitMax !== undefined ? patch.leverageHabitMax : existing?.leverageHabitMax ?? null,
    disclaimerAck: patch.disclaimerAck !== undefined ? patch.disclaimerAck : existing?.disclaimerAck ?? false,
    confirmedAt: Date.now(),
  }
  await db
    .insert(traderProfiles)
    .values({
      userId,
      riskProfile: next.riskProfile,
      experienceLevel: next.experienceLevel,
      leverageHabitMax: next.leverageHabitMax,
      disclaimerAck: next.disclaimerAck,
      confirmedAt: next.confirmedAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: traderProfiles.userId,
      set: {
        riskProfile: next.riskProfile,
        experienceLevel: next.experienceLevel,
        leverageHabitMax: next.leverageHabitMax,
        disclaimerAck: next.disclaimerAck,
        confirmedAt: next.confirmedAt,
        updatedAt: new Date(),
      },
    })
  return next
}

/** 画像单行摘要（{{traderProfile}} 占位符注入文本；空画像返回 ''） */
export function traderProfileLine(p: TraderProfile | null): string {
  if (p === null) return ''
  const parts: string[] = []
  if (p.riskProfile !== null) parts.push(`风险偏好=${p.riskProfile}`)
  if (p.experienceLevel !== null) parts.push(`经验=${p.experienceLevel}`)
  if (p.leverageHabitMax !== null) parts.push(`历史杠杆习惯≤${p.leverageHabitMax}（描述性，非授权上限）`)
  return parts.length > 0 ? `用户画像：${parts.join('，')}。` : ''
}
