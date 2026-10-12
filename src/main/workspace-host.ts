import { BrowserWindow, shell, WebContentsView } from 'electron'
import type { WorkspaceHotkeyEvent, WorkspaceViewBounds } from '@shared/contracts'
import { redactUrl } from '@shared/redact'
import { focusDebug } from './shell/focus-debug'
import { prepareInstanceView } from './webview/cookie-import'
import { buildOpenViewPlan, type SessionCookie } from './webview/open-view-plan'
import { isAllowedInstanceNavigation, openExternalSafely } from './window-host-policy'
import { toWorkspaceHotkey } from './workspace-hotkey'

export interface WorkspaceView {
  loadURL(url: string): Promise<void>
  webContents: {
    session: Electron.Session
    getURL(): string
    isDestroyed(): boolean
    reload(): void
    on(event: 'will-redirect', listener: (_event: { preventDefault(): void }, url: string) => void): void
  }
}

interface Entry {
  instanceId: string
  originUrl: string
  view: WebContentsView
  lastUsed: number
  /** 当前是否对用户可见；用于区分「首次显示」与后续布局变化。 */
  visible: boolean
}

export interface WorkspaceHost {
  prepare(instanceId: string, url: string): WorkspaceView
  /** 调整已缓存实例视图上限；超出的最久未使用非活动视图立即回收。 */
  setCacheLimit(limit: number): void
  setLocale(): void
  setBounds(bounds: WorkspaceViewBounds): void
  reload(): void
  /**
   * 重新加载指定实例的工作区视图：先把最新会话 Cookie 写回该实例分区，
   * 再导航回视图最后一次准备加载的目标 URL。会话在远端重启后失效、用户重新
   * 登录成功时调用；只作用于该实例，不改变可见性与边界。
   * 未缓存视图时 no-op。
   */
  reloadSession(instanceId: string, sessionCookie: SessionCookie | null): Promise<void>
  hide(): void
  /**
   * 已缓存视图当前停在哪。只读，不改变可见性、边界或激活目标。
   * 未缓存或尚未导航完成时返回 null；调用方据此判断打开是否需要重新导航。
   */
  loadedUrl(instanceId: string): string | null
  /** 销毁某实例的原生工作区；运行时和认证状态由调用方保留。 */
  disconnect(instanceId: string): void
  close(instanceId: string): void
  closeAll(): void
  /** 将键盘焦点交还当前可见的工作区视图。由窗口重新激活时调用。 */
  focusActive(): void
}

/**
 * Hosts an authenticated workspace in a main-process WebContentsView.
 * The renderer receives only visibility state and cannot access guest DOM, URLs, or cookies.
 */
