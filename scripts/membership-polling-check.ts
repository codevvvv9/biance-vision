import assert from 'node:assert/strict'
import {
  createPollingStore,
  type PollingEnvironment,
} from '../shared/src/polling.js'
class Clock implements PollingEnvironment {
  time = 100000
  visible = true
  online = true
  next = 0
  timers = new Map<number, { at: number; fn: () => void }>()
  wake = () => {}
  pause = () => {}
  listening = 0
  now = () => this.time
  random = () => 0
  active = () => this.visible && this.online
  schedule = (fn: () => void, ms: number) => {
    const id = ++this.next
    this.timers.set(id, { at: this.time + ms, fn })
    return id
  }
  cancel = (handle: unknown) => {
    this.timers.delete(handle as number)
  }
  listen = (wake: () => void, pause: () => void) => {
    this.wake = wake
    this.pause = pause
    this.listening++
    return () => {
      this.listening--
      this.wake = () => {}
      this.pause = () => {}
    }
  }
  async flush() {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  async tick(ms: number) {
    const end = this.time + ms
    for (;;) {
      const next = [...this.timers]
        .filter(([, v]) => v.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].fn()
      await this.flush()
    }
    this.time = end
    await this.flush()
  }
}
let count = 0
const pass = (s: string) => {
  count++
  console.log(`✔ ${s}`)
}
{
  const clock = new Clock()
  let calls = 0,
    finish: ((v: { seconds: number }) => void) | undefined,
    signal: AbortSignal | undefined
  const store = createPollingStore({
    environment: clock,
    load: (s) => {
      calls++
      signal = s
      return new Promise<{ seconds: number }>((r) => {
        finish = r
      })
    },
    intervalSeconds: (d) => d.seconds,
  })
  const a = store.subscribe(() => {}),
    b = store.subscribe(() => {})
  await clock.flush()
  assert.equal(calls, 1)
  void store.refresh()
  clock.wake()
  assert.equal(calls, 1)
  await clock.tick(7000)
  assert.equal(calls, 1)
  finish!({ seconds: 60 })
  await clock.flush()
  await clock.tick(59999)
  assert.equal(calls, 1)
  await clock.tick(1)
  assert.equal(calls, 2)
  a()
  assert.equal(signal?.aborted, false)
  b()
  assert.equal(signal?.aborted, true)
  assert.equal(clock.timers.size, 0)
  assert.equal(clock.listening, 0)
  pass('多组件共享请求；慢请求不重叠；最后订阅销毁后取消并清理')
}
{
  const clock = new Clock()
  let calls = 0,
    seconds = 60
  const store = createPollingStore({
      environment: clock,
      load: async () => {
        calls++
        return { seconds }
      },
      intervalSeconds: (d) => d.seconds,
    }),
    off = store.subscribe(() => {})
  await clock.flush()
  clock.visible = false
  clock.pause()
  await clock.tick(120000)
  assert.equal(calls, 1)
  clock.visible = true
  clock.wake()
  clock.wake()
  await clock.flush()
  assert.equal(calls, 2)
  seconds = 30
  await clock.tick(60000)
  assert.equal(calls, 3)
  await clock.tick(30000)
  assert.equal(calls, 4)
  clock.online = false
  clock.pause()
  await clock.tick(300000)
  assert.equal(calls, 4)
  clock.online = true
  clock.wake()
  await clock.flush()
  assert.equal(calls, 5)
  off()
  pass('隐藏与离线暂停；恢复只查一次；配置从 60 秒切至 30 秒')
}
{
  const clock = new Clock()
  let calls = 0
  const store = createPollingStore({
    environment: clock,
    load: async () => {
      calls++
      return { seconds: 60 }
    },
    intervalSeconds: (d) => d.seconds,
  })
  const off = store.subscribe(() => {})
  await clock.flush()
  clock.wake()
  clock.wake()
  await clock.tick(1000)
  assert.equal(calls, 1)
  off()
  pass('首次查询刚完成后的聚焦／可见事件不再额外补发请求')
}
{
  const clock = new Clock()
  let calls = 0,
    fail = false
  const store = createPollingStore({
      environment: clock,
      load: async () => {
        calls++
        if (fail)
          throw Object.assign(new Error('temporary'), {
            retryAfterSeconds: 180,
          })
        return { seconds: 30 }
      },
      intervalSeconds: (d) => d.seconds,
    }),
    off = store.subscribe(() => {})
  await clock.flush()
  fail = true
  await clock.tick(30000)
  assert.equal(calls, 2)
  assert.ok(store.getSnapshot().data)
  assert.equal(store.getSnapshot().error, 'temporary')
  await clock.tick(179999)
  assert.equal(calls, 2)
  clock.wake()
  store.invalidate()
  await clock.flush()
  assert.equal(calls, 2)
  await clock.tick(1)
  assert.equal(calls, 3)
  fail = false
  await clock.tick(180000)
  assert.equal(calls, 4)
  assert.equal(store.getSnapshot().error, '')
  await clock.tick(30000)
  assert.equal(calls, 5)
  off()
  pass('失败保留数据；聚焦／操作不绕过 Retry-After，成功恢复正常间隔')
}
{
  const clock = new Clock()
  let signal: AbortSignal | undefined,
    calls = 0
  const store = createPollingStore({
      environment: clock,
      load: (s) => {
        calls++
        signal = s
        return new Promise<{ seconds: number }>(() => {})
      },
      intervalSeconds: (d) => d.seconds,
    }),
    off = store.subscribe(() => {})
  await clock.tick(8000)
  assert.equal(signal?.aborted, true)
  assert.ok(store.getSnapshot().error.includes('timed out'))
  await clock.tick(120000)
  assert.equal(calls, 2)
  off()
  pass('8 秒超时终止；超时后退避重试')
}
{
  const clock = new Clock()
  let oldFinish: ((v: { user: string }) => void) | undefined
  const old = createPollingStore({
      environment: clock,
      load: () =>
        new Promise<{ user: string }>((r) => {
          oldFinish = r
        }),
      intervalSeconds: () => 60,
    }),
    off = old.subscribe(() => {})
  await clock.flush()
  off()
  const newer = createPollingStore({
      environment: clock,
      load: async () => ({ user: 'new' }),
      intervalSeconds: () => 60,
    }),
    offNew = newer.subscribe(() => {})
  await clock.flush()
  oldFinish!({ user: 'old' })
  await clock.flush()
  assert.equal(newer.getSnapshot().data?.user, 'new')
  assert.equal(old.getSnapshot().data, undefined)
  offNew()
  pass('退出／切换账号后旧响应不得覆盖新状态')
}
{
  const clock = new Clock()
  let calls = 0,
    boundary = clock.time + 10000
  const store = createPollingStore({
      environment: clock,
      load: async () => {
        calls++
        return { seconds: 300, boundary }
      },
      intervalSeconds: (d) => d.seconds,
      boundaryAt: (d) => d.boundary,
    }),
    off = store.subscribe(() => {})
  await clock.flush()
  clock.visible = false
  clock.pause()
  await clock.tick(2000)
  clock.visible = true
  clock.wake()
  await clock.flush()
  await clock.tick(8000)
  assert.equal(calls, 3)
  off()
  pass('到期边界补查，隐藏再恢复不丢失边界刷新')
}
{
  const clock = new Clock()
  let calls = 0,
    seconds = 300
  const store = createPollingStore({
    environment: clock,
    load: async () => {
      calls++
      return { seconds }
    },
    intervalSeconds: (d) => d.seconds,
  })
  const off = store.subscribe(() => {})
  await clock.flush()
  store.invalidate()
  store.invalidate()
  await clock.tick(0)
  assert.equal(calls, 2)
  await clock.tick(299999)
  assert.equal(calls, 2)
  seconds = Number.NaN
  await clock.tick(1)
  assert.equal(calls, 3)
  await clock.tick(59999)
  assert.equal(calls, 3)
  await clock.tick(1)
  assert.equal(calls, 4)
  off()
  pass('300 秒上界、同轮多次失效合并与异常间隔安全回退')
}
{
  const clock = new Clock()
  let calls = 0
  const store = createPollingStore<{ seconds: number }>({
    environment: clock,
    load: () => {
      calls++
      throw new Error('sync failure')
    },
    intervalSeconds: (d) => d.seconds,
  })
  const off = store.subscribe(() => {})
  await clock.flush()
  assert.equal(store.getSnapshot().error, 'sync failure')
  await clock.tick(120000)
  assert.equal(calls, 2)
  await clock.tick(240000)
  assert.equal(calls, 3)
  await clock.tick(300000)
  assert.equal(calls, 4)
  off()
  pass('同步异常也释放请求锁；指数退避封顶 300 秒')
}
console.log(`轮询检查通过：${count} 组`)
