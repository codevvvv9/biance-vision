import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createPollingStore } from 'biance-vision-brooks/polling'

test('initial 提供时首帧即带数据（服务端渲染注入）', () => {
  const seed = { v: 7 }
  const store = createPollingStore<{ v: number }>({
    load: async () => ({ v: 1 }),
    intervalSeconds: () => 60,
    initial: seed,
    initialUpdatedAt: 123456,
  })
  assert.equal(store.getSnapshot().data, seed)
  assert.equal(store.getSnapshot().loading, false)
  assert.equal(store.getSnapshot().updatedAt, 123456)
})

test('未提供 initial 时首帧为 undefined（既有行为不变）', () => {
  const store = createPollingStore<{ v: number }>({
    load: async () => ({ v: 1 }),
    intervalSeconds: () => 60,
  })
  assert.equal(store.getSnapshot().data, undefined)
})

test('失败退避期内普通 refresh 被静默吞掉，refresh(true) 强制重试并恢复', async () => {
  let loads = 0
  const timers: Array<() => void> = []
  const env = {
    now: () => 0,
    random: () => 0,
    active: () => true,
    schedule: (fn: () => void) => { timers.push(fn); return fn },
    cancel: (handle: unknown) => {
      const index = timers.indexOf(handle as () => void)
      if (index >= 0) timers.splice(index, 1)
    },
    listen: () => () => {},
  }
  const store = createPollingStore<{ v: number }>({
    load: async () => {
      loads += 1
      if (loads < 2) throw new Error('boom')
      return { v: 42 }
    },
    intervalSeconds: () => 60,
    environment: env,
  })
  const unlisten = store.subscribe(() => {})
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(loads, 1)
  assert.match(store.getSnapshot().error, /boom/)
  assert.ok(timers.length >= 1, '失败后应安排退避定时器')

  // 退避期内：普通 refresh 只会改期，不发起新请求（曾被定价页「重试」按钮撞上）
  await store.refresh()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(loads, 1, '退避门内的普通 refresh 不应触发加载')

  // 用户显式重试：force 绕过退避门
  await store.refresh(true)
  assert.equal(loads, 2)
  assert.equal(store.getSnapshot().data?.v, 42)
  assert.equal(store.getSnapshot().error, '')
  unlisten()
})
