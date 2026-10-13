import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import type { WorkspaceTooltip } from '@shared/contracts'
import { focusDebug } from './shell/focus-debug'

export interface WorkspaceTooltipHost {
  show(tooltip: WorkspaceTooltip): Promise<void>
  hide(): void
  close(): void
}

const TOOLTIP_HEIGHT = 32
/**
 * 提示自身的圆角与阴影都贴着内容边缘。窗口圆角遮罩会在四角裁掉一条弧线，
 * 因此四周留出透明安全区：遮罩只能裁到透明像素，圆角描边保持完整。
 */
const TOOLTIP_PADDING = 14
const TOOLTIP_WINDOW_HEIGHT = TOOLTIP_HEIGHT + TOOLTIP_PADDING * 2
const TOOLTIP_MIN_WIDTH = 96
const TOOLTIP_MAX_WIDTH = 320

function tooltipWidth(text: string): number {
  // 预置窗口宽度,按每字符 14px 从宽估算,保证就位前文本不被裁剪;
  // 可见盒子的实际宽度由页面 CSS 按文本收缩,窗口多出的部分是透明区域。
  return Math.max(TOOLTIP_MIN_WIDTH, Math.min(TOOLTIP_MAX_WIDTH, Math.ceil(text.length * 14 + 22)))
}

function tooltipHtml(text: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden}body{padding:${TOOLTIP_PADDING}px;font:12px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#1f2937}main{box-sizing:border-box;width:max-content;max-width:min(320px,calc(100vw - 28px));height:${TOOLTIP_HEIGHT}px;padding:6px 9px;border:1px solid #d8dce4;border-radius:7px;background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / .08);line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style></head><body><main>${escapeHtml(text)}</main></body></html>`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

export interface WorkspaceTooltipHostOptions {
  /**
   * E2E 隐藏模式（窗口不显示也不聚焦）下仍按请求显示提示窗：用例直接读取提示窗
   * 样式，守卫会把这条路径整个拦掉。生产路径不设此开关，守卫始终生效。
   */
  e2eHidden?: boolean
}

/**
 * 原生工作区是 renderer DOM 之外的 WebContentsView，CSS z-index 无法覆盖它。
 * 这个无焦点子窗口只呈现实例名称，始终位于父窗口的工作区视图上方。
 */
export function createWorkspaceTooltipHost(
  getHubWindow: () => BrowserWindow | null,
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow = (options) => new BrowserWindow(options),
  options: WorkspaceTooltipHostOptions = {}
): WorkspaceTooltipHost {
  let tooltipWindow: BrowserWindow | null = null
  let displayedText: string | null = null
  let displayRequest = 0

  function validWindow(): BrowserWindow | null {
    return tooltipWindow && !tooltipWindow.isDestroyed() ? tooltipWindow : null
  }

  function ensureWindow(parent: BrowserWindow): BrowserWindow {
    const existing = validWindow()
    if (existing) return existing
    const created = createWindow({
      parent,
      width: TOOLTIP_MIN_WIDTH + TOOLTIP_PADDING * 2,
      height: TOOLTIP_WINDOW_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      // 无边框窗口默认带系统圆角（macOS 约 10px），比提示自身的 7px 圆角更大，
      // 会把整段圆角描边裁掉、只剩四条直边。关掉系统圆角，由页面 CSS 自行绘制。
      roundedCorners: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    created.setAlwaysOnTop(true, 'floating')
    created.setIgnoreMouseEvents(true, { forward: true })
    created.setMenuBarVisibility(false)
    created.setBackgroundColor('#00000000')
    tooltipWindow = created
    return created
  }

  return {
    async show(tooltip) {
      const request = ++displayRequest
      const parent = getHubWindow()
      if (!parent || parent.isDestroyed()) return
      // 仅在前台显示：对浮动子窗口 showInactive 会把宿主窗口组排到最前；应用在后台时
      // 这个置前请求被 macOS 挂起数秒后批准，会把整个应用顶回前台抢走其它应用的焦点。
      if (!options.e2eHidden && !parent.isFocused()) {
        focusDebug('[workspace-tooltip] show skipped: hub window blurred')
        validWindow()?.hide()
        return
      }
      focusDebug('[workspace-tooltip] show focused=true')
      const nativeTooltip = ensureWindow(parent)
      const parentBounds = parent.getContentBounds()
      const width = tooltipWidth(tooltip.text) + TOOLTIP_PADDING * 2
      nativeTooltip.setBounds({
        x: parentBounds.x + tooltip.x - TOOLTIP_PADDING,
        y: parentBounds.y + tooltip.y - Math.floor(TOOLTIP_WINDOW_HEIGHT / 2),
        width,
        height: TOOLTIP_WINDOW_HEIGHT
      })
      if (displayedText !== tooltip.text) {
        try {
          await nativeTooltip.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(tooltipHtml(tooltip.text))}`)
        } catch (error) {
          // 指针快速划过多个实例时,后一次 show 的导航会中止前一次在途导航(Err_ABORTED);
          // 展示结果以最新请求为准,被中止的旧请求静默退出,不作为故障上报。
          if (request === displayRequest && !nativeTooltip.isDestroyed()) throw error
          return
        }
        displayedText = tooltip.text
      }
      if (request === displayRequest && !nativeTooltip.isDestroyed()) nativeTooltip.showInactive()
    },

    hide() {
      displayRequest += 1
      validWindow()?.hide()
    },

    close() {
      const current = validWindow()
      if (current) current.destroy()
      tooltipWindow = null
    }
  }
}
