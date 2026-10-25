/**
 * 密码计算并发限制（P1-3 主批，方案 §4.3）：scrypt 是 CPU 密集运算，同步实现
 * 阻塞事件循环；异步化后仍需全进程并发上限（默认并发 2、排队最多 10）——
 * 超限 503 concurrency_limited（密码校验请求不无限堆积，队列便宜先拒）。
 * 存储格式不变（salt$hash，scryptSync 兼容既有散列）。
 */

export class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number,
  ) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return
    }
    if (this.queue.length >= this.maxQueue) {
      throw Object.assign(new Error('系统繁忙，请稍后重试'), { statusCode: 503, code: 'concurrency_limited' })
    }
    await new Promise<void>((resolve) => this.queue.push(resolve))
  }

  release(): void {
    const next = this.queue.shift()
    if (next !== undefined) {
      next() // 名额直接转移给队首等待者（active 不减）
      return
    }
    this.active = Math.max(0, this.active - 1)
  }

  /** 当前状态（诊断/断言） */
  stats(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.queue.length }
  }
}

const scryptSem = new Semaphore(2, 10)

import crypto from 'node:crypto'

/** 限流异步 scrypt（并发 2 / 排队 10，超限 503） */
export function scryptLimited(password: string, salt: string, keylen: number): Promise<Buffer> {
  return scryptSem.acquire().then(
    () =>
      new Promise<Buffer>((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, (err, derived) => {
          scryptSem.release()
          if (err !== null) reject(err)
          else resolve(derived)
        })
      }),
  )
}
