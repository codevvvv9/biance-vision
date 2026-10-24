/** Website-only diagnostics. Never reads headers, cookies, IP addresses or bodies. */
import { channel } from 'node:diagnostics_channel'
import { mkdir, readdir, stat, unlink, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export const policy = Object.freeze({ retentionMs: 14 * 24 * 60 * 60 * 1000, maxBytes: 20 * 1024 * 1024, fileBytes: 1024 * 1024, maxQueue: 256 })
const filePattern = /^public-\d+-[a-f0-9-]+\.jsonl$/

export function createLogWriter(directory, options = {}) {
  const limits = { ...policy, ...options }
  let tail = Promise.resolve(), queued = 0, active = '', warned = false
  const warn = () => { if (!warned) { warned = true; process.stderr.write('Website access logging unavailable; requests remain available.\n') } }
  async function clean(incoming = 0) {
    const files = []
    for (const name of await readdir(directory)) {
      if (!filePattern.test(name)) continue
      const path = join(directory, name), info = await stat(path)
      if (!info.isFile()) continue
      if (Date.now() - Number(name.split('-')[1]) >= limits.retentionMs) { await unlink(path); continue }
      files.push({ path, size: info.size, created: Number(name.split('-')[1]) })
    }
    files.sort((a, b) => a.created - b.created)
    let total = files.reduce((sum, f) => sum + f.size, 0)
    for (const file of files) {
      if (total + incoming <= limits.maxBytes) break
      await unlink(file.path); total -= file.size
      if (active === file.path) active = ''
    }
  }
  async function write(line) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const length = Buffer.byteLength(line)
    if (length > limits.fileBytes || length > limits.maxBytes) return
    await clean(length)
    let size = 0
    if (active) { try { size = (await stat(active)).size } catch { active = '' } }
    if (!active || size + length > limits.fileBytes) active = join(directory, `public-${Date.now()}-${randomUUID()}.jsonl`)
    await appendFile(active, line, { encoding: 'utf8', mode: 0o600 })
  }
  function enqueue(record) {
    // Explicit projection prevents additional fields entering the file in future callers.
    const line = JSON.stringify({ time: record.time, path: record.path, method: record.method, status: record.status, durationMs: record.durationMs, size: record.size }) + '\n'
    if (queued >= limits.maxQueue) return false
    queued++
    tail = tail.then(() => write(line)).catch(warn).finally(() => { queued-- })
    return true
  }
  const sweep = () => { tail = tail.then(async () => { await mkdir(directory, { recursive: true, mode: 0o700 }); await clean() }).catch(warn) }
  sweep()
  const timer = setInterval(sweep, 60 * 60 * 1000); timer.unref()
  return { enqueue, flush: () => tail, close: async () => { clearInterval(timer); await tail } }
}

export function installAccessLog({ directory, paths, options }) {
  const approved = new Set(paths), requests = new WeakMap(), writer = createLogWriter(directory, options)
  const start = ({ request, response }) => {
    const path = (request.url || '').split('?')[0]
    if (!approved.has(path) || !['GET', 'HEAD'].includes(request.method)) return
    requests.set(response, { time: new Date().toISOString(), path, method: request.method, started: performance.now() })
  }
  const finish = ({ response }) => {
    const entry = requests.get(response)
    if (!entry) return
    requests.delete(response)
    const length = response.getHeader('content-length')
    // Null means unknown (e.g. chunked). Never inspect or buffer a response body to measure it.
    const size = typeof length === 'string' || typeof length === 'number' ? Number(length) : NaN
    writer.enqueue({ time: entry.time, path: entry.path, method: entry.method, status: response.statusCode, durationMs: Math.round((performance.now() - entry.started) * 100) / 100, size: entry.method === 'HEAD' ? 0 : Number.isFinite(size) && size >= 0 ? size : null })
  }
  channel('http.server.request.start').subscribe(start)
  channel('http.server.response.finish').subscribe(finish)
  return { ...writer, close: async () => { channel('http.server.request.start').unsubscribe(start); channel('http.server.response.finish').unsubscribe(finish); await writer.close() } }
}

if (process.env.WEBSITE_ACCESS_LOG_DIR) {
  try {
    const paths = JSON.parse(await readFile(new URL('./public-paths.json', import.meta.url), 'utf8'))
    installAccessLog({ directory: process.env.WEBSITE_ACCESS_LOG_DIR, paths })
  } catch { process.stderr.write('Website access logging unavailable; requests remain available.\n') }
}
