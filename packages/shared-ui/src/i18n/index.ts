/**
 * i18n 初始化：词典静态打包（规模可控，无需后端加载器），语言偏好写 localStorage('app-lang')，
 * 与 readUpColor 同模式；main.tsx 在 render 前同步 import 本模块，避免首屏语言闪烁。
 * 新增页面域词典时在 locales/<lang>/ 下加文件并注册进 resources / ns。
 */

import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import commonZh from '../locales/zh-CN/common.json'
import authZh from '../locales/zh-CN/auth.json'
import dashboardZh from '../locales/zh-CN/dashboard.json'
import moversZh from '../locales/zh-CN/movers.json'
import alertsZh from '../locales/zh-CN/alerts.json'
import brooksZh from '../locales/zh-CN/brooks.json'
import researchZh from '../locales/zh-CN/research.json'
import aiZh from '../locales/zh-CN/ai.json'
import adminZh from '../locales/zh-CN/admin.json'
import errorsZh from '../locales/zh-CN/errors.json'
import commonEn from '../locales/en-US/common.json'
import authEn from '../locales/en-US/auth.json'
import dashboardEn from '../locales/en-US/dashboard.json'
import moversEn from '../locales/en-US/movers.json'
import alertsEn from '../locales/en-US/alerts.json'
import brooksEn from '../locales/en-US/brooks.json'
import researchEn from '../locales/en-US/research.json'
import aiEn from '../locales/en-US/ai.json'
import adminEn from '../locales/en-US/admin.json'
import errorsEn from '../locales/en-US/errors.json'

export type AppLocale = 'zh-CN' | 'en-US'

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { common: commonZh, auth: authZh, dashboard: dashboardZh, movers: moversZh, alerts: alertsZh, brooks: brooksZh, research: researchZh, ai: aiZh, admin: adminZh, errors: errorsZh },
      'en-US': { common: commonEn, auth: authEn, dashboard: dashboardEn, movers: moversEn, alerts: alertsEn, brooks: brooksEn, research: researchEn, ai: aiEn, admin: adminEn, errors: errorsEn },
    },
    // 不显式传 lng：显式值会顶掉 LanguageDetector，localStorage 的偏好（app-lang）
    // 刷新后不生效；无存储值时由 fallbackLng 兜底为中文首访默认
    fallbackLng: 'zh-CN',
    // 语言值完全受控（LanguageSwitcher 只写 'zh-CN'/'en-US'，detection 只读 localStorage），
    // 不开 nonExplicitSupportedLngs：v26 的 isSupportedCode 在该开关下会把 'zh-CN' 折成
    // 短码 'zh' 再查 supportedLngs，只注册全称会被判不支持 → 解析层级为空 → 全部 key 回显
    supportedLngs: ['zh-CN', 'en-US'],
    defaultNS: 'common',
    ns: ['common', 'auth', 'dashboard', 'movers', 'alerts', 'brooks', 'research', 'ai', 'admin', 'errors'],
    detection: {
      order: ['localStorage'],
      lookupLocalStorage: 'app-lang',
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false },
    returnNull: false,
  })

function applyHtmlLang(lng: string): void {
  document.documentElement.lang = lng
}
applyHtmlLang(i18n.language || 'zh-CN')
i18n.on('languageChanged', applyHtmlLang)

/** 当前 UI 语言（归一到支持的语言值） */
export function currentLocale(): AppLocale {
  return i18n.language?.startsWith('en') ? 'en-US' : 'zh-CN'
}

/** klinecharts 内置 locale 映射（其 registerLocale 预置 zh-CN / en-US 两个语言包） */
export const KLINECHARTS_LOCALE: Record<AppLocale, string> = {
  'zh-CN': 'zh-CN',
  'en-US': 'en-US',
}

export function klinechartsLocale(): string {
  return KLINECHARTS_LOCALE[currentLocale()]
}

export default i18n
