/**
 * Authentication state transitions.
 *
 * unknown → probe → needs-auth → connected, await-credentials, await-otp, or error.
 * A valid session restores connected state. A stored password can submit silently before
 * the UI requests an OTP. Rate limits prevent further authentication requests.
 */
import type { AuthPhase as SharedAuthPhase, AuthStateSnapshot } from '@shared/contracts'
import type { GatewayFailure } from './gateway-client'

export type AuthPhase = SharedAuthPhase
export type AuthState = AuthStateSnapshot

export function initialState(): AuthState {
  return {
    phase: 'unknown',
    needsOnboarding: false,
    otpEnabled: false,
    lockedForMs: 0,
    message: null,
    lastErrorCode: null
  }
}

/** 状态机可接受的事件 */
export type AuthEvent =
  | { type: 'probe-started' }
  | { type: 'probe-gateway' } // 302→/login 或 401 unauthenticated
  | { type: 'probe-unreachable'; message: string }
  | { type: 'session-restored'; otpEnabled: boolean } // 带 Cookie settings=200
  | { type: 'session-absent' } // 无 Cookie / 401
  | { type: 'stored-password-available' } // Use a stored password before requesting an OTP.
  | { type: 'login-succeeded'; usedOtp: boolean }
  | { type: 'login-requires-otp'; otpEnabled: boolean } // 400 otp-required
  | { type: 'credentials-rejected' } // 401 invalid-credentials(统一)
  | { type: 'rate-limited'; retryAfterSeconds: number | null; message: string }
  | { type: 'lock-tick'; remainingMs: number } // 倒计时刷新(只改展示)
  | { type: 'onboarding-required' }
  | { type: 'failed'; message: string; code?: string }
  | { type: 'reset' }

export interface AuthTransition {
  state: AuthState

  action:
    'none' | 'probe' | 'submit-password' | 'prompt-credentials' | 'prompt-otp' | 'ready' | 'stop'
}

/** 由失败结果推导事件(把网关错误码收敛为状态机事件) */
export function eventFromFailure(failure: GatewayFailure): AuthEvent {
  switch (failure.code) {
    case 'otp-required':
      return { type: 'login-requires-otp', otpEnabled: true }
    case 'invalid-credentials':
    case 'invalid-otp':
    case 'invalid-backup-code':
      return { type: 'credentials-rejected' }
    case 'rate-limited':
    case 'too-many-attempts':
      return {
        type: 'rate-limited',
        retryAfterSeconds: failure.retryAfterSeconds,
        message: failure.message
      }
    case 'onboarding-required':
      return { type: 'onboarding-required' }
    case 'unauthenticated':
      return { type: 'session-absent' }
    default:
      return { type: 'failed', message: failure.message, code: failure.code }
  }
}

export function transition(state: AuthState, event: AuthEvent): AuthTransition {
  switch (event.type) {
    case 'reset':
      return { state: initialState(), action: 'none' }

    case 'probe-started':
      return { state: { ...state, phase: 'probe', message: null }, action: 'probe' }

    case 'probe-gateway':
      return {
        state: { ...state, phase: 'needs-auth', message: null },
        action: 'none'
      }

    case 'probe-unreachable':
      return {
        state: { ...state, phase: 'error', message: event.message, lastErrorCode: 'network' },
        action: 'stop'
      }

    case 'session-restored':
      return {
        state: {
          ...state,
          phase: 'connected',
          otpEnabled: event.otpEnabled,
          needsOnboarding: false,
          lockedForMs: 0,
          message: null,
          lastErrorCode: null
        },
        action: 'ready'
      }

    case 'session-absent':
      return {
        state: {
          ...state,
          phase: state.phase === 'needs-auth' ? 'await-credentials' : 'needs-auth',
          message: null,
          lastErrorCode: null
        },
        action: 'none'
      }

    case 'stored-password-available':
      // The password is submitted by the main process; the UI waits for an OTP.
      if (state.phase !== 'needs-auth') return { state, action: 'none' }
      return {
        state: { ...state, phase: 'await-otp', message: null },
        action: 'submit-password'
      }

    case 'login-succeeded':
      return {
        state: {
          ...state,
          phase: 'connected',
          lockedForMs: 0,
          message: null,
          lastErrorCode: null,
          otpEnabled: event.usedOtp ? true : state.otpEnabled
        },
        action: 'ready'
      }

    case 'login-requires-otp':
      return {
        state: {
          ...state,
          phase: 'await-otp',
          otpEnabled: event.otpEnabled,
          message: null,
          lastErrorCode: null
        },
        action: 'prompt-otp'
      }

    case 'credentials-rejected':
      return {
        state: {
          ...state,
          phase: state.phase === 'await-otp' ? 'await-credentials' : state.phase,
          lastErrorCode: 'invalid-credentials',
          message: '账号或验证码错误'
        },
        action: state.phase === 'await-otp' ? 'prompt-credentials' : 'none'
      }

    case 'rate-limited':
      return {
        state: {
          ...state,
          // 锁定期间保持当前输入阶段(倒计时结束后可重试)
          lockedForMs:
            typeof event.retryAfterSeconds === 'number' && event.retryAfterSeconds > 0
              ? event.retryAfterSeconds * 1000
              : retryFloorMs,
          lastErrorCode: event.retryAfterSeconds ? 'too-many-attempts' : 'rate-limited',
          message: event.message
        },
        action: 'none'
      }

    case 'lock-tick':
      return { state: { ...state, lockedForMs: Math.max(0, event.remainingMs) }, action: 'none' }

    case 'onboarding-required':
      return {
        state: {
          ...state,
          needsOnboarding: true,
          phase: 'await-credentials',
          lastErrorCode: 'onboarding-required',
          message: '该实例需要先设置新的登录密码'
        },
        action: 'prompt-credentials'
      }

    case 'failed':
      return {
        state: {
          ...state,
          phase: 'error',
          message: event.message,
          lastErrorCode: event.code ?? 'unexpected'
        },
        action: 'stop'
      }

    default:
      return { state, action: 'none' }
  }
}

/** 无 retryAfterSeconds 时的最短锁定(设计:≥30s) */
export const retryFloorMs = 30_000

/** 是否允许发起认证请求(锁定期间禁止;needs-auth 亦可直接提交,UI 不必先切阶段) */
export function canSubmit(state: AuthState): boolean {
  if (state.lockedForMs > 0) return false
  return (
    state.phase === 'needs-auth' ||
    state.phase === 'await-credentials' ||
    state.phase === 'await-otp'
  )
}
