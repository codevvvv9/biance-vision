import crypto from 'node:crypto'
import { loadJson, saveJson } from './store.js'
import {
  appendHistory,
  initDb,
  isDbAvailable,
  loadAllFromDb,
  mergeMissingHistory,
  persistRules,
  persistSettings,
} from './db.js'
import type { AlertEntry, AlertRule, RuleInput, RuleType, Settings, TickerSnapshot } from './types.js'

export const TYPE_LABELS: Record<RuleType, string> = {
  price_above: '价格突破',
  price_below: '价格跌破',
  change_above: '24h涨幅超过',
  change_below: '24h跌幅超过',
}

const CONDITIONS: Record<RuleType, (t: TickerSnapshot, v: number) => boolean> = {
  price_above: (t, v) => t.last >= v,
  price_below: (t, v) => t.last <= v,
  change_above: (t, v) => t.changePct >= v,
  change_below: (t, v) => t.changePct <= v,
}
export const RULE_TYPES = Object.keys(CONDITIONS) as RuleType[]

interface BadRequestError extends Error {
  statusCode: number
}
function badRequest(msg: string): BadRequestError {
  return Object.assign(new Error(msg), { statusCode: 400 })
}

const SEED_RULES: AlertRule[] = [
  {
    id: crypto.randomUUID(),
    symbol: 'BTCUSDT',
    type: 'price_above',
    value: 90000,
    note: '示例：BTC 突破 90000',
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastTriggeredAt: null,
    armed: true,
  },
  {
    id: crypto.randomUUID(),
    symbol: 'BTCUSDT',
    type: 'change_above',
    value: 3,
    note: '示例：BTC 24h 涨幅超过 3%',
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastTriggeredAt: null,
    armed: true,
  },
]

// 内存状态始终以 JSON 为初始值；数据库可用时由 initStorage() 覆盖/合并
const loadedRules = loadJson<AlertRule[] | null>('rules.json', null)
let rules: AlertRule[] = loadedRules ?? SEED_RULES
if (!loadedRules) saveJson('rules.json', rules)
for (const r of rules) {
  r.armed ??= true
  r.updatedAt ??= r.createdAt
}

let history: AlertEntry[] = loadJson<AlertEntry[]>('history.json', [])
let settings: Settings = loadJson<Settings>('settings.json', { webhookUrl: '' })

/** 持久化：JSON 镜像（始终）+ PostgreSQL（可用时） */
function persistAll(): void {
  saveJson('rules.json', rules)
  saveJson('history.json', history)
  saveJson('settings.json', settings)
  void persistRules(rules).catch((e: Error) => console.warn('[db] 规则写入失败:', e.message))
}

/**
 * 启动时初始化存储，规则按下述策略合并（差异只可能来自数据库宕机期间的 JSON 写入）：
 * - 数据库可用：规则按 id 对齐，JSON 版本 updatedAt 更新的胜出；历史按 id 并集合并；
 *   合并结果回写数据库和 JSON 镜像
 * - 数据库为空且 JSON 有存量：整体导入（首次接入）
 * - 数据库不可用：纯 JSON 降级运行，功能不受影响
 */
export async function initStorage(): Promise<void> {
  const ok = await initDb()
  if (!ok) return
  const loaded = await loadAllFromDb()
  if (!loaded) return

  if (loaded.rules.length === 0 && (rules.length > 0 || history.length > 0 || settings.webhookUrl)) {
    // 首次接入数据库：把 JSON 存量整体导入
    await persistRules(rules)
    await mergeMissingHistory(history)
    await persistSettings(settings)
    console.log(`[db] 已导入 JSON 存量数据：规则 ${rules.length} 条，历史 ${history.length} 条`)
    return
  }

  // 规则合并：两边都有的取 JSON 版本（差异只可能来自宕机期间的 JSON 写入，必更新）；
  // 仅数据库有的视为宕机期间已删除，丢弃；仅 JSON 有的为宕机期间新增，保留
  if (rules.length > 0) {
    const jsonMap = new Map(rules.map((r) => [r.id, r]))
    const kept = loaded.rules.filter((pr) => jsonMap.has(pr.id)).map((pr) => jsonMap.get(pr.id)!)
    const keptIds = new Set(kept.map((r) => r.id))
    rules = [...kept, ...rules.filter((jr) => !keptIds.has(jr.id))]
    await persistRules(rules)
  }
  // JSON 为空且数据库非空：视为初始化/重置场景，保留数据库内容

  await mergeMissingHistory(history)
  history = loaded.history
  if (settings.webhookUrl && settings.webhookUrl !== loaded.settings.webhookUrl) {
    await persistSettings(settings) // 宕机期间改过 webhook，以 JSON 为准
  } else {
    settings = loaded.settings
  }
  saveJson('rules.json', rules)
  saveJson('history.json', history)
  saveJson('settings.json', settings)
  console.log(`[db] 已从 PostgreSQL 加载：规则 ${rules.length} 条，历史 ${history.length} 条`)
}

