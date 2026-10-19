import { describe, expect, it } from 'vitest'
import { canSubmit, eventFromFailure, initialState, transition } from './gateway-state'
import type { GatewayFailure } from './gateway-client'

const failure = (code: string, extra: Partial<GatewayFailure> = {}): GatewayFailure => ({
  ok: false,
  status: 400,
  code: code as GatewayFailure['code'],
  message: 'x',
  retryAfterSeconds: null,
  ...extra
})

describe('gateway-state（ 状态机）', () => {
  it('probe → 识别网关 → needs-auth', () => {
    const started = transition(initialState(), { type: 'probe-started' })
    expect(started.state.phase).toBe('probe')
    expect(started.action).toBe('probe')
    const state = transition(started.state, { type: 'probe-gateway' }).state
    expect(state.phase).toBe('needs-auth')
  })

  it('传输未就绪 → error(network)', () => {
    const started = transition(initialState(), { type: 'probe-started' }).state
    const { state, action } = transition(started, {
      type: 'probe-unreachable',
      message: 'ECONNREFUSED'
    })
    expect(state.phase).toBe('error')
    expect(state.lastErrorCode).toBe('network')
    expect(action).toBe('stop')
  })

  it('已存 Cookie 有效 → connected(静默恢复)', () => {
    const state = transition(initialState(), { type: 'session-restored', otpEnabled: true }).state
    expect(state.phase).toBe('connected')
    expect(state.otpEnabled).toBe(true)
  })

  it('已存密码可从 needs-auth 进入 await-otp', () => {
    const needsAuth = transition(initialState(), { type: 'probe-gateway' }).state
    const { state, action } = transition(needsAuth, { type: 'stored-password-available' })
    expect(state.phase).toBe('await-otp')
    expect(action).toBe('submit-password')
  })

  it('await-credentials → 400 otp-required → await-otp + 提示输入验证码', () => {
    let state = transition(initialState(), { type: 'probe-gateway' }).state
    state = transition(state, { type: 'session-absent' }).state
    const event = eventFromFailure(failure('otp-required', { status: 400 }))
    const result = transition(state, event)
    expect(result.state.phase).toBe('await-otp')
    expect(result.action).toBe('prompt-otp')
  })

  it('统一 401:await-otp → 回退 await-credentials 且提示不区分原因', () => {
    let state = transition(initialState(), { type: 'probe-gateway' }).state
    state = transition(state, { type: 'login-requires-otp', otpEnabled: true }).state
    const result = transition(
      state,
      eventFromFailure(failure('invalid-credentials', { status: 401 }))
    )
    expect(result.state.phase).toBe('await-credentials')
    expect(result.state.message).toBe('账号或验证码错误')
    expect(result.action).toBe('prompt-credentials')
  })

  it('429 锁定:retryAfterSeconds 为唯一计时依据,期间禁止提交', () => {
    const state = transition(initialState(), { type: 'probe-gateway' }).state
    const result = transition(
      state,
      eventFromFailure(failure('too-many-attempts', { status: 429, retryAfterSeconds: 120 }))
    )
    expect(result.state.lockedForMs).toBe(120_000)
    expect(result.state.lastErrorCode).toBe('too-many-attempts')
    expect(canSubmit(result.state)).toBe(false)
    // 倒计时结束(reasonably)后可提交
    const afterTick = transition(result.state, { type: 'lock-tick', remainingMs: 0 }).state
    expect(afterTick.lockedForMs).toBe(0)
  })

  it('429 无 retryAfterSeconds → 用 ≥30s 下限(不得立即重试)', () => {
    const state = transition(initialState(), { type: 'probe-gateway' }).state
    const result = transition(state, eventFromFailure(failure('rate-limited', { status: 429 })))
    expect(result.state.lockedForMs).toBeGreaterThanOrEqual(30_000)
  })

  it('onboarding-required → 标记 onboarding 并回到密码屏', () => {
    const state = transition(initialState(), { type: 'probe-gateway' }).state
    const result = transition(
      state,
      eventFromFailure(failure('onboarding-required', { status: 401 }))
    )
    expect(result.state.needsOnboarding).toBe(true)
    expect(result.state.phase).toBe('await-credentials')
  })

  it('登录成功 → connected 且清空锁定', () => {
    const state = {
      ...transition(initialState(), { type: 'probe-gateway' }).state,
      lockedForMs: 5000
    }
    const result = transition(state, { type: 'login-succeeded', usedOtp: true })
    expect(result.state.phase).toBe('connected')
    expect(result.state.lockedForMs).toBe(0)
    expect(result.action).toBe('ready')
  })
})
