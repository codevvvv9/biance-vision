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
