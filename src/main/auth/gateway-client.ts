/**
 *
 * 逐条核对自真实网关源码(v0.7.2 `lib/gateway.js`/`lib/auth.js`):
 * - `POST /login/auth {password, otp?, backupCode?}` → 200 `{ok:true}` + `Set-Cookie: dsh_auth=…`
 *   (OTP 启用时**同一次请求**即可完成 2FA);
 * - 400 `{error:'otp-required'}` = 密码正确但缺验证码(进入 TOTP 提问的权威信号);
 * - 401 `{error:'invalid-credentials'}` = 密码/验证码/备份码错误**一律统一**(不得据此区分,
 *   网关刻意防凭据枚举) → UI 只能提示「账号或验证码错误」;
 * - 429 `{error:'rate-limited'}`(全局限流) / 429 `{error:'too-many-attempts', retryAfterSeconds}`
 *   (按地址锁定) → `retryAfterSeconds` 是**唯一计时依据**;
 * - 401 `{error:'unauthenticated'}` = 会话失效;`{error:'onboarding-required'}` = 需先改初始密码;
 * - 500 `{error:'otp-secret-missing'}` 等 = 实例配置异常;
 * - 413 `{error:'payload-too-large'}` 防御性处理。
 */
import { createCookieJar, type CookieJar } from './cookie-jar'

export const COOKIE_NAME = 'dsh_auth'

export type GatewayErrorCode =
  | 'otp-required'
  | 'invalid-credentials'
  | 'rate-limited'
  | 'too-many-attempts'
  | 'unauthenticated'
  | 'onboarding-required'
  | 'invalid-json'
  | 'bad-request'
  | 'payload-too-large'
  | 'password-too-short'
  | 'password-too-simple'
  | 'password-mismatch'
  | 'otp-not-enabled'
  | 'invalid-otp'
  | 'invalid-backup-code'
  | 'otp-secret-missing'
  | 'network'
  | 'unexpected'

export interface GatewayFailure {
  ok: false
  /** HTTP 状态码(null = 网络层失败) */
  status: number | null
  code: GatewayErrorCode
  message: string
  /** 429/锁定时的唯一计时依据(秒) */
  retryAfterSeconds: number | null
}

export interface GatewaySuccess<T> {
  ok: true
  value: T
}

export type GatewayResult<T> = GatewaySuccess<T> | GatewayFailure

export interface GatewayClientOptions {
  /** 端点基准(归一化 baseUrl,可含 basePath);请求路径会拼在其后 */
  baseUrl: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** 注入 Cookie 罐(便于跨请求复用;缺省新建) */
  jar?: CookieJar
}

export interface GatewaySettings {
  otpEnabled: boolean
  otpStatus: unknown
  otpIssuer: string | null
  otpPeriod: number | null
  otpDigits: number | null
  raw: unknown
}

export interface LoginInput {
  password: string
  otp?: string
  backupCode?: string
}

export interface GatewayClient {
  jar: CookieJar
  /** 是否持有会话 Cookie(不校验服务端有效性) */
  hasSession(): boolean
  login(input: LoginInput): Promise<GatewayResult<{ otpVerified: boolean }>>
  logout(): Promise<GatewayResult<null>>
  /** 静默恢复探测:带已存 Cookie 打 `GET /login-api/settings` */
  settings(): Promise<GatewayResult<GatewaySettings>>
}

/** 归一化 basePath:保证 baseUrl 与路径拼接不产生双斜杠 */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

const ERROR_MESSAGES: Record<GatewayErrorCode, string> = {
  'otp-required': '请输入动态验证码或备份码',
  'invalid-credentials': '账号或验证码错误',
  'rate-limited': '尝试过于频繁，请稍后再试',
  'too-many-attempts': '失败次数过多，账号已临时锁定',
  unauthenticated: '登录状态已失效，请重新登录',
  'onboarding-required': '需要先设置新的登录密码',
  'payload-too-large': '请求体过大',
  'password-too-short': '密码太短',
  'password-too-simple': '密码强度不足',
  'password-mismatch': '两次输入的密码不一致',
  'otp-not-enabled': '该实例未启用动态验证码',
  'invalid-otp': '动态验证码错误',
  'invalid-backup-code': '备份码无效',
  'otp-secret-missing': '实例的 OTP 配置异常，请联系管理员',
  'invalid-json': '响应格式无效',
  'bad-request': '请求无效',
  network: '网络错误',
  unexpected: '服务返回了未知错误'
}

function isGatewayErrorCode(code: string): code is GatewayErrorCode {
  return Object.hasOwn(ERROR_MESSAGES, code)
}

