import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    options: Record<string, unknown>
    setAlwaysOnTop = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setMenuBarVisibility = vi.fn()
    setBackgroundColor = vi.fn()
    loadURL = vi.fn(async () => undefined)
    setBounds = vi.fn()
    showInactive = vi.fn()
    hide = vi.fn()
    isDestroyed = vi.fn(() => false)
    destroy = vi.fn()

    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeBrowserWindow.instances.push(this)
    }
  }
  return { BrowserWindow: FakeBrowserWindow }
})

import { BrowserWindow } from 'electron'
import { createWorkspaceTooltipHost } from './workspace-tooltip'

interface TestWindow {
  options: Record<string, unknown>
  setAlwaysOnTop: ReturnType<typeof vi.fn>
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>
  setMenuBarVisibility: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  showInactive: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

function windows(): TestWindow[] {
  return (BrowserWindow as unknown as { instances: TestWindow[] }).instances
}

function hubWindow(focused = true) {
  return {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => focused),
    getContentBounds: vi.fn(() => ({ x: 100, y: 200, width: 1200, height: 800 }))
  }
}

describe('createWorkspaceTooltipHost', () => {
  beforeEach(() => {
    windows().length = 0
  })

  it('uses a non-focusable native child window above the workspace view', async () => {
    const hub = hubWindow()
    const host = createWorkspaceTooltipHost(() => hub as never)

    await host.show({ text: '收起态示例实例', x: 72, y: 160 })

    const tooltip = windows()[0]
    expect(tooltip).toBeDefined()
    expect(tooltip?.options).toMatchObject({
      parent: hub,
      frame: false,
      transparent: true,
      focusable: false,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      // 系统圆角会裁掉提示自身的圆角描边，必须关闭。
      roundedCorners: false
    })
    expect(tooltip?.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating')
    expect(tooltip?.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
    const bounds = tooltip?.setBounds.mock.calls.at(-1)?.[0]
    // 窗口比可见提示四周各大一圈透明安全区,圆角描边因此不会被窗口遮罩裁掉。
    expect(bounds).toMatchObject({ x: 158, y: 330 })
    expect(bounds.width).toBeGreaterThanOrEqual(124)
    expect(bounds.height).toBe(60)
    expect(tooltip?.showInactive).toHaveBeenCalledOnce()
    const loaded = decodeURIComponent(tooltip?.loadURL.mock.calls[0]?.[0] as string)
    expect(loaded).toContain('padding:14px')
    expect(loaded).toContain('border-radius:7px')
    expect(loaded).toContain('border:1px solid')
    expect(loaded).toContain('收起态示例实例')
  })

  it('hides without retaining a native overlay when the pointer leaves', async () => {
    const host = createWorkspaceTooltipHost(() => hubWindow() as never)
    await host.show({ text: '实例', x: 72, y: 160 })

    host.hide()

    expect(windows()[0]?.hide).toHaveBeenCalledOnce()
  })

  it('宿主窗口已失焦时跳过显示，避免重排浮动窗口把应用顶到前台抢焦点', async () => {
    const hub = hubWindow(false)
    const host = createWorkspaceTooltipHost(() => hub as never)
    await host.show({ text: '实例', x: 72, y: 160 })

    // 不创建窗口、不 setBounds、不 showInactive：任何重排都会触发 macOS 焦点延迟机制，
    // 数秒后把后台应用批准为前台。
    expect(windows()).toHaveLength(0)
  })

  it('已显示的提示在宿主窗口失焦后的 show 请求中被隐藏', async () => {
    const focused = hubWindow(true)
    const host = createWorkspaceTooltipHost(() => focused as never)
    await host.show({ text: '实例', x: 72, y: 160 })
    expect(windows()[0]?.showInactive).toHaveBeenCalledOnce()

    // 用户切走应用，renderer 的悬停 debounce 随后到期
    focused.isFocused.mockReturnValue(false)
    await host.show({ text: '另一实例', x: 72, y: 200 })

    expect(windows()[0]?.hide).toHaveBeenCalled()
    expect(windows()[0]?.setBounds).toHaveBeenCalledOnce()
    expect(windows()[0]?.showInactive).toHaveBeenCalledOnce()
  })

  it('被更新请求中止的加载静默退出，只显示最新请求', async () => {
    const hub = hubWindow()
    // 复现真实导航语义:同一 webContents 上后一次 loadURL 会中止前一次在途导航
    const loads: Array<{ resolve: () => void; reject: (error: Error) => void }> = []
    class AbortableWindow {
      options: Record<string, unknown>
      setAlwaysOnTop = vi.fn()
      setIgnoreMouseEvents = vi.fn()
      setMenuBarVisibility = vi.fn()
      setBackgroundColor = vi.fn()
      setBounds = vi.fn()
      showInactive = vi.fn()
      hide = vi.fn()
      isDestroyed = vi.fn(() => false)
      destroy = vi.fn()
      loadURL = vi.fn(() => new Promise<void>((resolve, reject) => { loads.push({ resolve, reject }) }))
      constructor(options: Record<string, unknown>) {
        this.options = options
      }
    }
    const created: AbortableWindow[] = []
    const host = createWorkspaceTooltipHost(
      () => hub as never,
      (options) => {
        const win = new AbortableWindow(options as Record<string, unknown>)
        created.push(win)
        return win as never
      }
    )

    const first = host.show({ text: '本机', x: 72, y: 160 })
    const second = host.show({ text: '修复实例', x: 72, y: 160 })
    // 第二次导航完成,同时使第一次在途导航以 ERR_ABORTED 中止
    loads[1]?.resolve()
    loads[0]?.reject(new Error('ERR_ABORTED (-3)'))

    // 被中止的旧请求静默完成,不向 IPC 上报;只有最新请求显示提示
    await expect(first).resolves.toBeUndefined()
    await expect(second).resolves.toBeUndefined()
    expect(created[0]?.showInactive).toHaveBeenCalledOnce()
  })
})
