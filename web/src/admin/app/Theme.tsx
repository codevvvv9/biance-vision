import { App, ConfigProvider, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import enUS from 'antd/locale/en_US'
import { useTranslation } from 'react-i18next'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import styles from '../ui/admin.module.css'
/** All overlays and imperative feedback share this app's context. */
export function AdminTheme({ children }: { children: ReactNode }): JSX.Element {
  const { i18n } = useTranslation()
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => { const media = matchMedia('(prefers-reduced-motion: reduce)'); const change = () => setReduced(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change) }, [])
  const tokens = useMemo(() => {
    const css = getComputedStyle(document.documentElement)
    const read = (name: string) => css.getPropertyValue(name).trim()
    return { colorPrimary: read('--cyan'), colorBgBase: read('--bg-0'), colorBgContainer: read('--bg-1'), colorBgElevated: read('--bg-2'), colorText: read('--text'), colorTextSecondary: read('--text-2'), colorBorder: read('--line-2'), colorSuccess: read('--up'), colorError: read('--down'), colorWarning: read('--amber'), fontFamily: read('--sans'), borderRadius: 8, controlHeight: 36, fontSize: 14, motion: !reduced }
  }, [reduced])
  return <ConfigProvider locale={i18n.language.startsWith('zh') ? zhCN : enUS} theme={{ algorithm: theme.darkAlgorithm, token: tokens, components: { Table: { cellPaddingBlock: 13 }, Layout: { headerBg: tokens.colorBgContainer, siderBg: tokens.colorBgContainer }, Button: { primaryColor: 'var(--on-accent)' } } }} getPopupContainer={() => document.getElementById('admin-overlays') ?? document.body}>
    <App className={styles.app}>{children}</App>
  </ConfigProvider>
}
