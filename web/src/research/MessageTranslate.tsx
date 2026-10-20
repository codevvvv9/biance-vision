/**
 * 消息级翻译开关（X / Twitter「展示翻译」同款交互）：
 * 消息主体语言 ≠ 当前 UI 语言时，消息下方出现「🌐 翻译」链接按钮；
 * 点击内联展开译文（原文保留在上，译文带来源标注），可「显示原文」收起 /
 * 「显示译文」再展开。服务端 POST /api/translate（登录 + 用户级管控，
 * 不落会话历史）；两个引擎都不可用时显示失败态，可重试。
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import { currentLocale } from '../i18n'

function GlobeIcon(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

/** 与服务端 parseTranslateRequest 同口径的粗检：CJK 占比 > 20% 视为中文主体 */
function isMainlyChinese(text: string): boolean {
  const compact = text.replace(/\s/g, '')
  if (compact === '') return false
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length
  return cjk > compact.length * 0.2
}

type State = 'idle' | 'loading' | 'done' | 'error'

export function MessageTranslate({ text }: { text: string }): JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<State>('idle')
  const [result, setResult] = useState<{ text: string; engine: 'llm' | 'argos' } | null>(null)
  const [showTranslation, setShowTranslation] = useState(true)

  const uiLang = currentLocale() === 'en-US' ? 'en' : 'zh'
  const messageIsChinese = isMainlyChinese(text)
  // 空消息 / 消息语言与 UI 语言一致时不出现翻译入口（X 同款规则）
  if (text.trim() === '' || messageIsChinese === (uiLang === 'zh')) return null
  const sourceLabel = messageIsChinese ? t('research:translate.fromZh') : t('research:translate.fromEn')

  const translate = (): void => {
    setState('loading')
    void api<{ text: string | null; engine: 'llm' | 'argos' | null }>('/translate', {
      method: 'POST',
      body: { text, targetLang: uiLang },
    })
      .then((r) => {
        if (r.text === null || r.text === '' || r.engine === null) {
          setState('error')
          return
        }
        setResult({ text: r.text, engine: r.engine })
        setShowTranslation(true)
        setState('done')
      })
      .catch(() => setState('error'))
  }

  if (state === 'idle') {
    return (
      <button className="msg-translate-btn" onClick={translate}>
        <GlobeIcon />
        {t('research:translate.button')}
      </button>
    )
  }
  if (state === 'loading') {
    return <span className="msg-translate-btn is-loading">{t('research:translate.loading')}</span>
  }
  if (state === 'error') {
    return (
      <button className="msg-translate-btn is-error" onClick={translate}>
        {t('research:translate.fail')}
      </button>
    )
  }
  return (
    <div className="msg-translate-block">
      {showTranslation ? (
        <>
          <p className="msg-translate-text">{result?.text}</p>
          <div className="msg-translate-meta">
            <span>
              {sourceLabel} · {result?.engine === 'argos' ? t('research:translate.byArgos') : t('research:translate.byLlm')}
            </span>
            <button className="msg-translate-toggle" onClick={() => setShowTranslation(false)}>
              {t('research:translate.showOriginal')}
            </button>
          </div>
        </>
      ) : (
        <button className="msg-translate-toggle" onClick={() => setShowTranslation(true)}>
          {t('research:translate.showTranslation')}
        </button>
      )}
    </div>
  )
}
