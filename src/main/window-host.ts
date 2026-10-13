/**
 *
 * 隔离存储，禁用 nodeIntegration、开启 contextIsolation/sandbox、拦截外跳（弹窗 + 顶层导航）。
 */
import { BrowserWindow } from 'electron'
import { installInstancePermissionPolicy } from './instance-permission'
import { isAllowedInstanceNavigation } from './window-host-policy'

export interface OpenInstanceViewOptions {
  instanceId: string
  title: string
  url: string
  /**
   * 是否在返回前自动 `loadURL`(默认 true)。
   * 编排见 `webview/instance-view.ts`(先注入再加载,避免首帧 302 抖动)。
   */
  autoLoad?: boolean
}

/** 已打开的实例窗口（同一实例复用，避免重复开窗） */
const windows = new Map<string, BrowserWindow>()

export function openInstanceWindow(options: OpenInstanceViewOptions): BrowserWindow {
  const autoLoad = options.autoLoad ?? true
  const existing = windows.get(options.instanceId)
  if (existing && !existing.isDestroyed()) {
    existing.setTitle(options.title)
    if (autoLoad) {
      existing.loadURL(options.url).catch((error: unknown) => {
        console.error('[window-host] 重新加载实例窗口失败：', error)
      })
    }
    existing.focus()
    return existing
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: options.title,
    backgroundColor: '#101318',
    webPreferences: {
      partition: `persist:inst-${options.instanceId}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false
    }
  })

  // 实例页面内的外跳一律拒绝（弹窗；顶层导航由 will-navigate 另行拦截）
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // 顶层导航只许留在本实例服务（回环 + 同端口）：把实例分区带去外部 origin
  // 等于给未来的网关 Cookie 开外泄通道（策略细则见 window-host-policy.ts）
  const guardNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (!isAllowedInstanceNavigation(url, options.url)) event.preventDefault()
  }
  win.webContents.on('will-navigate', guardNavigation)
  win.webContents.on('will-redirect', guardNavigation)
  // 权限策略与工作区视图共用 instance-permission.ts：放行剪贴板写入与纯音频采集
  // （语音输入），通知/地理位置/摄像头等其余权限一律拒绝；两者共享分区 session，必须一致。
  installInstancePermissionPolicy(win.webContents.session)
  win.on('closed', () => windows.delete(options.instanceId))
  windows.set(options.instanceId, win)

  if (autoLoad) {
    void win.loadURL(options.url).catch((error: unknown) => {
      console.error('[window-host] 加载实例窗口失败：', error)
    })
  }
  return win
}

/** 关闭某实例窗口（实例停止时调用） */
export function closeInstanceWindow(instanceId: string): void {
  const win = windows.get(instanceId)
  if (win && !win.isDestroyed()) win.close()
  windows.delete(instanceId)
}