'use client'

import { useState } from 'react'
import { text, type Locale } from '@/lib/site'

export function CopyText({ value, locale, label }: { value: string; locale: Locale; label?: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'manual'>('idle')
  async function copy() {
    try { await navigator.clipboard.writeText(value); setStatus('copied') }
    catch { setStatus('manual') }
  }
  return <div className="copy-control"><button type="button" onClick={copy} className="copy-button">{status === 'copied' ? text(locale, 'Copied', '已复制') : label || text(locale, 'Copy', '复制')} <span aria-hidden="true">{status === 'copied' ? '✓' : '⧉'}</span></button><span className="sr-only" role="status">{status === 'copied' ? text(locale, 'Copied to clipboard', '已复制到剪贴板') : ''}</span>{status === 'manual' && <div className="copy-fallback"><p role="status">{text(locale, 'Copy is unavailable. Select and copy the text below.', '无法自动复制，请选中下方文字手动复制。')}</p><textarea readOnly value={value} rows={value.includes('\n') ? 6 : 2} aria-label={text(locale, 'Text to copy manually', '可手动复制的文字')} onFocus={e => e.currentTarget.select()} /></div>}</div>
}
