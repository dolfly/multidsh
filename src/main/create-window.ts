import { app, BrowserWindow, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { createTranslator } from '@shared/i18n'
import { resolveLanguage } from '@shared/settings'
import type { Settings } from '@shared/settings'
import { handleWindowClose } from './shell/close-to-tray'
import { focusDebug } from './shell/focus-debug'
import { systemLocale } from './system-locale'
import type { WorkspaceHost } from './workspace-host'
import type { WorkspaceTooltipHost } from './workspace-tooltip'

export interface WindowControllerDeps {
  /** 是否 Vite dev server 形态（决定导航白名单与加载地址） */
  isDev: boolean
  /** dev server 地址；非 dev 为 null */
  rendererDevUrl: string | null
  /** 渲染器 origin（生产为自定义 `app://hub` 协议） */
  rendererOrigin: string
  /** 判定 URL 是否属于本应用渲染器 origin */
  isRendererOrigin: (url: URL) => boolean
  /** E2E 隐藏窗口模式：窗口不显示，召出窗口也保持不可见 */
  e2eHidden: boolean
  /** 当前偏好；尚未装配时返回 null */
  readSettings: () => Settings | null
  /** 托盘是否真实存在（close-to-tray 判定用） */
  trayExists: () => boolean
  /** 退出进行中时放行窗口关闭 */
  isQuitting: () => boolean
  getWorkspaceHost: () => WorkspaceHost
  getWorkspaceTooltipHost: () => WorkspaceTooltipHost
}

export interface WindowController {
  createWindow(): BrowserWindow
  showHubWindow(): void
  installApplicationMenu(): void
  /** 打开应用内「关于」叠加窗口；供设置页触发点复用应用菜单同一入口。 */
  openAbout(): void
  getHubWindow(): BrowserWindow | null
}

/**
 * 主窗口、「关于」叠加窗口、导航白名单与应用菜单的装配。
 */
export function createWindowController(deps: WindowControllerDeps): WindowController {
  /**
   * 实例窗口没有 preload，收到也无消费者；`auth:state` 仍广播（详情页可能在任一窗口）。
   */
  let hubWindow: BrowserWindow | null = null
  /** 「关于」独立叠加窗口；随宿主窗口的隐藏/关闭一并收起。 */
  let aboutWindow: BrowserWindow | null = null

  function isAllowedNavigation(url: string): boolean {
    try {
      const target = new URL(url)
      if (deps.isDev && deps.rendererDevUrl)
        return target.origin === new URL(deps.rendererDevUrl).origin
      return deps.isRendererOrigin(target)
    } catch {
      return false
    }
  }

  /** 从托盘召出主窗口(没有窗口就重建)；E2E 隐藏模式下保持不可见。 */
  function showHubWindow(): void {
    if (deps.e2eHidden) return
    // 排查间歇性窗口抢焦点：showHubWindow 会 show()+focus() 把窗口顶到前台，
    // 由托盘点击、Dock activate、second-instance 触发。记录调用栈以定位真实来源。
    focusDebug(
      `[create-window] showHubWindow appFocused=${String(
        BrowserWindow.getFocusedWindow() !== null
      )} stack=${new Error().stack?.split('\n').slice(2, 6).join(' | ') ?? ''}`
    )
    if (hubWindow && !hubWindow.isDestroyed()) {
      hubWindow.show()
      hubWindow.focus()
    } else {
      createWindow()
    }
  }

  /**
   * 打开应用内「关于」面板：独立的透明无边框子窗口，与宿主窗口完全重合，
   * 直接浮在内嵌工作区之上 —— 打开与关闭都不改变宿主的页面路由，也不隐藏工作区视图。
   * 不用 `app.showAboutPanel()`：原生面板只显示名称/版本/版权，
   * 放不下项目主页与运行组件版本（`setAboutPanelOptions.website` 仅 Linux 生效）。
   */
  function openAboutPanel(): void {
    const parent = hubWindow
    if (!parent || parent.isDestroyed()) return
    if (aboutWindow && !aboutWindow.isDestroyed()) {
      if (!deps.e2eHidden) aboutWindow.show()
      aboutWindow.focus()
      return
    }
    const child = new BrowserWindow({
      parent,
      ...parent.getBounds(),
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: !deps.e2eHidden
      }
    })
    // 叠加窗口不接受 popup；导航只允许本应用渲染器 origin。
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    child.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) event.preventDefault()
    })
    child.once('ready-to-show', () => {
      if (child.isDestroyed()) return
      if (!deps.e2eHidden) child.show()
      child.focus()
    })
    child.on('closed', () => {
      if (aboutWindow === child) aboutWindow = null
    })
    const base =
      deps.isDev && deps.rendererDevUrl ? deps.rendererDevUrl : `${deps.rendererOrigin}/index.html`
    void child.loadURL(`${base}?window=about`)
    aboutWindow = child
  }

  /**
   * 应用菜单。macOS 的 App 菜单里「关于 DSH Hub」指向应用内面板，其余保留标准角色，
   * 以维持复制/粘贴、重载与开发者工具等系统快捷键。
   *
   * Windows / Linux 不设可见菜单栏：这些平台的菜单栏挂在标题栏下方占一整行，与设计稿
   * 不符；「关于」入口改由设置页触发点承担（openAbout）。仍构建一个不可见的应用菜单，
   * 让复制/粘贴、重载等标准快捷键（accelerator）继续可用。
   */
  function installApplicationMenu(): void {
    const language = resolveLanguage(deps.readSettings()?.language, systemLocale())
    const tr = createTranslator(language)
    const about: MenuItemConstructorOptions = {
      label: tr('about.title'),
      click: () => openAboutPanel()
    }
    if (process.platform !== 'darwin') {
      // 保留 accelerator（复制/粘贴/重载等）但不显示菜单栏；关于入口移到设置页。
      // 「关于」项仍留在（不可见的）应用菜单里：用户不经菜单进入，但保留标准位置，
      // 也让程序化触发（Menu.getApplicationMenu().click()，E2E 用）命中同一入口。
      const template: MenuItemConstructorOptions[] = [
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        { role: 'help', submenu: [about] }
      ]
      const menu = Menu.buildFromTemplate(template)
      Menu.setApplicationMenu(menu)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.setMenuBarVisibility(false)
          win.autoHideMenuBar = true
        }
      }
      return
    }
    const template: MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          about,
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  function createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 900,
      minHeight: 600,
      show: false,
      title: 'DSH Hub',
      // 深色主题背景（oklch(0.185 0.012 265) 的 sRGB 近似），避免加载期白闪
      backgroundColor: '#101318',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightPosition: { x: 14, y: 13 },
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: !deps.e2eHidden
      }
    })

    // Windows / Linux 菜单栏挂在标题栏下占一整行，与设计稿不符：隐藏它（Alt 也不唤出）。
    // 关于入口改由设置页承担；应用菜单里的标准 accelerator 仍可用（见 installApplicationMenu）。
    if (process.platform !== 'darwin') {
      win.setMenuBarVisibility(false)
      win.autoHideMenuBar = true
    }

    win.once('ready-to-show', () => {
      if (!deps.e2eHidden) win.show()
    })

    // Hub renderer 不接受 popup；外部跳转必须由显式、受校验的用户操作触发。
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedNavigation(url)) event.preventDefault()
    })
    // Command+R 只重启 renderer，主进程管理的 WebContentsView 不会自动销毁。
    // 在 Hub 顶层重新导航时立即撤销旧工作区边界，避免它覆盖刷新后恢复的侧边栏。
    win.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      deps.getWorkspaceTooltipHost().hide()
      deps.getWorkspaceHost().hide()
    })

    if (deps.isDev && deps.rendererDevUrl) void win.loadURL(deps.rendererDevUrl)
    else void win.loadURL(`${deps.rendererOrigin}/index.html`)

    // 判定与拦截动作在 `shell/close-to-tray.ts`(三审 Finding 2):
    // 「托盘是否存在」必须**实时查询**真实端口,不能写死 —— 硬编码 `true` 会让
    // 没有托盘时也隐藏窗口,应用从此叫不回来(只剩 macOS Dock)。
    win.on('close', (event) => {
      handleWindowClose(event, {
        settings: () => deps.readSettings(),
        // 「托盘是否存在」由端口自己回答(存在性的唯一真理源),这里不做二次判断
        trayAvailable: () => deps.trayExists(),
        isQuitting: () => deps.isQuitting(),
        hideWindow: () => win.hide()
      })
    })

    win.on('closed', () => {
      deps.getWorkspaceHost().closeAll()
      if (hubWindow === win) hubWindow = null
    })
    // 切换应用时隐藏提示窗，防止残留；切回时恢复工作区键盘焦点。
    win.on('blur', () => {
      // 排查「DSH 丢焦点给其它应用」方向：记录失焦时刻与是否已无 DSH 窗口在前台。
      // 与 openExternal 日志对齐——紧邻 openExternal 则为 DSH 主动让出，否则为对方抢占。
      focusDebug(
        `[create-window] win.blur appFocused=${String(BrowserWindow.getFocusedWindow() !== null)}`
      )
      deps.getWorkspaceTooltipHost().hide()
    })
    win.on('focus', () => {
      deps.getWorkspaceHost().focusActive()
    })
    // 「关于」叠加窗口跟随宿主：宿主隐藏/关闭即收起，移动/缩放保持完全重合。
    const collapseAbout = (): void => {
      if (aboutWindow && !aboutWindow.isDestroyed()) aboutWindow.close()
    }
    win.on('hide', collapseAbout)
    win.on('closed', collapseAbout)
    const syncAboutBounds = (): void => {
      if (aboutWindow && !aboutWindow.isDestroyed()) aboutWindow.setBounds(win.getBounds())
    }
    win.on('move', syncAboutBounds)
    win.on('resize', syncAboutBounds)
    hubWindow = win
    return win
  }

  return {
    createWindow,
    showHubWindow,
    installApplicationMenu,
    openAbout: () => openAboutPanel(),
    getHubWindow: () => hubWindow
  }
}
