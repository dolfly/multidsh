/**
 *
 * 职责(不 import electron):
 * - `probeAndRestore()`:识别网关(302→/login、401 unauthenticated)并**优先静默恢复**
 *   (带已存 Cookie 打 `GET /login-api/settings` = 200 → 直接 connected,不打扰用户);
 * - `login(password, otp?)`:提交密码;400 otp-required → 进入验证码阶段;200 → connected;
 * - `logout()`:清 Cookie 并回到 needs-auth;
 * - 429(rate-limited / too-many-attempts):以 `retryAfterSeconds` 为唯一计时依据,
 *   锁定期间 `canSubmit()` 为 false(UI 据此显示倒计时并禁用提交);
 * - 凭据纪律:密码/验证码只在内存中停留,不落盘、不写日志。
 */
import { createBackoff, type BackoffController } from './backoff'
import {
  createGatewayClient,
  type GatewayClient,
  type GatewayFailure,
  type GatewayResult
} from './gateway-client'
import { createCookieJar, type CookieJar } from './cookie-jar'
import {
  canSubmit,
  eventFromFailure,
  initialState,
  type AuthState,
  transition
} from './gateway-state'
import type { HttpAuthDetection } from '@shared/contracts'
import { detectAuthMode } from './detect'

type AuthDetection = HttpAuthDetection

export interface AuthClientOptions {
  instanceId: string
  /** 归一化端点(含 basePath),如 https://gw.example.com/dsh */
  endpointUrl: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** 注入既有 Cookie 罐(跨启动复用/测试) */
  jar?: CookieJar
  now?: () => number
  /** 状态变化通知(UI 订阅点) */
  onState?: (state: AuthState) => void
  /** 登录成功(密码/验证码通过)后回调：此时会话 Cookie 已写入罐，可供工作区刷新使用 */
  onLoginSucceeded?: () => void
}

export interface AuthClient {
  readonly instanceId: string
  readonly jar: CookieJar
  readonly backoff: BackoffController
  state(): AuthState
  probeAndRestore(): Promise<AuthDetection>
  /** 提交密码(可同时带验证码完成单请求 2FA) */
  login(password: string, otp?: string): Promise<AuthState>
  logout(): Promise<AuthState>
  /** 是否持有会话 Cookie(不代表服务端仍有效) */
  hasSession(): boolean
  /** 刷新锁定剩余量(供 UI 倒计时调用;锁定由 backoff 单一计时来源派生) */
  tick(): AuthState
}

