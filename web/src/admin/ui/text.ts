import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
export function useAdminText(): (key: string, values?: Record<string, unknown>) => string {
  const { t } = useTranslation('admin')
  return useCallback((key: string, values?: Record<string, unknown>) => t(`ui.${key}`, values), [t])
}