export const getRules = (): AlertRule[] => rules
export const getHistory = (limit = 50): AlertEntry[] => history.slice(0, Math.max(1, limit))
export const getSettings = (): Settings => settings
export const storageMode = (): 'postgres' | 'json' => (isDbAvailable() ? 'postgres' : 'json')

const fmtNum = (v: number): string =>
  Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 })

export function conditionText(r: Pick<AlertRule, 'type' | 'value'>): string {
  const val = r.type.startsWith('price_') ? fmtNum(r.value) : `${r.value}%`
  return `${TYPE_LABELS[r.type] ?? r.type} ${val}`
}

function buildEntry(r: AlertRule, t: TickerSnapshot): AlertEntry {
  const pctStr = `${t.changePct >= 0 ? '+' : ''}${t.changePct.toFixed(2)}%`
  const priceStr = fmtNum(t.last)
  let message: string
  switch (r.type) {
    case 'price_above':
      message = `${r.symbol} 突破 ${fmtNum(r.value)}，现价 ${priceStr}，24h ${pctStr}`
      break
    case 'price_below':
      message = `${r.symbol} 跌破 ${fmtNum(r.value)}，现价 ${priceStr}，24h ${pctStr}`
      break
    case 'change_above':
      message = `${r.symbol} 24h 涨幅达 ${pctStr}，现价 ${priceStr}`
      break
    case 'change_below':
      message = `${r.symbol} 24h 跌幅达 ${pctStr}，现价 ${priceStr}`
      break
    default:
      message = `${r.symbol} 触发 ${conditionText(r)}，现价 ${priceStr}`
  }
  return {
    id: crypto.randomUUID(),
    ruleId: r.id,
    symbol: r.symbol,
    type: r.type,
    value: r.value,
    note: r.note || '',
    message,
    price: t.last,
    changePct: t.changePct,
    triggeredAt: Date.now(),
  }
}

/**
 * 布防：价格类规则按「突破/跌破」边缘触发——创建/启用时若条件已满足
 * （价格已在目标位另一侧），则先解除布防，等条件回落复位后再次突破才提醒；
 * 涨跌幅类规则按“超过阈值”触发，创建时若已超阈值会在下一次行情推送时立即提醒一次。
 */
export function armRule(rule: AlertRule, ticker: TickerSnapshot | null): void {
  const cond = CONDITIONS[rule.type]
  if (!cond) return
  const ok = ticker ? cond(ticker, rule.value) : false
  rule.armed = rule.type.startsWith('price_') ? !ok : true
}

function parseRuleFields(input: RuleInput): { symbol: string; type: RuleType; value: number } {
  const symbol = String(input.symbol ?? '').trim().toUpperCase()
  const type = String(input.type ?? '')
  const value = Number(input.value)
  if (!/^[A-Z0-9]{4,20}$/.test(symbol)) throw badRequest('invalid symbol')
  if (!RULE_TYPES.includes(type as RuleType)) throw badRequest('invalid rule type')
  if (!Number.isFinite(value)) throw badRequest('invalid value')
  return { symbol, type: type as RuleType, value }
}

