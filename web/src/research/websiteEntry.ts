export const ENTRY_KEY = 'bv.research-entry.v1'
export const ENTRY_TTL = 30 * 60 * 1000
export type ResearchEntryDraftV1 = {
  version: 1
  question: string
  scene: 'spot' | 'perp'
  symbol: string
  horizon: '10m' | '30m' | '1h' | '1d' | '1w'
  locale: 'zh-CN' | 'en-US'
  createdAt: number
}

/** Kept free of React, cookies and browser initialization for the terminal handoff. */
export function parseEntry(raw: string | null, now = Date.now()): ResearchEntryDraftV1 | null {
  try {
    const value = JSON.parse(raw || 'null') as ResearchEntryDraftV1 | null
    if (!value || value.version !== 1 || typeof value.question !== 'string' || !value.question.trim() || value.question.length > 2000 ||
      !['spot', 'perp'].includes(value.scene) || typeof value.symbol !== 'string' || !/^[A-Z0-9]{3,30}$/.test(value.symbol) ||
      !['10m', '30m', '1h', '1d', '1w'].includes(value.horizon) || !['zh-CN', 'en-US'].includes(value.locale) ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt > now || now - value.createdAt >= ENTRY_TTL) return null
    return value
  } catch { return null }
}