export function createWorkspaceHost(
  getHubWindow: () => BrowserWindow | null,
  workspaceLocale: () => string = () => 'en-US',
  forwardHotkey: (event: WorkspaceHotkeyEvent) => void = () => undefined
): WorkspaceHost {
  const entries = new Map<string, Entry>()
  let activeId: string | null = null
  let cacheLimit = 3
  let useSequence = 0

  function touch(entry: Entry): void {
    useSequence += 1
    entry.lastUsed = useSequence
  }

  function trimCache(): void {
    while (entries.size > cacheLimit) {
      const oldest = [...entries.values()]
        .filter((entry) => entry.instanceId !== activeId)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (!oldest) return
      close(oldest.instanceId)
    }
  }

  function configureLocale(webContents: WebContentsView['webContents']): void {
    // dsh 在持久化设置同步前按 navigator.languages 初始化；使用 Hub 的显式语言偏好，
    // 避免系统语言与应用设置不一致时远程登录页回落为英文。
    const locale = workspaceLocale().toLowerCase().startsWith('zh') ? 'zh-CN,zh,en-US,en' : 'en-US,en,zh-CN,zh'
    webContents.session.setUserAgent(webContents.getUserAgent(), locale)
  }

  function configure(entry: Entry): void {
    const { webContents } = entry.view
    configureLocale(webContents)
    webContents.setWindowOpenHandler(({ url }) => {
      if (!url) return { action: 'deny' }
      // target="_blank" 链接:外部 URL 用系统浏览器打开,同 origin 拒绝
      if (isAllowedInstanceNavigation(url, entry.originUrl)) {
        return { action: 'deny' }
      }
      // 排查「DSH 丢焦点给浏览器」方向：工作区内 target="_blank" 外链会经系统浏览器
      // 打开并激活它，把前台让给浏览器。记录来源与脱敏 URL，供与 win.blur 对齐。
      focusDebug(`[workspace-host] openExternal source=workspace-target-blank url=${redactUrl(url)}`)
      openExternalSafely(url, shell.openExternal.bind(shell))
      return { action: 'deny' }
    })
    webContents.on('will-navigate', (event, url) => {
      if (!isAllowedInstanceNavigation(url, entry.originUrl)) event.preventDefault()
    })
    webContents.on('will-redirect', (event, url) => {
      if (!isAllowedInstanceNavigation(url, entry.originUrl)) event.preventDefault()
    })
    // 工作区视图持有键盘焦点时,主窗口收不到按键;会话切换所需的白名单输入
    // (⌘/Ctrl 与其数字组合)在此转发给 hub 渲染层,其余输入原样交回页面。
    webContents.on('before-input-event', (_event, input) => {
      const hotkey = toWorkspaceHotkey(input, process.platform)
      if (hotkey) forwardHotkey(hotkey)
    })
    // dsh web 的复制按钮依赖 navigator.clipboard 写入；只放行剪贴板写入类权限，
    // 读取与其他能力保持一律拒绝（最小权限，网页仍无法读取本机剪贴板内容）。
    const isClipboardWrite = (permission: string): boolean =>
      permission === 'clipboard-write' || permission === 'clipboard-sanitized-write'
    webContents.session.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(isClipboardWrite(permission))
    )
    webContents.session.setPermissionCheckHandler((_contents, permission) => isClipboardWrite(permission))
    webContents.session.on('will-download', (event) => event.preventDefault())
  }

  function prepare(instanceId: string, url: string): WorkspaceView {
    const win = getHubWindow()
    if (!win || win.isDestroyed()) throw new Error('工作区主窗口不可用')
    // 排查间歇性窗口抢焦点：记录一次工作区打开/复用的发起点与当时的窗口聚焦态。
    // 后台事件（实例 running 后自动打开、会话重探）触发的打开会在此暴露 winFocused=false。
    focusDebug(
      `[workspace-host] prepare winFocused=${String(win.isFocused())} appFocused=${String(
        BrowserWindow.getFocusedWindow() !== null
      )}`
    )
    let entry = entries.get(instanceId)
    if (!entry) {
      entry = {
        instanceId,
        originUrl: url,
        lastUsed: 0,
        visible: false,
        view: new WebContentsView({
          webPreferences: {
            partition: `persist:inst-${instanceId}`,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webviewTag: false,
            spellcheck: false
          }
        })
      }
      configure(entry)
      // WebContentsView 在加入 contentView 后会以默认大小绘制；必须先收缩并隐藏，
      // 不能让远程登录页在首帧覆盖整个应用窗口。
      entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      entry.view.setVisible(false)
      entries.set(instanceId, entry)
      win.contentView.addChildView(entry.view)
    } else {
      entry.originUrl = url
      configureLocale(entry.view.webContents)
    }
    touch(entry)
    // WebContentsView 的默认可见区域会覆盖整个窗口。不能复用上一个工作区的边界，
    // 因为侧栏状态和布局可能已经变化；先收缩并隐藏，等当前渲染周期回传右侧内容区边界。
    for (const candidate of entries.values()) {
      candidate.view.setVisible(false)
      candidate.visible = false
    }
    entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    activeId = instanceId
    trimCache()
    return {
      loadURL: (target) => entry.view.webContents.loadURL(target),
      webContents: entry.view.webContents
    }
  }

  /**
   * 把键盘焦点交给工作区。
   *
   * 只聚焦子视图，绝不调用 `win.focus()`：抢窗口焦点会打断 macOS 的应用激活，
   * 表现为「窗口点不到前台、输入落到下一层」。
   *
   * 仅当宿主窗口当前已聚焦时才聚焦子视图：应用处于后台时，`webContents.focus()`
   * 同样会把整个应用顶到前台、抢占其它应用（如如流）的焦点。后台事件（实例 running
   * 后自动打开、会话重探、窗口 focus 竞态）触发的聚焦据此跳过；待用户重新点回窗口，
   * `win.on('focus')` → `focusActive` 会补上视图焦点。
   */
  function focusEntry(entry: Entry, source: string): void {
    const win = getHubWindow()
    const winFocused = win !== null && !win.isDestroyed() ? win.isFocused() : false
    // 保留主要节点日志以便回归监测：抢焦点复发时会出现 winFocused=false 却 action=focus。
    focusDebug(
      `[workspace-host] focusEntry source=${source} winFocused=${String(winFocused)} appFocused=${String(
        BrowserWindow.getFocusedWindow() !== null
      )} action=${winFocused ? 'focus' : 'skip-bg'}`
    )
    if (!winFocused) return
    // 等本次布局提交完成后再转移键盘焦点，避免与窗口激活过程互相覆盖。
    setImmediate(() => {
      if (entry.view.webContents.isDestroyed()) return
      entry.view.webContents.focus()
    })
  }

  function hide(): void {
    if (activeId === null) return
    const entry = entries.get(activeId)
    if (entry) {
      // Renderer reload 会丢失 workspaceOpen；同时清零旧边界，避免原生视图覆盖恢复后的展开侧栏。
      entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      entry.view.setVisible(false)
      entry.visible = false
    }
    activeId = null
    // 隐藏不会让 macOS 撤下该视图的键盘焦点;不交还的话按键继续落到不可见的
    // 工作区,宿主渲染层(浮层 Escape、Tab 圈闭)收不到任何输入。
    // 仅在窗口已聚焦时交还：应用在后台时 webContents.focus() 会把窗口顶到前台抢焦点。
    const win = getHubWindow()
    const winFocused = win !== null && !win.isDestroyed() ? win.isFocused() : false
    focusDebug(
      `[workspace-host] hide->webContents.focus winFocused=${String(winFocused)} appFocused=${String(
        BrowserWindow.getFocusedWindow() !== null
      )} action=${winFocused ? 'focus' : 'skip-bg'}`
    )
    if (winFocused && win) win.webContents.focus()
  }

  function disconnect(instanceId: string): void {
    close(instanceId)
  }

  function close(instanceId: string): void {
    const entry = entries.get(instanceId)
    if (!entry) return
    const win = getHubWindow()
    if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
    entry.visible = false
    entries.delete(instanceId)
    if (activeId === instanceId) activeId = null
  }

  function setCacheLimit(limit: number): void {
    cacheLimit = Math.max(1, Math.floor(limit))
    trimCache()
  }

  function setLocale(): void {
    for (const entry of entries.values()) {
      configureLocale(entry.view.webContents)
      entry.view.webContents.reload()
    }
  }

  function reload(): void {
    // 排查间歇性窗口抢焦点：会话静默重探成功后由主进程触发全量 reload，
    // 可能在应用处于后台时发生；记录以便与 focus 事件对齐时间线。
    focusDebug(
      `[workspace-host] reload count=${entries.size} appFocused=${String(
        BrowserWindow.getFocusedWindow() !== null
      )}`
    )
    for (const entry of entries.values()) entry.view.webContents.reload()
  }

  function reloadSession(instanceId: string, sessionCookie: SessionCookie | null): Promise<void> {
    const entry = entries.get(instanceId)
    if (!entry || entry.view.webContents.isDestroyed()) return Promise.resolve()
    // 排查间歇性窗口抢焦点：重新登录成功后由主进程触发，可能在应用后台时发生。
    focusDebug(
      `[workspace-host] reloadSession appFocused=${String(BrowserWindow.getFocusedWindow() !== null)}`
    )
    // originUrl 是主进程最后一次交给 prepare 的目标 URL（不等同于当前页：会话失效
    // 后视图可能已停在登录页），重新导航回它才能让工作区回到已登录页面。
    const plan = buildOpenViewPlan(entry.originUrl, sessionCookie)
    // 先注入（顺序纪律与 instance-view 一致），再导航；注入失败不阻断刷新，
    // 视图会经拦截层重新触发认证。
    const inject =
      plan.cookie !== null && plan.origin !== ''
        ? prepareInstanceView(
            entry.view.webContents.session.cookies,
            { origin: plan.origin, basePath: plan.basePath, cookie: plan.cookie },
            () => undefined
          )
        : Promise.resolve(false)
    return inject.then(() => entry.view.webContents.loadURL(plan.url)).catch((error: unknown) => {
      // 被更新导航取代（用户/其他流程已再次 loadURL）是常态，按调试记录；
      // 其余错误记录以保留排查线索。
      if ((error as { code?: unknown } | null)?.code === 'ERR_ABORTED') {
        console.debug('[workspace-host] 会话刷新被更新的导航取代（正常）:', redactUrl(plan.url))
        return
      }
      console.error('[workspace-host] 会话刷新工作区失败：', error)
    })
  }

  function loadedUrl(instanceId: string): string | null {
    const entry = entries.get(instanceId)
    if (!entry || entry.view.webContents.isDestroyed()) return null
    const url = entry.view.webContents.getURL()
    return url === '' ? null : url
  }

  function setBounds(bounds: WorkspaceViewBounds): void {
    if (activeId === null) return
    const active = entries.get(activeId)
    if (!active) return
    active.view.setBounds(bounds)
    const visible = bounds.width > 0 && bounds.height > 0
    active.view.setVisible(visible)
    // 只在「隐藏 → 显示」时接管焦点：后续每次布局变化都抢焦点会打断用户正在进行的输入。
    const becameVisible = visible && !active.visible
    active.visible = visible
    if (becameVisible) focusEntry(active, 'setBounds:becameVisible')
  }

  function closeAll(): void {
    for (const instanceId of [...entries.keys()]) close(instanceId)
  }

  function focusActive(): void {
    if (activeId === null) return
    const entry = entries.get(activeId)
    if (entry && !entry.view.webContents.isDestroyed()) focusEntry(entry, 'focusActive')
  }

  return {
    prepare,
    setCacheLimit,
    setLocale,
    setBounds,
    reload,
    reloadSession,
    hide,
    loadedUrl,
    disconnect,
    close,
    closeAll,
    focusActive
  }
}
