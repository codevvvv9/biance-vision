import { Tabs } from 'antd'
import { useSearchParams } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useAdminText } from './text'
export function useAdminView(keys: readonly string[]): [string, (key: string) => void] {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') ?? ''
  return [keys.includes(view) ? view : keys[0], key => setParams(prev => { const next = new URLSearchParams(prev); next.set('view', key); return next })]
}
export function AdminViews({ items }: { items: { key: string; label: string; children: ReactNode }[] }): JSX.Element {
  const text = useAdminText()
  const [activeKey, onChange] = useAdminView(items.map(item => item.key))
  return <Tabs activeKey={activeKey} onChange={onChange} destroyOnHidden items={items.map(item => ({ ...item, label: text(item.label) }))} />
}
