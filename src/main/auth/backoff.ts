/**
 *
 * 纪律:
 * - 登录尝试**串行**,无后台重试风暴;
 * - 每个实例独立退避;**`retryAfterSeconds` 是唯一计时依据**(429 全局限流 / 锁定);
 * - 全局并发认证闸(默认 ≤2),多实例并行登录时不得同时压网关。
 */

export interface BackoffState {
  /** 是否仍在等待窗口内(此期间禁止发起认证请求) */
  blocked: boolean
  /** 剩余等待毫秒(仅用于 UI 倒计时展示) */
  remainingMs: number
  /** 最近一次退避原因(面向用户) */
  reason: string | null
}

export interface BackoffController {
  /** 记录一次 429:以服务端 retryAfterSeconds 为唯一依据(缺省用 minWaitMs) */
  recordRateLimited(retryAfterSeconds?: number | null, reason?: string): void
  /** 记录一次失败(非 429):不做计时,仅清理? —— 由调用方决定,这里保持状态 */
  state(): BackoffState
  /** 是否允许发起下一次尝试 */
  canAttempt(): boolean
  /** 单次成功:清除退避 */
  recordSuccess(): void
  /** 供测试/UI 注入时钟 */
  now(): number
}

export interface BackoffOptions {
  /** 无 retryAfterSeconds 时的最短等待(设计:≥30s) */
  minWaitMs?: number
  /** 上限(防止异常大的 retryAfterSeconds 把实例锁死过久) */
  maxWaitMs?: number
  now?: () => number
}

export function createBackoff(options: BackoffOptions = {}): BackoffController {
  const minWaitMs = options.minWaitMs ?? 30_000
  const maxWaitMs = options.maxWaitMs ?? 15 * 60 * 1000
  const now = options.now ?? (() => Date.now())
  let until = 0
  let reason: string | null = null

  return {
    recordRateLimited(retryAfterSeconds, why) {
      const seconds =
        typeof retryAfterSeconds === 'number' &&
        Number.isFinite(retryAfterSeconds) &&
        retryAfterSeconds > 0
          ? retryAfterSeconds
          : null
      // retryAfterSeconds 存在时以服务端为准(它是唯一计时依据);缺失时才用 ≥30s 下限
      const waitMs = Math.min(seconds === null ? minWaitMs : seconds * 1000, maxWaitMs)
      until = now() + waitMs
      reason = why ?? '请求过于频繁，已暂停自动重试'
    },
    recordSuccess() {
      until = 0
      reason = null
    },
    state() {
      const remainingMs = Math.max(0, until - now())
      return { blocked: remainingMs > 0, remainingMs, reason: remainingMs > 0 ? reason : null }
    },
    canAttempt() {
      return now() >= until
    },
    now
  }
}

/**
 * 全局并发闸:多实例认证不得同时压网关(默认 2)。
 * 以 Promise 队列实现,`run` 在获得名额后执行并在 finally 释放。
 */
export interface ConcurrencyGate {
  run<T>(task: () => Promise<T>): Promise<T>
  active(): number
  queued(): number
}

export function createConcurrencyGate(limit = 2): ConcurrencyGate {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('并发上限必须是正整数')
  let active = 0
  const queue: Array<() => void> = []

  const acquire = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (active < limit) {
        active += 1
        resolve()
        return
      }
      queue.push(() => {
        active += 1
        resolve()
      })
    })

  const release = (): void => {
    active -= 1
    const next = queue.shift()
    if (next) next()
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await task()
      } finally {
        release()
      }
    },
    active: () => active,
    queued: () => queue.length
  }
}
