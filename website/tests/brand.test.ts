import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { brand } from '@biance/brand/identity'
import { assertBuildIdentity } from '../runtime/build-identity.mjs'

test('the production runtime rejects a stale origin or stale brand instead of serving mixed identity', () => {
  const current = { origin: `https://${brand.domain}`, brand: brand.name }
  assert.doesNotThrow(() => assertBuildIdentity(current, current))
  for (const built of [undefined, { ...current, origin: 'https://previous.example.org' }, { ...current, brand: 'previous identity' }]) {
    assert.throws(() => assertBuildIdentity(built, current), /build identity mismatch/)
  }
})

test('the public brand gate scans runtime/editorial sources and compares distributed marks', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-brand.ts'], { cwd: new URL('../', import.meta.url), encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