export function createAuthClient(options: AuthClientOptions): AuthClient {
  const gateway: GatewayClient = createGatewayClient({
    baseUrl: options.endpointUrl,
    jar: options.jar ?? createCookieJar(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
  })
  const backoff = createBackoff(options.now ? { now: options.now } : {})
  let state = initialState()

  function publish(next: AuthState): AuthState {
    state = next
    options.onState?.(next)
    return next
  }

  /**
   * 导致 429 后永久锁定)。每次读取状态/守卫前先同步一次。
   */
  function syncLock(): AuthState {
    const remaining = backoff.state().remainingMs
    if (remaining === state.lockedForMs) return state
    return publish(
      remaining > 0
        ? { ...state, lockedForMs: remaining }
        : { ...state, lockedForMs: 0, message: null, lastErrorCode: null }
    )
  }

  function apply(event: Parameters<typeof transition>[1]): AuthState {
    const result = transition(state, event)
    return publish(result.state)
  }

  /** 429/锁定:记录退避并把状态推进到锁定展示 */
  function handleFailure(failure: Extract<GatewayResult<unknown>, { ok: false }>): AuthState {
    if (failure.code === 'rate-limited' || failure.code === 'too-many-attempts') {
      backoff.recordRateLimited(failure.retryAfterSeconds, failure.message)
    }
    return apply(eventFromFailure(failure))
  }

  return {
    instanceId: options.instanceId,
    jar: gateway.jar,
    backoff,
    state: () => syncLock(),
    hasSession: () => gateway.hasSession(),

    async probeAndRestore() {
      apply({ type: 'probe-started' })
      // 1) 会话静默恢复:带已有 Cookie 试 settings
      if (gateway.hasSession()) {
        const settings = await gateway.settings()
        if (settings.ok) {
          // OTP 验证,不检查 onboarding,所以「会话有效但欠引导改密」时 settings 仍返回

          // 因此这里再做一次**带 Cookie 的页面探测**,让页面门禁的证据优先于 settings 200。
          const gate = await detectEndpoint(options.endpointUrl, options, gateway.jar.header())
          if (gate.mode === 'gateway' && gate.gatewayEvidence === 'onboarding') {
            apply({ type: 'probe-gateway' })
            apply({ type: 'session-absent' })
            apply({ type: 'onboarding-required' })
            return gate
          }
          if (gate.mode === 'gateway' && gate.gatewayEvidence === 'otp-page') {
            apply({ type: 'probe-gateway' })
            apply({ type: 'session-absent' })
            apply({ type: 'login-requires-otp', otpEnabled: true })
            return gate
          }
          // settings 200 只说明该端点本身不需要会话；页面 302 → /login 才是会话失效的证据。
          // 在此消费该证据，否则会被误判为「已恢复」而跳过调用方的已存密码静默登录。
          if (gate.mode === 'gateway' && gate.gatewayEvidence === 'login-page') {
            apply({ type: 'probe-gateway' })
            apply({ type: 'session-absent' })
            return gate
          }
          apply({ type: 'session-restored', otpEnabled: settings.value.otpEnabled })
          return {
            mode: 'gateway',
            gatewayEvidence: null,
            evidence: '已存会话有效（静默恢复）',
            status: 200,
            at: new Date().toISOString()
          }
        }
        if (!settings.ok && settings.status === 401 && settingsUnauthenticated(settings)) {
          // `onboarding-required` —— 那说明会话有效但只完成了一半认证(网关

          // 连分区 Cookie 注入也会跟着失效。
          gateway.jar.clear()
        }
      }
      // 2) 探测端点(带已有会话头,否则只能观察到 302→/login 这一种状态)
      const detection = await detectEndpoint(options.endpointUrl, options, gateway.jar.header())
      switch (detection.mode) {
        case 'gateway':
          apply({ type: 'probe-gateway' })
          apply({ type: 'session-absent' })
          // (login-page / otp-page / onboarding,见 detect.ts),这里必须把它**消费掉** ——
          // (`/api*` 的 401 JSON 无响应体可读,页面 302 的 location 才是唯一区分依据)。
          if (detection.gatewayEvidence === 'otp-page') {
            apply({ type: 'login-requires-otp', otpEnabled: true })
          } else if (detection.gatewayEvidence === 'onboarding') {
            apply({ type: 'onboarding-required' })
          }
          break
        case 'none':
        case 'browser-auth':
          apply({ type: 'session-restored', otpEnabled: false })
          break
        default:
          apply({ type: 'probe-unreachable', message: detection.evidence })
      }
      return detection
    },

    async login(password, otp) {
      if (!backoff.canAttempt() || !canSubmit(syncLock())) return syncLock()
      const result = await gateway.login({ password, ...(otp === undefined ? {} : { otp }) })
      if (result.ok) {
        backoff.recordSuccess()
        const next = apply({ type: 'login-succeeded', usedOtp: otp !== undefined })
        // 罐中此时已持有新会话 Cookie（gateway.login 在返回前完成 store）
        options.onLoginSucceeded?.()
        return next
      }
      return handleFailure(result)
    },

    async logout() {
      // 登出失败也清本地会话(用户意图明确);状态统一回「等待凭据」
      await gateway.logout()
      gateway.jar.clear()
      return apply({ type: 'session-absent' })
    },

    tick: () => syncLock()
  }
}

function settingsUnauthenticated(settings: GatewayFailure): boolean {
  return settings.code === 'unauthenticated'
}

/**
 *
 * `cookie` 是**本函数存在的理由**:网关判定是有序门禁,匿名探测只能看到第一道门
 * (`302 <base>/login`),`onboarding` / `otp/verify` 两种状态永远观察不到
 */
async function detectEndpoint(
  endpointUrl: string,
  options: AuthClientOptions,
  cookie: string | null
): Promise<AuthDetection> {
  return detectAuthMode(`${endpointUrl.replace(/\/+$/, '')}/`, {
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    cookie
  })
}