export function createRule(input: RuleInput, getTicker: (s: string) => TickerSnapshot | null): AlertRule {
  const { symbol, type, value } = parseRuleFields(input)
  const rule: AlertRule = {
    id: crypto.randomUUID(),
    symbol,
    type,
    value,
    note: String(input.note ?? '').slice(0, 80),
    enabled: input.enabled !== false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastTriggeredAt: null,
    armed: true,
  }
  armRule(rule, getTicker(symbol))
  rules.push(rule)
  saveJson('rules.json', rules)
  void persistRules(rules).catch((e: Error) => console.warn('[db] 规则写入失败:', e.message))
  return rule
}

export function updateRule(
  id: string,
  patch: RuleInput,
  getTicker: (s: string) => TickerSnapshot | null,
): AlertRule | null {
  const r = rules.find((x) => x.id === id)
  if (!r) return null
  const next = {
    symbol: patch.symbol !== undefined ? String(patch.symbol).trim().toUpperCase() : r.symbol,
    type: patch.type !== undefined ? String(patch.type) : r.type,
    value: patch.value !== undefined ? Number(patch.value) : r.value,
  }
  if (!/^[A-Z0-9]{4,20}$/.test(next.symbol)) throw badRequest('invalid symbol')
  if (!RULE_TYPES.includes(next.type as RuleType)) throw badRequest('invalid rule type')
  if (!Number.isFinite(next.value)) throw badRequest('invalid value')
  const condChanged = next.symbol !== r.symbol || next.type !== r.type || next.value !== r.value
  Object.assign(r, next)
  if (patch.note !== undefined) r.note = String(patch.note).slice(0, 80)
  if (patch.enabled !== undefined) r.enabled = !!patch.enabled
  r.updatedAt = Date.now()
  // 条件变化或重新启用时重新布防
  if (condChanged || patch.enabled === true) armRule(r, getTicker(r.symbol))
  saveJson('rules.json', rules)
  void persistRules(rules).catch((e: Error) => console.warn('[db] 规则写入失败:', e.message))
  return r
}

export function removeRule(id: string): boolean {
  const idx = rules.findIndex((x) => x.id === id)
  if (idx === -1) return false
  rules.splice(idx, 1)
  saveJson('rules.json', rules)
  void persistRules(rules).catch((e: Error) => console.warn('[db] 规则写入失败:', e.message))
  return true
}

export function evaluateRules(getTicker: (s: string) => TickerSnapshot | null): AlertEntry[] {
  const fired: AlertEntry[] = []
  for (const r of rules) {
    if (!r.enabled) continue
    const t = getTicker(r.symbol)
    if (!t) continue
    const ok = CONDITIONS[r.type]?.(t, r.value)
    if (ok && r.armed) {
      r.armed = false
      r.lastTriggeredAt = Date.now()
      const entry = buildEntry(r, t)
      history.unshift(entry)
      if (history.length > 200) history.length = 200
      fired.push(entry)
    } else if (!ok && !r.armed) {
      r.armed = true // 条件复位，重新布防，下次满足再触发
    }
  }
  if (fired.length) {
    saveJson('rules.json', rules)
    saveJson('history.json', history)
    void persistRules(rules).catch((e: Error) => console.warn('[db] 规则写入失败:', e.message))
    void appendHistory(fired).catch((e: Error) => console.warn('[db] 历史写入失败:', e.message))
  }
  return fired
}

export function updateSettings(patch: { webhookUrl?: unknown }): Settings {
  const url = patch.webhookUrl
  if (typeof url !== 'string' || url.length > 2000) throw badRequest('invalid webhookUrl')
  if (url && !/^https?:\/\//.test(url)) throw badRequest('webhookUrl must be http(s)')
  settings = { webhookUrl: url.trim() }
  saveJson('settings.json', settings)
  void persistSettings(settings).catch((e: Error) => console.warn('[db] 设置写入失败:', e.message))
  return settings
}

export function callWebhook(entry: AlertEntry): void {
  if (!settings.webhookUrl) return
  fetch(settings.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'alert.fired', data: entry }),
    signal: AbortSignal.timeout(5000),
  })
    .then((res) => console.log(`[webhook] ${res.status} ${settings.webhookUrl}`))
    .catch((err: Error) => console.warn('[webhook] failed:', err.message))
}
