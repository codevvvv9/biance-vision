/**
 * 会员域基础原语（错误形状 + DB 句柄）：独立于 service.ts，
 * 供 service.ts 与 access.ts 共享且不引入循环依赖（service→access→core）。
 */
import { getDb } from '../db.js'

type Db = NonNullable<ReturnType<typeof getDb>>
export type Executor = Pick<Db, 'execute'>
export const membershipError = (
  message: string,
  statusCode = 400,
  code = 'membership_invalid',
) => Object.assign(new Error(message), { statusCode, code })
export function membershipDb(): Db {
  const db = getDb()
  if (!db)
    throw membershipError(
      '会员服务暂不可用 / Membership unavailable',
      503,
      'membership_unavailable',
    )
  return db
}
