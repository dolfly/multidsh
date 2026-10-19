/**
 *
 * 现把顺序收进本模块并由 `instance-view.test.ts` 的调用序列断言锁定:
 *
 *   1. 开窗(**不自动 loadURL**)
 *   2. 装 302/401 拦截(必须在首个响应到达前就位)
 *   3. 写分区会话 Cookie
 *   4. loadURL
 *
 * 任何一步反序都会让首个 main-frame 请求打一次未带 Cookie 的 302 → /login 抖动。
 */
import { redactLine, redactUrl } from '@shared/redact'
import { prepareInstanceView } from './cookie-import'
import type { CookieSetter } from './cookie-import'

/**
 * 生成「每个 session 只安装一次拦截」的守卫。
 *
 * electron `webRequest.onHeadersReceived` 是**追加**语义(`.on` 家族),而分区会话
 * (`persist:inst-<id>`)的生命周期长于窗口 —— 重复 openView(窗口被复用、或关闭后重开)
 * 会叠加监听器,使同一响应被判定多次 → 重复静默重探与重复广播。
 *
 * @returns 传入 session 返回 true 表示「本次应当安装」
 */
export function createOncePerSession<S extends object>(): (session: S) => boolean {
  const seen = new WeakSet<S>()
  return (session) => {
    if (seen.has(session)) return false
    seen.add(session)
    return true
  }
}

/** 打开实例视图所需的最小窗口面(生产实现即 electron `BrowserWindow`) */
export interface InstanceViewWindow {
  loadURL(url: string): Promise<void>
  webContents: {
    session: { cookies: CookieSetter }
    /** Electron 当前页面 URL；提供时允许复用已加载工作区而不重复导航。 */
    getURL?(): string
    /** electron `will-redirect`;可选以保持最小测试假件简单 */
    on?(event: 'will-redirect', listener: (_event: unknown, url: string) => void): void
  }
}

export interface OpenInstanceViewDeps<W extends InstanceViewWindow> {
  /** 开窗并完成导航加固;**不得**自动 loadURL */
  createWindow(): W
  /** 装拦截层(需在 loadURL 之前调用) */
  installIntercept(win: W): void
  /** 加载失败上报(默认 console.error) */
  onLoadError?(error: unknown): void
}

export interface OpenInstanceViewArgs {
  /** 要加载的确切 URL(可能带 `?token=...`,不得重建) */
  url: string
  origin: string
  basePath: string
  /** 主进程持有的会话 Cookie;null/空值表示无会话(仅加载,交给拦截层重登) */
  cookie: { name: string; value: string; expiresAt: number | null } | null
}

/**
 * Electron 的 `will-redirect` 是认证跳转已发生的确证；只接受同源的 `<basePath>/login`。
 * 不按错误文字猜测，避免网络/TLS 错误被静默吞掉。带 basePath 的实例（如 `/dsh`）
 * 网关 302 到 `/dsh/login`，根路径匹配会漏判、把正常登录跳转当真故障上报。
 */
export function isSameOriginLoginRedirect(
  redirectUrl: string | null,
  origin: string,
  basePath: string
): boolean {
  if (!redirectUrl || !origin) return false
  try {
    const target = new URL(redirectUrl)
    const expectedOrigin = new URL(origin).origin
    const base = basePath === '/' ? '' : basePath.replace(/\/+$/, '')
    const expectedPath = `${base}/login`
    return target.origin === expectedOrigin && target.pathname.replace(/\/+$/, '') === expectedPath
  } catch {
    return false
  }
}

/**
 * BrowserAuth 成功后会消费启动 URL 的一次性 token，并回到同源同路径页面。
 * 当前页面可保留自己的查询参数或 hash；只要不再携带 token 即可安全复用同一实例视图。
 */
export function isAuthenticatedTokenUrl(
  currentUrl: string | undefined,
  targetUrl: string
): boolean {
  if (!currentUrl) return false
  try {
    const current = new URL(currentUrl)
    const target = new URL(targetUrl)
    return (
      target.searchParams.has('token') &&
      !current.searchParams.has('token') &&
      current.origin === target.origin &&
      current.pathname === target.pathname
    )
  } catch {
    return false
  }
}

/**
 * 视图是否已停在该 URL，从而本次打开不需要导航。
 *
 * 复用精确 URL，或 BrowserAuth 已消费一次性 token 后回到同源同路径的页面。
 * 调用方据此判断「本次打开会不会真的发生导航」——不会导航时既无需注入会话 Cookie，
 * 也不必为注入而等待认证探测。
 */
export function shouldReuseLoadedView(currentUrl: string | undefined, targetUrl: string): boolean {
  return currentUrl === targetUrl || isAuthenticatedTokenUrl(currentUrl, targetUrl)
}

/**
 * 开窗 → 装拦截 → 注入 Cookie → 加载。
 * @returns 是否在加载前成功写入了会话 Cookie
 */
export async function openInstanceView<W extends InstanceViewWindow>(
  deps: OpenInstanceViewDeps<W>,
  args: OpenInstanceViewArgs
): Promise<boolean> {
  const win = deps.createWindow()
  if (shouldReuseLoadedView(win.webContents.getURL?.(), args.url)) return false
  deps.installIntercept(win)
  let redirectedTo: string | null = null
  win.webContents.on?.('will-redirect', (_event, url) => {
    redirectedTo = url
  })

  const onLoadError =
    deps.onLoadError ??
    ((error: unknown) => console.error('[instance-view] 加载失败：', redactLine(String(error))))
  const load = async (): Promise<void> => {
    try {
      await win.loadURL(args.url)
    } catch (error) {
      // —— 页面自身重定向/用户在加载完成前操作/拦截层触发重登再加载。这属于
      // 浏览器的常态而非故障,按 debug 记录即可;其余错误维持 error 级上报。
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'ERR_ABORTED') {
        console.debug('[instance-view] 导航被更新的导航取代(正常),跳过:', redactUrl(args.url))
        return
      }
      // 有些网关会把根路径 302 到 /login 后再做一次自身导航;Electron 此时会把
      // 原始 loadURL Promise 以 ERR_FAILED(-2) 拒绝,但窗口已经在同源认证页，
      // 不是连接或证书失败。仅在已实际观测到同源 /login 重定向时降级，避免吞掉
      // DNS、TLS、代理等真正的 ERR_FAILED。
      if (
        code === 'ERR_FAILED' &&
        isSameOriginLoginRedirect(redirectedTo, args.origin, args.basePath)
      ) {
        console.debug(
          '[instance-view] 已重定向至同源登录页(正常),跳过:',
          redactUrl(redirectedTo ?? '')
        )
        return
      }
      onLoadError(error)
    }
  }

  if (args.cookie === null || args.cookie.value === '') {
    await load()
    return false
  }

  return prepareInstanceView(
    win.webContents.session.cookies,
    {
      origin: args.origin,
      basePath: args.basePath,
      cookie: args.cookie
    },
    load
  )
}
