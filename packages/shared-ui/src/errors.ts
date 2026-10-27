/**
 * 错误文案单点翻译（错误码 i18n，2026-10-27）：
 * 服务端只发机器错误码（platform-contracts PUBLIC_ERROR_REGISTRY + 各领域业务码），
 * 人类语言只在 errors 词典里说一次。展示出口一律走 apiErrorMessage，四级兜底：
 *   ① 错误码命中 errors:<code>（带 params 插值）→ 按当前 UI 语言出文案
 *   ② 未登记码按 HTTP status 分组文案（errors:_status.<status>）
 *   ③ 原始 message（网络层 Error / 尚未补码的旧接口——过渡期兜底，可能为中文）
 *   ④ common:api.requestFailed（无任何信息时的最终兜底）
 * 注意：t() 前必须 i18n.exists() 判断——i18next v26 对不存在的 key 会回显 key
 * 本身（nonExplicit 坑），不能拿回显当兜底。
 */
import i18n from './i18n'
import { ApiError } from './api'

export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code && i18n.exists(`errors:${err.code}`)) {
      return i18n.t(`errors:${err.code}`, { ...(err.params ?? {}) }) as string
    }
    const byStatus = `errors:_status.${err.status}`
    if (i18n.exists(byStatus)) return i18n.t(byStatus) as string
    if (err.message) return err.message
  }
  if (err instanceof Error && err.message) return err.message
  return i18n.t('common:api.requestFailed') as string
}
