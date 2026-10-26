import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { checkContent } from '../scripts/check-content'
import { publications, published, pagePaths, publicPaths } from '../lib/publications'
import { crawlerRules, protectedPaths, searchAgents } from '../lib/crawlers'
import { validateCidrs } from '../lib/locale'

test('all 13 explicit bilingual MDX pairs have checked sources, stable dates, matching TOCs and related cases', async () => {
  assert.deepEqual(await checkContent(), { articles: 13, pages: 36 })
  assert.equal(published.filter(p => p.kind === 'guide').length, 8)
  assert.equal(published.filter(p => p.kind === 'demo').length, 3)
  assert.equal(new Set(pagePaths).size, pagePaths.length)
  const broken = structuredClone(publications)
  broken[0].translations.zh.translation = '/en/wrong'
  await assert.rejects(checkContent(broken), /translation/)
  const missing = structuredClone(publications)
  missing[0].translations.en.sources = []
  await assert.rejects(checkContent(missing), /sources/)
})
test('search-specific robots groups repeat every protected rule; training has a separate policy', () => {
  for (const agent of ['*', ...searchAgents]) {
    const group = crawlerRules.find(r => r.userAgent === agent)!
    assert.equal(group.allow, '/')
    assert.deepEqual(group.disallow, protectedPaths)
    for (const path of pagePaths) assert.ok(!protectedPaths.some(block => `/en/${path}`.startsWith(block)))
  }
  assert.equal(crawlerRules.find(r => r.userAgent === 'GPTBot')?.disallow, '/')
})
test('build CIDR validation rejects empty, malformed, duplicate, host-bit and catch-all records', () => {
  for (const list of ['', 'invalid', '1.0.1.1/24', '1.0.1.0/99', '999.0.1.0/24', '0.0.0.0/0', '1.0.1.0/24\n1.0.1.0/24']) assert.throws(() => validateCidrs(list))
  assert.deepEqual(validateCidrs('1.0.1.0/24\n1.0.2.0/23\n'), ['1.0.1.0/24', '1.0.2.0/23'])
})
test('logger allowlist is generated only from the published public manifest and contains no tool/API routes', async () => {
  const paths = JSON.parse(await readFile(new URL('../runtime/public-paths.json', import.meta.url), 'utf8'))
  assert.deepEqual(paths, ['/', '/robots.txt', '/sitemap.xml', ...['en', 'zh'].flatMap(locale => pagePaths.map(p => `/${locale}${p ? `/${p}` : ''}`))])
  assert.ok(paths.every((p: string) => !protectedPaths.some(block => p.startsWith(block))))
})

test('an unpublished translation pair cannot enter routes, sitemap paths or logger allowlist', () => {
  const candidate = structuredClone(publications[0])
  candidate.id = 'private-draft'; candidate.path = 'guides/private-draft'; candidate.status = 'draft'
  assert.ok(!publicPaths([...publications, candidate]).includes('guides/private-draft'))
})

test('manual observation set remains 9 English + 3 Chinese questions with valid public destinations', async () => {
  const prompts = JSON.parse(await readFile(new URL('../evaluation/prompts.json', import.meta.url), 'utf8')) as {id:string;locale:string;question:string;expectedPaths:string[]}[]
  assert.equal(prompts.length, 12); assert.equal(new Set(prompts.map(p=>p.id)).size, 12)
  assert.equal(prompts.filter(p=>p.locale==='en').length, 9)
  assert.equal(prompts.filter(p=>p.locale==='zh').length, 3)
  for (const p of prompts) for (const path of p.expectedPaths) assert.ok(pagePaths.includes(path.slice(4)))
})
