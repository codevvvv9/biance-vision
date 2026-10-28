'use client'

import { useState } from 'react'
import { ENTRY_KEY, parseEntry, type ResearchEntryDraftV1 } from '@/lib/research-entry'
import { loginUrl, text, type Locale } from '@/lib/site'
import { Arrow } from './Icons'

export function QuestionEntry({ locale }: { locale: Locale }) {
  const [question, setQuestion] = useState('')
  const [scene, setScene] = useState<'spot' | 'perp'>('perp')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [storageFailed, setStorageFailed] = useState(false)
  function proceed(replace = false) {
    if (!question.trim()) { setNotice(text(locale, 'Write a question before continuing.', '请先准备一个研究问题。', '請先準備一個研究問題。')); return }
    const draft: ResearchEntryDraftV1 = { version: 1, question: question.trim(), scene, symbol: 'BTCUSDT', horizon: '1h', locale: locale === 'en' ? 'en-US' : 'zh-CN', createdAt: Date.now() }
    try {
      const existing = parseEntry(sessionStorage.getItem(ENTRY_KEY))
      if (existing && !replace) { setConflict(true); return }
      sessionStorage.setItem(ENTRY_KEY, JSON.stringify(draft))
      window.location.assign(loginUrl(locale))
    } catch {
      setStorageFailed(true)
      setNotice(text(locale, 'Your browser cannot save the question. Copy it now, then log in and paste it into the terminal.', '浏览器无法保存问题。请先复制问题，登录后粘贴到研究台。', '瀏覽器無法儲存問題。請先複製問題，登入後貼上到研究臺。'))
    }
  }
  return <section className="question-entry" aria-labelledby="question-heading">
    <div><span className="eyebrow">{text(locale, 'MAKE IT YOUR QUESTION', '从你的问题开始', '從你的問題開始')}</span><h3 id="question-heading">{text(locale, 'Prepare your research question.', '准备你的研究问题。', '準備你的研究問題。')}</h3><p>{text(locale, 'Have an account? Take your question into the terminal. New here? Contact us to discuss access.', '已有账号可带着问题进入终端；首次了解我们，可以先联系开通。', '已有帳號可帶著問題進入終端；首次瞭解我們，可以先聯絡開通。')}</p></div>
    <div className="question-form"><label className="sr-only" htmlFor="research-question">{text(locale, 'Research question', '研究问题', '研究問題')}</label><textarea id="research-question" maxLength={2000} value={question} onChange={e => { setQuestion(e.target.value); setNotice('') }} placeholder={text(locale, 'Review BTC’s structure. What supports it, what opposes it, and what should I wait for?', '复查 BTC 当前结构：有什么支持与反对证据？需要等待什么条件？', '複查 BTC 當前結構：有什麼支援與反對證據？需要等待什麼條件？')} rows={3} /><div className="question-controls"><label htmlFor="research-scene" className="scene-label">{text(locale, 'Market', '市场', '市場')} <select id="research-scene" value={scene} onChange={e => setScene(e.target.value as 'spot' | 'perp')}><option value="perp">{text(locale, 'Perpetual', '永续', '永續')}</option><option value="spot">{text(locale, 'Spot', '现货', '現貨')}</option></select></label><span className="question-default">BTCUSDT · 1h</span></div><div className="question-actions"><button type="button" className="button button-primary" onClick={() => proceed()}>{text(locale, 'Have an account? Continue', '已有账号，带着问题进入', '已有帳號，帶著問題進入')} <Arrow /></button><a href={`/${locale}/contact`}>{text(locale, 'Contact us for access', '联系开通', '聯絡開通')} ↗</a></div><p className="input-note">{text(locale, 'Same tab · 30-minute handoff · You confirm before research starts.', '同标签页 · 30 分钟临时交接 · 研究前由你确认发送。', '同標籤頁 · 30 分鐘臨時交接 · 研究前由你確認傳送。')}</p>
      {notice && <p role="status" className="form-notice">{notice}</p>}
      {storageFailed && <a className="text-link" href={loginUrl(locale)}>{text(locale, 'Continue to login without a saved question', '不保存问题，继续登录', '不儲存問題，繼續登入')} <Arrow /></a>}
      {conflict && <div className="draft-conflict" role="group" aria-label={text(locale, 'An earlier question is saved', '已有暂存的问题', '已有暫存的問題')}><p>{text(locale, 'You already have a saved entry question. Keep it or replace it with this one?', '已有暂存的入口问题。保留它，还是用当前问题替换？', '已有暫存的入口問題。保留它，還是用當前問題替換？')}</p><a className="button button-small button-outline" href={loginUrl(locale)}>{text(locale, 'Keep saved question', '保留暂存问题', '保留暫存問題')}</a><button type="button" className="button button-small button-primary" onClick={() => proceed(true)}>{text(locale, 'Replace with this question', '替换为当前问题', '替換為當前問題')}</button></div>}
    </div>
  </section>
}
