/**
 *
 * `Path=/; HttpOnly; SameSite=Strict`（basePath 不改变 Cookie 路径）。
 * Secure 按端点 scheme 决定：https 端点带 Secure（防降级到同主机 http 重放），
 * 纯 HTTP/LAN 端点不带（否则无法写入分区）。
 * **顺序纪律**:先写分区 Cookie,再 loadURL —— 避免首帧 302 抖动。
 * 密码绝不进入渲染进程:渲染层只触发登录,凭据只在主进程内存中流转。
 */

export interface SessionCookieRecord {
  url: string
  name: string
  value: string
  path: string
  httpOnly: boolean
  secure: boolean
  sameSite: 'strict' | 'lax' | 'no_restriction' | 'unspecified'
  expirationDate?: number
}

/** electron `session.cookies.set` 的最小接口(便于单测注入) */
export interface CookieSetter {
  set(details: SessionCookieRecord): Promise<void>
}

export interface ImportCookieOptions {
  /** 端点 origin(含 scheme/port),如 https://gw.example.com */
  origin: string
  basePath?: string
  cookie: { name: string; value: string; expiresAt: number | null }
}

/** 计算 Cookie 写入用的 URL:Cookie 的 Path=/ 意味着 url 只需 origin(+basePath 不影响) */
export function cookieUrlFor(origin: string, basePath = '/'): string {
  const trimmedOrigin = origin.replace(/\/+$/, '')
  const normalizedBase = basePath === '/' || basePath === '' ? '' : basePath.replace(/\/+$/, '')
  return `${trimmedOrigin}${normalizedBase}/`
}

/** origin 是否 https —— 据此决定注入 Cookie 是否带 Secure。 */
function isSecureOrigin(origin: string): boolean {
  try {
    return new URL(origin).protocol === 'https:'
  } catch {
    return false
  }
}

export function toCookieRecord(options: ImportCookieOptions): SessionCookieRecord {
  const { origin, basePath = '/', cookie } = options
  return {
    url: cookieUrlFor(origin, basePath),
    name: cookie.name,
    value: cookie.value,
    path: '/', // 网关源码核实:basePath 不改变 Cookie 路径
    httpOnly: true,
    // https 端点必须带 Secure，防会话 Cookie 被降级到同主机 http 请求重放；
    // 纯 HTTP/LAN 端点（含回环）无 https 可依，保持 false 才能真正写入分区。
    secure: isSecureOrigin(origin),
    sameSite: 'strict'
  }
}

/** 注入会话 Cookie(写失败不致命:页面仍可打开,拦截层会触发重登) */
export async function importSessionCookie(
  setter: CookieSetter,
  options: ImportCookieOptions
): Promise<boolean> {
  try {
    await setter.set(toCookieRecord(options))
    return true
  } catch (error) {
    console.error('[cookie-import] 分区 Cookie 注入失败：', error)
    return false
  }
}

/**
 *
 * 顺序纪律由本函数保证,并被 `instance-view.test.ts` 的调用序列断言锁定
 * —— 反序会让首个 main-frame 请求先打一次未带 Cookie 的 302 → /login 抖动。
 *
 * @param load 真正的加载动作(闭包持有窗口与确切 URL;不要在此重建 URL,
 *   实例 URL 可能带 `?token=...`,重建会丢参数)
 * @returns 是否成功注入(失败也加载:交给拦截层触发重登)
 */
export async function prepareInstanceView(
  setter: CookieSetter,
  options: ImportCookieOptions,
  load: () => Promise<void> | void
): Promise<boolean> {
  const injected = options.cookie.value === '' ? false : await importSessionCookie(setter, options)
  await load()
  return injected
}
