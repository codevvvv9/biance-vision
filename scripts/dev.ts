#!/usr/bin/env node
/**
 * biance-vision 开发启动器
 * - 启动前探测端口：被占用则自动向后找可用端口
 * - 后端端口通过 PORT 注入，前端端口通过 --port 注入，
 *   代理目标通过 BV_API_PORT 注入给 vite.config.ts，保证两端联动
 * - 轮询 /api/health 确认后端就绪后再给出访问地址
 */
import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const PREFERRED_API = Number(process.env.PORT) || 3200
const PREFERRED_WEB = Number(process.env.BV_WEB_PORT) || 17834

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface PickedPort {
  port: number
  changed: boolean
}

/** lsof 查端口是否被任意进程监听；返回 true/false，lsof 不可用时返回 null */
function lsofAnyListener(port: number): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], (err, stdout) => {
      if (err) resolve(err.code === 1 ? false : null)
      else resolve(stdout.trim().length > 0)
    })
  })
}

/** 实际 bind 一次 127.0.0.1:port 验证可绑定 */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

async function isFree(port: number): Promise<boolean> {
  // 双重检测：lsof 能发现通配监听（bind 测试探测不到的阴影占用）
  const lsof = await lsofAnyListener(port)
  if (lsof === true) return false
  return canBind(port)
}

async function pickPort(preferred: number): Promise<PickedPort> {
  for (let p = preferred; p < preferred + 100; p++) {
    if (await isFree(p)) return { port: p, changed: p !== preferred }
  }
  throw new Error(`从 ${preferred} 起连续 100 个端口均被占用，请手动指定端口（PORT=xxx npm run dev）`)
}

function attach(child: Child, tag: string, color: string): void {
  const prefix = `\x1b[${color}m[${tag}]\x1b[0m`
  const pipe = (stream: NodeJS.ReadableStream): void => {
    let buf = ''
    stream.on('data', (chunk: Buffer | string) => {
      buf += chunk
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (line.trim()) process.stdout.write(`${prefix} ${line}\n`)
      }
    })
  }
  pipe(child.stdout)
  pipe(child.stderr)
}

async function waitApi(port: number, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      })
      if (res.ok) return true
    } catch {
      /* 还没起来，继续等 */
    }
    await sleep(400)
  }
  return false
}

/** spawn(stdio: ['ignore','pipe','pipe']) 的返回类型：stdin 为 null，stdout/stderr 可读 */
type Child = import('node:child_process').ChildProcessByStdio<null, import('node:stream').Readable, import('node:stream').Readable>

const killGroup = (c: Child, sig: NodeJS.Signals): void => {
  if (c.pid === undefined) return
  try {
    process.kill(-c.pid, sig) // 杀整个进程组（detached 建组）
  } catch {
    /* noop */
  }
}

const children: Child[] = []
let shuttingDown = false

function shutdown(code = 0): void {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    if (c.exitCode !== null) continue
    killGroup(c, 'SIGTERM')
    try {
      c.kill('SIGTERM')
    } catch {
      /* noop */
    }
  }
  setTimeout(() => {
    for (const c of children) {
      if (c.exitCode !== null) continue
      killGroup(c, 'SIGKILL')
    }
    process.exit(code)
  }, 1500)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function say(name: string, picked: PickedPort, preferred: number): string {
  return picked.changed
    ? `${name} 端口 ${picked.port}（${preferred} 被占用，已自动切换）`
    : `${name} 端口 ${picked.port}`
}

/** 探测 PostgreSQL 端口（读 DATABASE_URL，默认 5434）；800ms 内连不上返回 false */
async function probePgPort(): Promise<number | false> {
  let port = 5434
  let host = '127.0.0.1'
  try {
    const u = new URL(process.env.DATABASE_URL ?? 'postgresql://biance_app:biance_app@127.0.0.1:5434/biance_vision')
    port = Number(u.port) || 5432
    host = u.hostname
  } catch {
    /* 用默认值 */
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    const done = (r: number | false): void => {
      sock.destroy()
      resolve(r)
    }
    sock.setTimeout(800, () => done(false))
    sock.once('connect', () => done(port))
    sock.once('error', () => done(false))
  })
}

async function main(): Promise<void> {
  const api = await pickPort(PREFERRED_API)
  const web = await pickPort(PREFERRED_WEB)

  console.log(`\x1b[36m[bv]\x1b[0m ${say('后端', api, PREFERRED_API)}`)
  console.log(`\x1b[36m[bv]\x1b[0m ${say('前端', web, PREFERRED_WEB)}`)

  // 提示 PostgreSQL 状态（未启动时服务端自动降级 JSON 存储，不影响运行）
  const pgPort = await probePgPort()
  if (pgPort === false) {
    console.log(`\x1b[36m[bv]\x1b[0m \x1b[33mPostgreSQL 未启动，将使用 JSON 文件存储（docker compose up -d 可启用）\x1b[0m`)
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(api.port),
    BV_API_PORT: String(api.port),
    BV_WEB_PORT: String(web.port),
    FORCE_COLOR: '1',
  }
  // 跟随实际调用方的包管理器（pnpm dev → pnpm；npm run dev → npm）
  const usesPnpm = (process.env.npm_config_user_agent ?? '').startsWith('pnpm')
  const pm = process.platform === 'win32' ? (usesPnpm ? 'pnpm.cmd' : 'npm.cmd') : usesPnpm ? 'pnpm' : 'npm'
  const runIn = (pkg: string, script: string, args: string[] = []): string[] =>
    usesPnpm
      ? ['--filter', pkg, 'run', script, ...args]
      : ['run', script, '-w', pkg, '--', ...args]

  const server = spawn(pm, runIn('biance-vision-server', 'dev'), {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const webProc = spawn(pm, runIn('biance-vision-web', 'dev', ['--port', String(web.port)]), {
    cwd: ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(server, webProc)
  attach(server, 'server', '36') // cyan
  attach(webProc, 'web', '35') // magenta

  for (const [c, name] of [
    [server, '后端'],
    [webProc, '前端'],
  ] as const) {
    c.on('exit', (code: number | null) => {
      if (!shuttingDown) {
        console.error(`\x1b[36m[bv]\x1b[0m \x1b[31m${name}进程退出（code ${code}），正在停止全部服务…\x1b[0m`)
        shutdown(code ?? 1)
      }
    })
  }

  if (await waitApi(api.port)) {
    console.log(`\x1b[36m[bv]\x1b[0m API  就绪 \x1b[2mhttp://127.0.0.1:${api.port}/api/health\x1b[0m`)
    console.log(`\x1b[36m[bv]\x1b[0m 页面 \x1b[1mhttp://localhost:${web.port}\x1b[0m  （Ctrl+C 停止）\n`)
  } else {
    console.error(`\x1b[36m[bv]\x1b[0m \x1b[33m后端 ${api.port} 未在 15s 内就绪，请检查上方日志\x1b[0m`)
  }
}

main().catch((err: Error) => {
  console.error(`\x1b[31m[bv] 启动失败: ${err.message}\x1b[0m`)
  shutdown(1)
})
