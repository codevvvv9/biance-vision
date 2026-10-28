/**
 * W3-S1 兼容 shim：i18n 初始化与词典已下沉 @biance/shared-ui
 * （packages/shared-ui/src/i18n）。`import './i18n'` 的副作用语义保留：
 * 引用本模块即完成 barrel 加载（含 i18n init）。
 */
import '@biance/shared-ui'
export { i18n as default, currentLocale, contentLocale, websiteLocale, klinechartsLocale, KLINECHARTS_LOCALE, KLINECHARTS_ZH_TW } from '@biance/shared-ui'
export type { AppLocale } from '@biance/shared-ui'
