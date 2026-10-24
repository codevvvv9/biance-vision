import { Select } from 'antd'
import { useTranslation } from 'react-i18next'
export function Language(): JSX.Element {
  const { i18n } = useTranslation()
  return <Select aria-label="Language / 语言" value={i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US'} onChange={value => void i18n.changeLanguage(value)} options={[{ value: 'zh-CN', label: '简体中文' }, { value: 'en-US', label: 'English' }]} />
}
