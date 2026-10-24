import { Alert, Empty, Spin } from 'antd'
import type { ReactNode } from 'react'
import styles from './admin.module.css'
export function Feedback({ error, success }: { error?: string; success?: string }): JSX.Element {
  return <>{error && <Alert type="error" title={error} showIcon role="alert" />}{success && <Alert type="success" title={success} showIcon role="status" />}</>
}
export function Loading(): JSX.Element { return <div className={styles.loading}><Spin size="large" /></div> }
export function EmptyState({ children }: { children: ReactNode }): JSX.Element { return <Empty description={children} /> }
