import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// The runtime stays native ESM so standalone deployment needs no loader or dev dependency.
import { installAccessLog, createLogWriter, policy } from '../runtime/access-log.mjs'

async function contents(dir: string) {
  return (await Promise.all((await readdir(dir)).filter(n => n.endsWith('.jsonl')).map(n => readFile(join(dir, n), 'utf8')))).join('')
}
test('real HTTP diagnostics on Node 22 log public paths only, dropping query, credentials, IP and bodies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bv-geo-log-'))
  const logger = installAccessLog({ directory, paths: ['/en/about'] })
  const server = createServer((req, res) => { res.setHeader('Content-Length', '2'); res.end('ok') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    for (const path of ['/en/about?question=PRIVATE-QUESTION', '/api/private?token=PRIVATE-TOKEN', '/research', '/random/PRIVATE-QUESTION']) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { cookie: 'bv_session=PRIVATE-COOKIE', authorization: 'Bearer PRIVATE-AUTH', 'x-forwarded-for': '192.0.2.99' } }); await response.text()
    }
    await logger.flush()
    const text = await contents(directory), entries = text.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(entries.length, 1)
    assert.deepEqual(Object.keys(entries[0]), ['time', 'path', 'method', 'status', 'durationMs', 'size'])
    assert.equal(entries[0].path, '/en/about'); assert.equal(entries[0].status, 200); assert.equal(entries[0].size, 2)
    assert.ok(entries[0].durationMs >= 0)
    assert.doesNotMatch(text, /PRIVATE|192\.0\.2|cookie|Bearer|question|token/i)
    const filename = (await readdir(directory))[0]
    assert.equal((await stat(join(directory, filename))).mode & 0o777, 0o600)
  } finally { await logger.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) }
})
test('retention, rotation, queue bound and total-size cap hold under repeated writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bv-geo-cap-'))
  const stale = `public-${Date.now()-policy.retentionMs-1000}-aaaaaaaa.jsonl`
  await writeFile(join(directory, stale), 'old')
  const writer = createLogWriter(directory, { maxBytes: 700, fileBytes: 350, maxQueue: 2 })
  try {
    const record = { time: new Date().toISOString(), path: '/en', method: 'GET', status: 200, durationMs: 1, size: 2, secret: 'NEVER-LOG' }
    assert.equal(writer.enqueue(record), true); assert.equal(writer.enqueue(record), true); assert.equal(writer.enqueue(record), false)
    await writer.flush()
    for (let i=0;i<12;i++) { writer.enqueue(record); await writer.flush() }
    const names = await readdir(directory)
    assert.ok(!names.includes(stale))
    const sizes = await Promise.all(names.map(n => stat(join(directory,n))))
    assert.ok(sizes.every(s => s.size <= 350)); assert.ok(sizes.reduce((a,b) => a+b.size,0) <= 700)
    assert.doesNotMatch(await contents(directory), /NEVER-LOG|secret/)
  } finally { await writer.close(); await rm(directory, { recursive: true, force: true }) }
})
test('an unwritable log destination does not delay or fail an HTTP response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bv-geo-log-failure-'))
  const file = join(directory, 'not-a-directory'); await writeFile(file, 'occupied')
  const logger = installAccessLog({ directory: file, paths: ['/en'] })
  const server = createServer((_req,res) => { res.end('available') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/en`)
    assert.equal(response.status,200); assert.equal(await response.text(),'available')
    await logger.flush()
  } finally { await logger.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive:true, force:true }) }
})
