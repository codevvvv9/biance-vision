import type { ReactNode } from 'react'
import styles from './legacy.module.css'
/** Explicit migration boundary; new components must use Ant Design/CSS Modules. */
export function LegacyBoundary({ children }: { children: ReactNode }): JSX.Element {
  return <div className={styles.legacy}>{children}</div>
}
