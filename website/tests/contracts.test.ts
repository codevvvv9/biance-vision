import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { browserLocale, isMainlandIp } from '../lib/locale'
import { parseEntry, ENTRY_TTL } from '../lib/research-entry'
import { guides, demos } from '../lib/content'
import { contactConfig, loginUrl, publicOrigin } from '../lib/site'

test('browser language takes precedence, q=0 is ignored, traditional regions map to zh-TW', () => {
  assert.equal(browserLocale('zh-CN, en;q=.8'), 'zh')
  assert.equal(browserLocale('zh;q=.5, en-GB;q=.9'), 'en')
  assert.equal(browserLocale('fr, zh-Hant;q=.9'), 'zh-TW')
  assert.equal(browserLocale('zh-TW,zh;q=0.9,en;q=0.8'), 'zh-TW')
  assert.equal(browserLocale('zh-HK,en;q=.5'), 'zh-TW')
  assert.equal(browserLocale('zh-mo, en;q=.8'), 'zh-TW')
  assert.equal(browserLocale('zh-Hant-TW,en;q=.7'), 'zh-TW')
  assert.equal(browserLocale('zh-SG, en;q=.8'), 'zh')
  assert.equal(browserLocale('zh;q=0, en;q=.5'), 'en')
  assert.equal(browserLocale('fr, de;q=.8'), null)
  assert.equal(browserLocale(null), null)
  assert.equal(browserLocale('zh;q=NaN, en;q=1.1'), null)
})
test('CIDR fallback supports valid IPv4 boundaries and safely ignores unknown IPv6', () => {
  const list = '1.0.1.0/24\n1.0.2.0/23\ninvalid\n1.0.0.0/99'
  assert.equal(isMainlandIp('1.0.1.0', list), true)
  assert.equal(isMainlandIp('1.0.1.255', list), true)
  assert.equal(isMainlandIp('1.0.0.255', list), false)
  assert.equal(isMainlandIp('1.0.3.255', list), true)
  assert.equal(isMainlandIp('1.0.4.0', list), false)
  assert.equal(isMainlandIp('::ffff:1.0.1.1', list), true)
  assert.equal(isMainlandIp('2400::1', list), false)
  assert.equal(isMainlandIp('999.0.1.1', list), false)
})
test('entry drafts reject stale, future, malformed, unknown-version and invalid-scene records', () => {
  const now = 1_700_000_000_000
  const draft = { version: 1, question: 'Explain BTC structure', scene: 'perp', symbol: 'BTCUSDT', horizon: '1h', locale: 'en-US', createdAt: now - 100 }
  assert.deepEqual(parseEntry(JSON.stringify(draft), now), draft)
  for (const patch of [{ createdAt: now - ENTRY_TTL }, { createdAt: now + 1 }, { version: 2 }, { question: '' }, { scene: 'event' }, { horizon: '10y' }, { symbol: 'BTC?secret' }]) {
    assert.equal(parseEntry(JSON.stringify({ ...draft, ...patch }), now), null)
  }
  assert.equal(parseEntry('{broken', now), null)
})
test('bilingual guides and teaching cases remain paired with substantive readable content', () => {
  assert.deepEqual(guides('en').map(g => g.slug), guides('zh').map(g => g.slug))
  assert.deepEqual(guides('zh').map(g => g.slug), guides('zh-TW').map(g => g.slug))
  for (const locale of ['en', 'zh', 'zh-TW'] as const) {
    assert.equal(demos(locale).length, 3)
    assert.equal(guides(locale).length, 8)
    for (const guide of guides(locale)) assert.ok(guide.title && guide.description)
  }
})
test('login returns to the research workspace without carrying a private question in the URL', () => {
  const url = new URL(loginUrl('en'), 'https://example.org')
  assert.equal(url.pathname, '/login')
  assert.equal(url.searchParams.get('returnTo'), '/research?ui=dev')
  assert.equal(url.searchParams.has('question'), false)
})
test('public configuration rejects unsafe URL and contact values', () => {
  const original = { origin: process.env.WEBSITE_ORIGIN, email: process.env.WEBSITE_CONTACT_EMAIL, telegram: process.env.WEBSITE_TELEGRAM }
  try {
    process.env.WEBSITE_ORIGIN = 'https://example.org/?secret=123'
    assert.throws(publicOrigin)
    process.env.WEBSITE_TELEGRAM = 'bad/?redirect=evil'
    assert.throws(contactConfig)
    process.env.WEBSITE_TELEGRAM = ''
    process.env.WEBSITE_CONTACT_EMAIL = 'email@example.org\nBcc:secret@example.org'
    assert.throws(contactConfig)
  } finally {
    for (const [key, value] of Object.entries({ WEBSITE_ORIGIN: original.origin, WEBSITE_CONTACT_EMAIL: original.email, WEBSITE_TELEGRAM: original.telegram })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})

test('terminal return destinations and independently bundled draft consumer preserve the website contract', async () => {
  const { authReturnTo } = await import('../../web/src/research/uiMode')
  const terminal = await import('../../web/src/research/websiteEntry')
  assert.equal(authReturnTo(''), '/research?ui=dev')
  assert.equal(authReturnTo('?returnTo=%2F'), '/dashboard')
  assert.equal(authReturnTo('', { from: '/' }), '/dashboard')
  assert.equal(authReturnTo('?returnTo=%2Fresearch%3Fui%3Ddev%26conversation%3Dabc'), '/research?ui=dev&conversation=abc')
  for (const candidate of ['https://evil.test', '//evil.test', '/\\evil.test', '/\nevil.test']) assert.equal(authReturnTo(`?returnTo=${encodeURIComponent(candidate)}`), '/research?ui=dev')
  const draft = { version: 1, question: 'BTC structure?', scene: 'perp', symbol: 'BTCUSDT', horizon: '1h', locale: 'en-US', createdAt: Date.now() }
  for (const input of [JSON.stringify(draft), JSON.stringify({ ...draft, createdAt: 0 }), JSON.stringify({ ...draft, question: 'x'.repeat(2001) }), '{broken']) assert.deepEqual(terminal.parseEntry(input), parseEntry(input))
})