function messageFor(code: GatewayErrorCode, status: number): string {
  return ERROR_MESSAGES[code] ?? `请求失败（HTTP ${status}）`
}

export function createGatewayClient(options: GatewayClientOptions): GatewayClient {
  const baseUrl = options.baseUrl
  const timeoutMs = options.timeoutMs ?? 10_000
  const fetchImpl = options.fetchImpl ?? fetch
  const jar = options.jar ?? createCookieJar()

  function setCookieHeaders(response: Response): string[] {
    // undici 支持 getSetCookie();退化路径用原始头拆分
    const withGetter = response.headers as Headers & { getSetCookie?: () => string[] }
    if (typeof withGetter.getSetCookie === 'function') return withGetter.getSetCookie()
    const raw = response.headers.get('set-cookie')
    return raw ? [raw] : []
  }

  async function request(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown }
  ): Promise<GatewayResult<{ status: number; json: unknown }>> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (init.method === 'POST') headers['content-type'] = 'application/json'
    const cookieHeader = jar.header()
    if (cookieHeader) headers['cookie'] = cookieHeader
    try {
      const response = await fetchImpl(joinUrl(baseUrl, path), {
        method: init.method,
        headers,
        // 禁止自动跟随:必须看到 302→/login 与 401 本身
        redirect: 'manual',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      jar.store(setCookieHeaders(response))
      let json: unknown = null
      try {
        const text = await response.text()
        json = text === '' ? null : JSON.parse(text)
      } catch {
        json = null
      }
      return { ok: true, value: { status: response.status, json } }
    } catch (error) {
      return {
        ok: false,
        status: null,
        code: 'network',
        message: error instanceof Error ? `网络错误：${error.message}` : '网络错误',
        retryAfterSeconds: null
      }
    }
  }

  /** 把网关响应映射为稳定的失败语义 */
  function failureFrom(status: number, json: unknown): GatewayFailure {
    const body = (json ?? {}) as { error?: unknown; message?: unknown; retryAfterSeconds?: unknown }
    const rawCode = typeof body.error === 'string' ? body.error : ''
    const code = isGatewayErrorCode(rawCode) ? rawCode : 'unexpected'
    const retryAfterSeconds =
      typeof body.retryAfterSeconds === 'number' && Number.isFinite(body.retryAfterSeconds)
        ? body.retryAfterSeconds
        : null
    return {
      ok: false,
      status,
      code,
      message: messageFor(code, status),
      retryAfterSeconds
    }
  }

  const client: GatewayClient = {
    jar,
    hasSession: () => jar.get(COOKIE_NAME) !== null,

    async login(input) {
      const result = await request('/login/auth', {
        method: 'POST',
        body: {
          password: input.password,
          ...(input.otp !== undefined ? { otp: input.otp } : {}),
          ...(input.backupCode !== undefined ? { backupCode: input.backupCode } : {})
        }
      })
      if (!result.ok) return result
      const { status, json } = result.value
      if (status === 200) {
        const otpVerified = !(input.otp === undefined && input.backupCode === undefined)
        // 200 但无 Cookie = 协议异常(应带 Set-Cookie)
        if (!client.hasSession()) {
          return {
            ok: false,
            status,
            code: 'unexpected',
            message: '登录成功响应缺少会话 Cookie',
            retryAfterSeconds: null
          }
        }
        return { ok: true, value: { otpVerified } }
      }
      return failureFrom(status, json)
    },

    async logout() {
      const result = await request('/login/logout', { method: 'POST', body: {} })
      jar.clear()
      if (!result.ok) return result
      const { status, json } = result.value
      if (status === 200) return { ok: true, value: null }
      return failureFrom(status, json)
    },

    async settings() {
      const result = await request('/login-api/settings', { method: 'GET' })
      if (!result.ok) return result
      const { status, json } = result.value
      if (status !== 200) return failureFrom(status, json)
      const config = ((json as { config?: unknown })?.config ?? {}) as Record<string, unknown>
      const plugin = (config['dsh-auth-gateway'] ?? {}) as Record<string, unknown>
      const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)
      const asNumber = (value: unknown): number | null =>
        typeof value === 'number' && Number.isFinite(value) ? value : null
      return {
        ok: true,
        value: {
          otpEnabled: plugin['otpEnabled'] === true,
          otpStatus: plugin['otpStatus'] ?? null,
          otpIssuer: asString(plugin['otpIssuer']),
          otpPeriod: asNumber(plugin['otpPeriod']),
          otpDigits: asNumber(plugin['otpDigits']),
          raw: json
        }
      }
    }
  }

  return client
}
