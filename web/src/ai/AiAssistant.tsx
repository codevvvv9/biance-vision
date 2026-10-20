import { useTranslation } from 'react-i18next'
import { useAi } from './AiContext'
import AiChat from './AiChat'

/** AI 助手组合壳：右下角悬浮图标按钮 + 聊天窗（仅在超管完成 AI 配置后出现） */
export default function AiAssistant(): JSX.Element | null {
  const { t } = useTranslation()
  const { robotVisible, chatOpen, setChatOpen, hideRobot } = useAi()
  if (!robotVisible) return null
  return (
    <>
      <div className={`ai-fab-wrap${chatOpen ? ' is-hidden' : ''}`}>
        <button className="ai-fab" onClick={() => setChatOpen(true)} aria-label={t('ai:fab.open')} title={t('ai:fab.title')}>
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
        <button
          className="ai-fab-hide"
          onClick={hideRobot}
          aria-label={t('ai:fab.hide')}
          title={t('ai:fab.hideTitle')}
        >
          ✕
        </button>
      </div>
      {chatOpen && <AiChat onClose={() => setChatOpen(false)} />}
    </>
  )
}
