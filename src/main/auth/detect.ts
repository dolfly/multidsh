/**
 *
 * 连接建立后对端点做一次探测，而不是让用户手选模式：
 * - `302/303 → <path>/login`        → gateway（登录页重定向）
 * - `401` + JSON `error:unauthenticated|onboarding-required` → gateway（API 直探）
 * - `401` + `text/plain` + `dsh web authentication required…` → **browser-auth**
 * - `200`（HTML/应用响应）            → none
 * - `ECONNREFUSED` / 超时 / 其他网络错误 → unreachable（传输未就绪,回去重连）
 *
 * 判定规则逐条核对自 dsh 源码：`dsh-client-connection/lib/index.js` 的
 * `BrowserAuth.writeUnauthorized()` 返回 401 + `text/plain; charset=utf-8` +
 * `dsh web authentication required; reopen the URL printed by dsh web.`；
 * token 校验通过则 303 → `/` 并 Set-Cookie。
 */
import type { EndpointScheme } from '@shared/endpoint'
import type { HttpAuthDetection } from '@shared/contracts'

/** 探测结论（IPC 共享类型,类型本体在 shared/contracts） */
export type AuthDetection = HttpAuthDetection

export interface ResponseObservation {
  status: number
  /** 重定向 Location（已解析为 pathname 亦可，调用方尽量传 pathname） */
  location?: string | null
  contentType?: string | null
  body?: string | null
}

/** 从 URL 取 pathname（失败则原样返回小写串） */
function pathnameOf(location: string | null | undefined): string {
  if (!location) return ''
  // new URL 对任何非空字符串都能解析(相对路径按 base 归一化),无需 catch
  return new URL(location, 'http://placeholder.invalid').pathname.toLowerCase()
}

/** 是否 JSON 响应 */
function looksJson(
  contentType: string | null | undefined,
  body: string | null | undefined
): boolean {
  if (contentType?.toLowerCase().includes('json')) return true
  const trimmed = (body ?? '').trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

export const BROWSER_AUTH_MARKER = 'dsh web authentication required'

export function classifyAuthResponse(observation: ResponseObservation): AuthDetection {
  const { status } = observation
  const location = pathnameOf(observation.location)
  const contentType = observation.contentType ?? null
  const body = observation.body ?? ''
  const at = new Date().toISOString()

  // 1) 重定向到登录页 / onboarding = 网关
  if (status >= 300 && status < 400) {
    if (location.endsWith('/login') || location === 'login') {
      return {
        mode: 'gateway',
        gatewayEvidence: 'login-page',
        evidence: `${status} → ${location}（网关登录页重定向）`,
        status,
        at
      }
    }
    if (location.endsWith('/otp/verify') || location.endsWith('/otp')) {
      return {
        mode: 'gateway',
        gatewayEvidence: 'otp-page',
        evidence: `${status} → ${location}（网关要求二因素验证）`,
        status,
        at
      }
    }
    if (location.endsWith('/onboarding')) {
      return {
        mode: 'gateway',
        gatewayEvidence: 'onboarding',
        evidence: `${status} → ${location}（网关 onboarding 未完成）`,
        status,
        at
      }
    }
    return {
      mode: 'unknown',
      gatewayEvidence: null,
      evidence: `${status} → ${location || '(无 Location)'}（未识别的重定向）`,
      status,
      at
    }
  }

  if (status === 401) {
    // dsh 内置 BrowserAuth:必须同时满足「text/plain」+ 完整特征串(与 JSON 分支对称,
    const isPlainText = (contentType ?? '').toLowerCase().includes('text/plain')
    if (isPlainText && body.includes(BROWSER_AUTH_MARKER)) {
      return {
        mode: 'browser-auth',
        gatewayEvidence: null,
        evidence: '401 + dsh 内置 BrowserAuth 提示（webview 自认证）',
        status,
        at
      }
    }
    if (looksJson(contentType, body)) {
      let error = ''
      try {
        const parsed = JSON.parse(body) as { error?: unknown }
        if (typeof parsed.error === 'string') error = parsed.error
      } catch {
        /* 非 JSON 体也按 API 401 处理 */
      }
      const evidence = error === 'onboarding-required' ? 'onboarding' : 'api-401'
      return {
        mode: 'gateway',
        gatewayEvidence: evidence,
        evidence: `401 JSON${error ? ` error=${error}` : ''}（网关 API 直探）`,
        status,
        at
      }
    }
    return {
      mode: 'unknown',
      gatewayEvidence: null,
      evidence: '401（无识别特征）',
      status,
      at
    }
  }

  if (status >= 200 && status < 300) {
    return {
      mode: 'none',
      gatewayEvidence: null,
      evidence: `${status} 可直接访问（无需登录）`,
      status,
      at
    }
  }

  return {
    mode: 'unknown',
    gatewayEvidence: null,
    evidence: `HTTP ${status}`,
    status,
    at
  }
}

export interface DetectOptions {
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
  /** 端点 scheme（http 明文 / https） */
  scheme?: EndpointScheme
  /**
   * 已有会话的 Cookie 头（`dsh_auth=...`）。
   *
   * **必须带**:网关 `Gateway#route` 的判定是**有序门禁** —— 先 `!isValid(token)` → `302 <base>/login`,
   * 之后才轮到 `isNeedsOnboarding` → `302 /onboarding`、`isOTPVerified` → `302 /otp/verify`
   * (`dsh-auth-gateway/lib/gateway.js:346-384`)。匿名探测永远撞在第一道门上,
   * 于是后两种状态**根本观察不到** → `needs-otp`/`needs-onboarding` 恒退化。
   */
  cookie?: string | null
}

/**
 * 网络层失败 → unreachable（传输未就绪，交给重连/看门狗），不抛异常。
 */
export async function detectAuthMode(
  endpointUrl: string,
  options: DetectOptions = {}
): Promise<AuthDetection> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  const now = options.now ?? (() => Date.now())
  const at = new Date(now()).toISOString()
  try {
    const cookie = options.cookie
    const response = await fetchImpl(endpointUrl, {
      method: 'GET',
      redirect: 'manual', // 必须看到重定向本身
      // 带会话 Cookie 才能越过网关的第一道门禁,观察到 onboarding / otp 两种状态
      ...(cookie ? { headers: { cookie } } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    })
    let body = ''
    try {
      body = (await response.text()).slice(0, 8 * 1024)
    } catch {
      body = ''
    }
    const detected = classifyAuthResponse({
      status: response.status,
      location: response.headers.get('location'),
      contentType: response.headers.get('content-type'),
      body
    })
    return { ...detected, at }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      mode: 'unreachable',
      gatewayEvidence: null,
      evidence: `连接失败：${message}`,
      status: null,
      at
    }
  }
}
