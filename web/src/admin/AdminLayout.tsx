import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Avatar, Button, Drawer, Grid, Layout, Menu, Space, Tag, Tooltip, Typography } from 'antd'
import { MenuFoldOutlined, MenuUnfoldOutlined, LogoutOutlined, SettingOutlined, UserOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Brand } from './ui/Brand'
import { Language } from './ui/Language'
import { useAdminText } from './ui/text'
import styles from './ui/admin.module.css'
export interface AdminNavigationItem { id: string; href: string; label: string; hint: string; icon: ReactNode }
interface Props { navigation: AdminNavigationItem[]; selected: string; title: string; hint: string; username: string; onLogout: () => void; onAiSettings: () => void; children: ReactNode }
/** Presentation only: no page registry, authentication, or business requests. */
export default function AdminShell({ navigation, selected, title, hint, username, onLogout, onAiSettings, children }: Props): JSX.Element {
  const screens = Grid.useBreakpoint()
  const mobile = !screens.md
  const [collapsed, setCollapsed] = useState(false)
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLElement | null>(null)
  const { t } = useTranslation('admin')
  const text = useAdminText()
  useEffect(() => setCollapsed(!screens.xl), [screens.xl])
  const compact = collapsed && !mobile
  const menu = <Menu mode="inline" selectedKeys={[selected]} inlineCollapsed={compact} onClick={() => setOpen(false)} items={navigation.map(item => ({ key: item.id, icon: item.icon, title: item.hint, label: <Link to={item.href}>{item.label}</Link> }))} />
  const foot = <div className={styles.sideFoot}><Tooltip title={text('aiSettings')} placement="right"><Button block aria-label={text('aiSettings')} icon={<SettingOutlined />} onClick={onAiSettings}>{!compact && text('aiSettings')}</Button></Tooltip><div className={styles.user}><Avatar size={30} icon={<UserOutlined />} />{!compact && <div><Typography.Text ellipsis>{username}</Typography.Text><Tag>{text('superadmin')}</Tag></div>}</div><Tooltip title={t('gate.logout')} placement="right"><Button block aria-label={t('gate.logout')} icon={<LogoutOutlined />} onClick={onLogout}>{!compact && t('gate.logout')}</Button></Tooltip></div>
  const side = <div className={styles.sideInner}><Brand compact={compact} /><nav aria-label={text('navigation')}>{menu}</nav>{foot}</div>
  return <Layout className={styles.shell}>
    {!mobile && <Layout.Sider width={240} collapsedWidth={64} collapsed={collapsed} className={styles.side}>{side}</Layout.Sider>}
    <Drawer afterOpenChange={visible => { if (!visible) toggleRef.current?.focus() }} title={<Brand />} placement="left" size={280} open={mobile && open} onClose={() => setOpen(false)} styles={{ body: { padding: 0 } }}><div className={styles.sideInner}><nav aria-label={text('navigation')}>{menu}</nav>{foot}</div></Drawer>
    <Layout className={styles.main}><Layout.Header className={styles.header}><Space><Button ref={instance => { toggleRef.current = instance }} type="text" aria-label={text('toggleNavigation')} icon={collapsed || mobile ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => mobile ? setOpen(true) : setCollapsed(value => !value)} /><span>{title}</span></Space><Language /></Layout.Header>
      <Layout.Content className={styles.content}><div className={styles.pageHeading}><Typography.Title level={2}>{title}</Typography.Title><Typography.Paragraph type="secondary">{hint}</Typography.Paragraph></div>{children}</Layout.Content>
    </Layout>
  </Layout>
}
