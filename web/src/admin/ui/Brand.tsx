import { Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import styles from './admin.module.css'
/** Reuse the entry document's brand asset; no copy of Header or W4 SVG. */
export function Brand({ compact = false }: { compact?: boolean }): JSX.Element {
  const { t } = useTranslation('admin')
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href
  return <div className={styles.brand}>{icon && <img src={icon} width={30} height={30} alt="" />}{!compact && <div><strong>BIANCE VISION</strong><Typography.Text type="secondary">{t('layout.title')}</Typography.Text></div>}</div>
}
