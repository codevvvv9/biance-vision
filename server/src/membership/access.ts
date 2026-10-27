/**
 * 会员功能级访问判定（单一来源，docs/specs/membership.md）：判定用户「此刻」能否使用某项能力。
 * 消费方：membershipStatus()（前端 access 字段）、research 路由 preHandler、createRun 用户路径兜底。
 *
 * 语义边界：
 * - 权限与额度分离：本模块只判「能不能用」；每日次数/限速由 meter 与 aiAccess 既有逻辑负责。
 * - 纳管账号（membership_accounts 有行）不回退 legacy 残留额度——到期/停用即拒绝，
 *   授权按不可变的 plan_versions 绑定版本 features 判（草稿/发布/下架不影响存量授权）。
 * - 未纳管账号：显式配置过 app_settings ai_access:<username> 的老用户保留（legacy）；
 *   停用统一看 users.chat_policy.disabled（aiAccess 本身无 disabled 字段）。
 * - DB 不可用：受控 503（membership_unavailable），不降级为 403、不回显底层错误——
 *   「服务不可用」绝不能被解释成「没有权限」。
 */
import { sql } from 'drizzle-orm'
import { MembershipPlanSchema } from 'biance-vision-brooks'
import type { MembershipFeatureAccess } from 'biance-vision-brooks'
import { membershipDb, membershipError, type Executor } from './core.js'

export type MembershipFeature = 'chat' | 'research' | 'translate'

interface AccessRow {
  managed: boolean
  membership_disabled: boolean | null
  chat_policy: { disabled?: boolean } | null
  grant_id: string | null
  config: unknown
}

async function queryAccessRow(
  username: string,
  now: number,
  ex: Executor,
): Promise<AccessRow | undefined> {
  try {
    const rows = await ex.execute(sql`
      SELECT a.username IS NOT NULL AS managed, a.disabled AS membership_disabled,
             u.chat_policy,
             g.id AS grant_id, v.config
      FROM users u
      LEFT JOIN membership_accounts a ON a.username = u.username
      LEFT JOIN LATERAL (
        SELECT * FROM membership_grants
        WHERE username = u.username AND revoked_at IS NULL
          AND starts_at <= ${new Date(now).toISOString()}
          AND (ends_at IS NULL OR ends_at > ${new Date(now).toISOString()})
        ORDER BY starts_at DESC LIMIT 1
      ) g ON true
      LEFT JOIN membership_plan_versions v ON v.id = g.version_id
      WHERE u.username = ${username}`)
    return rows[0] as unknown as AccessRow | undefined
  } catch {
    // 查询失败（连接中断/库不可用等）一律视为服务不可用；编程错误会在 check/CI 阶段暴露
    throw membershipError(
      '会员服务暂不可用 / Membership unavailable',
      503,
      'membership_unavailable',
    )
  }
}

async function legacyAiAccessExists(username: string, ex: Executor): Promise<boolean> {
  try {
    const rows = await ex.execute(
      sql`SELECT 1 FROM app_settings WHERE key = ${`ai_access:${username}`} LIMIT 1`,
    )
    return rows.length > 0
  } catch {
    throw membershipError(
      '会员服务暂不可用 / Membership unavailable',
      503,
      'membership_unavailable',
    )
  }
}

const denied = (
  reason: NonNullable<MembershipFeatureAccess['reason']>,
): MembershipFeatureAccess => ({ allowed: false, source: null, reason })

export async function featureAccess(
  username: string,
  feature: MembershipFeature,
  now = Date.now(),
  ex: Executor = membershipDb(),
): Promise<MembershipFeatureAccess> {
  const row = await queryAccessRow(username, now, ex)
  if (!row) return denied('no_access')
  const chatDisabled = row.chat_policy?.disabled === true
  if (row.managed) {
    if (row.membership_disabled === true || chatDisabled) return denied('disabled')
    if (!row.grant_id) {
      // 纳管但无进行中授权：曾有授权（已到期/仅未来生效）与从未授权分开归因
      try {
        const [any] = await ex.execute(
          sql`SELECT 1 FROM membership_grants WHERE username = ${username} AND revoked_at IS NULL LIMIT 1`,
        )
        return denied(any ? 'expired' : 'no_grant')
      } catch {
        throw membershipError(
          '会员服务暂不可用 / Membership unavailable',
          503,
          'membership_unavailable',
        )
      }
    }
    const plan = MembershipPlanSchema.parse(row.config)
    return plan.features[feature]
      ? { allowed: true, source: 'membership', reason: null }
      : denied('plan_feature')
  }
  if (chatDisabled) return denied('disabled')
  const legacy = await legacyAiAccessExists(username, ex)
  return legacy ? { allowed: true, source: 'legacy', reason: null } : denied('no_access')
}

/** 拒绝原因 → 既有会员错误码（与 meter 口径对齐）；仅「无任何授权」用新码。 */
const DENIAL_ERRORS: Record<
  NonNullable<MembershipFeatureAccess['reason']>,
  [message: string, code: string]
> = {
  disabled: ['会员 AI 访问已停用 / Membership disabled', 'membership_disabled'],
  expired: ['会员已到期，请联系管理员续费 / Membership expired', 'membership_expired'],
  no_grant: ['会员已到期，请联系管理员续费 / Membership expired', 'membership_expired'],
  plan_feature: ['套餐未包含此功能 / Feature unavailable', 'membership_feature_unavailable'],
  no_access: [
    '研究能力需要会员或内部账号 / Research access requires a membership or internal account',
    'research_access_required',
  ],
}

export async function assertFeatureAccess(
  username: string,
  feature: MembershipFeature,
  now = Date.now(),
  ex?: Executor,
): Promise<void> {
  const access = await featureAccess(username, feature, now, ex)
  if (access.allowed) return
  const [message, code] = DENIAL_ERRORS[access.reason ?? 'no_access']
  throw membershipError(message, 403, code)
}

export const assertResearchAccess = (username: string, now?: number, ex?: Executor) =>
  assertFeatureAccess(username, 'research', now, ex)
