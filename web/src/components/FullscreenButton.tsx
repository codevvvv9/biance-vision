import { useTranslation } from 'react-i18next'

interface Props {
  on: boolean
  onClick: () => void
  /** 未全屏时的提示文案（已翻译文本，如 t('dashboard:kline.fullscreen')） */
  label?: string
}

/** 面板头部的全屏切换按钮，图标随状态在展开/收起间切换 */
export default function FullscreenButton({ on, onClick, label }: Props): JSX.Element {
  const { t } = useTranslation()
  const labelText = label ?? t('common:fullscreen.enter')
  return (
    <button
      type="button"
      className="fs-btn"
      onClick={onClick}
      title={on ? t('common:fullscreen.exit') : labelText}
      aria-label={on ? t('common:fullscreen.exit') : labelText}
    >
      {on ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 3v3a2 2 0 0 1-2 2H3" />
          <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
          <path d="M3 16h3a2 2 0 0 1 2 2v3" />
          <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
          <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
          <path d="M3 16v3a2 2 0 0 0 2 2h3" />
          <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
        </svg>
      )}
    </button>
  )
}
