import { Agent, get } from 'node:http'
/** Local isolated HTTP/PG baseline, not a production-host certification. Default: 1,000 pages for 15 minutes. */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import assert from 'node:assert/strict'
const requireServer = createRequire(
    new URL('../server/package.json', import.meta.url),
  ),
  postgres = requireServer('postgres') as (
    url: string,
    opts?: object,
  ) => { unsafe: (q: string) => Promise<any[]>; end: () => Promise<void> }
const rootUrl = new URL(
    process.env.ACCESS_TEST_PG_URL ||
      'postgresql://postgres:postgres@127.0.0.1:5434/postgres',
  ),
  root = postgres(rootUrl.href, { max: 1 }),
  dbName = `bv_member_load_${randomUUID().replaceAll('-', '')}`,
  dir = await mkdtemp(path.join(tmpdir(), 'bv-member-load-'))
const duration = Number(process.env.MEMBERSHIP_LOAD_SECONDS || 900),
  pages = Number(process.env.MEMBERSHIP_LOAD_PAGES || 1000)
let exitCode = 0,
  app: ReturnType<typeof Fastify> | undefined
try {
  await root.unsafe(`CREATE DATABASE "${dbName}" OWNER biance_app`)
  rootUrl.pathname = `/${dbName}`
  process.env.DATABASE_URL = rootUrl.href
  process.env.BV_DATA_DIR = dir
  process.env.WEBSITE_PUBLIC_CONFIG_DIR = path.join(dir, 'public')
  const { initDb, getDb, sql } = await import('../server/src/db.js')
  assert.equal(await initDb(), true)
  const db = getDb()!
  const { registerMembershipUserRoutes } = await import(
    '../server/src/membership/routes.js'
  )
  const version = randomUUID()
  await db.execute(
    sql`INSERT INTO membership_plan_versions(id,plan_id,revision,config,created_by) SELECT ${version},'monthly',1,draft,'load-test' FROM membership_plans WHERE id='monthly'`,
  )
  await db.execute(
    sql`INSERT INTO users(id,username,password_hash,role,chat_policy) SELECT 'load-'||n,'load_'||n,'not-a-login-hash','user','{"disabled":false}'::jsonb FROM generate_series(1,${pages}) AS n`,
  )
  await db.execute(
    sql`INSERT INTO membership_accounts(username,updated_by) SELECT username,'load-test' FROM users WHERE username LIKE 'load_%'`,
  )
  await db.execute(
    sql`INSERT INTO membership_grants(id,username,version_id,starts_at,ends_at,note,created_by) SELECT username,username,${version},now(),now()+interval '1 month','load-test','load-test' FROM membership_accounts`,
  )
  app = Fastify({ logger: false })
  registerMembershipUserRoutes(app, {
    requireSession: (req) =>
      ({ username: String(req.headers['x-load-user']) }) as never,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string')
    throw new Error('HTTP address unavailable')
  const base = `http://127.0.0.1:${address.port}`
  const agent = new Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 50,
  })
  const errorSamples: string[] = []
  let errors = 0,
    requests = 0,
    maxInFlight = 0,
    inFlight = 0
  const steady: number[] = [],
    burst: number[] = []
  const request = async (i: number, target: number[]) => {
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    const start = performance.now()
    try {
      await new Promise<void>((resolve, reject) => {
        const req = get(
          `${base}/api/users/me/membership`,
          { agent, headers: { 'x-load-user': `load_${i}` } },
          (response) => {
            let body = ''
            response.setEncoding('utf8')
            response.on('data', (chunk) => {
              body += chunk
            })
            response.on('end', () => {
              try {
                const v = JSON.parse(body) as {
                  managed: boolean
                  refresh: { userSeconds: number }
                }
                if (
                  response.statusCode !== 200 ||
                  !v.managed ||
                  v.refresh.userSeconds !== 60
                )
                  throw new Error(`Unexpected response ${response.statusCode}`)
                resolve()
              } catch (e) {
                reject(e)
              }
            })
          },
        )
        req.on('error', reject)
        req.setTimeout(8000, () => req.destroy(new Error('request timed out')))
      })
    } catch (e) {
      errors++
      if (errorSamples.length < 3) errorSamples.push(String(e))
    } finally {
      target.push(performance.now() - start)
      requests++
      inFlight--
    }
  }
  // Warm config once, then explicitly measure simultaneous entry separately from steady polling.
  await request(1, burst)
  console.log(
    `Starting local baseline: ${pages} visible pages, ${duration}s, 60s + 0–10% jitter. Synthetic sessions; real HTTP and PostgreSQL.`,
  )
  await Promise.all(
    Array.from({ length: pages }, (_, i) => request(i + 1, burst)),
  )
  console.log('Burst errors:', errorSamples)
  const started = Date.now(),
    ends = started + duration * 1000
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))
  const ticker = setInterval(
    () =>
      console.log(
        `load ${((Date.now() - started) / 1000) | 0}s: ${requests} requests, ${errors} errors, in-flight ${inFlight}`,
      ),
    30000,
  )
  const timers = Array.from({ length: pages }, (_, i) =>
    (async () => {
      await sleep(Math.min(duration * 1000, (i / pages) * 60000))
      while (Date.now() < ends) {
        await request(i + 1, steady)
        const delay = 60000 * (1 + Math.random() * 0.1)
        if (Date.now() + delay >= ends) break
        await sleep(delay)
      }
    })(),
  )
  const configChange = setTimeout(
    () => {
      void db.execute(
        sql`UPDATE membership_refresh_settings SET revision=revision+1,updated_at=now(),updated_by='load-test-update' WHERE id='global'`,
      )
    },
    Math.min(duration * 500, 450000),
  )
  await Promise.all(timers)
  await sleep(Math.max(0, ends - Date.now()))
  clearInterval(ticker)
  clearTimeout(configChange)
  agent.destroy()
  const pct = (list: number[], p: number) => {
    const v = [...list].sort((a, b) => a - b)
    return Number(
      (v[Math.min(v.length - 1, Math.ceil(v.length * p) - 1)] ?? 0).toFixed(2),
    )
  }
  const report = {
    kind: 'local-isolated-service-baseline',
    timestamp: new Date().toISOString(),
    durationSeconds: (Date.now() - started) / 1000,
    pages,
    intervalSeconds: 60,
    syntheticSession: true,
    loadClientMaxSockets: 50,
    requests,
    errors,
    errorRate: errors / Math.max(1, requests),
    maxInFlight,
    errorSamples,
    steady: {
      samples: steady.length,
      p50: pct(steady, 0.5),
      p95: pct(steady, 0.95),
      p99: pct(steady, 0.99),
    },
    entryBurst: {
      samples: burst.length,
      p95: pct(burst, 0.95),
      p99: pct(burst, 0.99),
    },
    limitations:
      'Local shared PostgreSQL container; synthetic session resolution excludes authentication and reverse-proxy overhead. Production-equivalent deployment still requires its own acceptance run.',
  }
  const reportPath =
    process.env.MEMBERSHIP_LOAD_REPORT ||
    path.join(tmpdir(), 'bv-membership-load-report.json')
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  console.log(`Report: ${reportPath}`)
  assert.ok(report.steady.p95 <= 300, 'steady p95 > 300ms')
  assert.ok(report.steady.p99 <= 1000, 'steady p99 > 1s')
  assert.ok(report.entryBurst.p95 <= 300, 'entry burst p95 > 300ms (includes load-client queue)')
  assert.ok(report.entryBurst.p99 <= 1000, 'entry burst p99 > 1s')
  assert.ok(report.errorRate < 0.001, 'error rate >= 0.1%')
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  await app?.close()
  await root
    .unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid<>pg_backend_pid()`,
    )
    .catch(() => {})
  await root.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`).catch(() => {})
  await root.end()
  await rm(dir, { recursive: true, force: true })
}
process.exit(exitCode)
