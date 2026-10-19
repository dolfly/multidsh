/**
 *
 * 存在的**正确性理由**(不只是功能):偏好「关闭窗口时最小化到托盘」会让
 * `win.close()` 被 `preventDefault` + `hide()` 拦下。若此时**没有托盘**,
 * 应用就再也叫不回来了(只剩 macOS Dock)。因此:
 * 1. 只有托盘**确实存在**时才允许隐藏到托盘 —— 判定在 `shell/native-decisions.ts` 的
 *    `shouldMinimizeToTrayOnClose(settings, trayAvailable)`,并由 `shell/close-to-tray.ts`
 *    在 close 处理器里消费(index 传入的是托盘可用性探测,而非判定本身);
 * 2. 偏好从开变关时销毁托盘;从关变开时创建托盘;
 * 3. 托盘菜单至少提供「显示主窗口」与「退出」,保证任何状态下都有出路。
 */
import { Menu, Tray, nativeImage } from 'electron'
import type { NativeImage } from 'electron'

export interface HubTrayLabels {
  tooltip: string
  show: string
  quit: string
  /** 状态行(禁用项),如「3 个实例 · 2 个运行中」 */
  status: string
}

export interface CreateHubTrayOptions {
  /** 模板图路径(macOS 菜单栏按明暗自动反色) */
  iconPath: string
  labels: HubTrayLabels
  onShow: () => void
  onQuit: () => void
}

/**
 * 从磁盘路径加载托盘图标。
 *
 * macOS 的模板图语义由**文件名**决定(`trayTemplate.png` / `trayTemplate@2x.png`),
 * 系统据此自动按明暗反色,无需在此处判断平台;Windows / Linux 由 `trayIconPath()`
 * 传入彩色图。加载失败时返回空图,
 * 由 Electron 渲染为占位(调用方不额外兜底,避免掩盖资源缺失)。
 */
export function trayIconFrom(iconPath: string): NativeImage {
  return nativeImage.createFromPath(iconPath)
}

export function createHubTray(options: CreateHubTrayOptions): Tray {
  const tray = new Tray(trayIconFrom(options.iconPath))
  tray.setToolTip(options.labels.tooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: options.labels.status, enabled: false },
      { type: 'separator' },
      { label: options.labels.show, click: options.onShow },
      { type: 'separator' },
      { label: options.labels.quit, click: options.onQuit }
    ])
  )
  // 左键点击直接显示主窗口(macOS 上默认只弹菜单,这里给一个更直接的入口)
  tray.on('click', options.onShow)
  return tray
}

/**
 * 重建托盘菜单与 tooltip。
 *
 * 调用时机不限于「实例数变化」:实例状态/数量变化后、以及**语言切换**后都要重建
 * (菜单文案与状态行都要跟随语言),见 `index.ts` 的两处调用点。
 */
export function updateTrayStatus(
  tray: Tray,
  labels: HubTrayLabels,
  onShow: () => void,
  onQuit: () => void
): void {
  tray.setToolTip(labels.tooltip)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.status, enabled: false },
      { type: 'separator' },
      { label: labels.show, click: onShow },
      { type: 'separator' },
      { label: labels.quit, click: onQuit }
    ])
  )
}
