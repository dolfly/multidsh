import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// electron 在 vitest node 环境不可加载——整体 mock 成可观测的假窗口,
// 证明 window-host 的守卫真正被接线(will-navigate 拦截/权限全拒/loadURL .catch/复用与关闭)
vi.mock('electron', () => {
  class FakeWebContents {
    handlers = new Map<string, (...args: unknown[]) => unknown>()
    setWindowOpenHandler = vi.fn()
    session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }
    on = vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
      this.handlers.set(event, listener)
      return this
    })
    loadURL = vi.fn((url: string) => Promise.resolve(url))
  }
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = []
    webContents = new FakeWebContents()
    closedListener: (() => void) | null = null
    isDestroyed = vi.fn(() => false)
    setTitle = vi.fn()
    focus = vi.fn()
    close = vi.fn()
    // BrowserWindow.loadURL 委托给 webContents,保持一致
    loadURL = vi.fn((url: string) => this.webContents.loadURL(url))
    on = vi.fn((event: string, listener: () => void) => {
      if (event === 'closed') this.closedListener = listener
      return this
    })
    constructor() {
      FakeBrowserWindow.instances.push(this)
    }
  }
  return { BrowserWindow: FakeBrowserWindow }
})

import { BrowserWindow } from 'electron'
import { closeInstanceWindow, openInstanceWindow } from './window-host'

interface TestWin {
  webContents: {
    handlers: Map<string, (...args: unknown[]) => unknown>
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    session: {
      setPermissionRequestHandler: ReturnType<typeof vi.fn>
      setPermissionCheckHandler: ReturnType<typeof vi.fn>
    }
    loadURL: ReturnType<typeof vi.fn>
  }
  closedListener: (() => void) | null
  isDestroyed: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  setTitle: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

const fakeWindows = (): TestWin[] =>
  (BrowserWindow as unknown as { instances: TestWin[] }).instances

const ORIGIN = 'http://127.0.0.1:30000/?token=abc'
let seq = 0

beforeEach(() => {
  fakeWindows().length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('openInstanceWindow（实例窗口接线, 拦截外跳）', () => {
  it('会在 will-navigate 与 will-redirect 上拦截跨端口或外部跳转', () => {
    const win = openInstanceWindow({
      instanceId: `n-${++seq}`,
      title: 't',
      url: ORIGIN
    }) as unknown as TestWin
    for (const eventName of ['will-navigate', 'will-redirect']) {
      const navigate = win.webContents.handlers.get(eventName)
      expect(navigate).toBeDefined()

      const allowed = { preventDefault: vi.fn() }
      navigate?.(allowed, 'http://127.0.0.1:30000/api/jobs')
      expect(allowed.preventDefault).not.toHaveBeenCalled()

      const deniedExternal = { preventDefault: vi.fn() }
      navigate?.(deniedExternal, 'https://evil.example.com/phish')
      expect(deniedExternal.preventDefault).toHaveBeenCalledTimes(1)

      const deniedCrossPort = { preventDefault: vi.fn() }
      navigate?.(deniedCrossPort, 'http://127.0.0.1:30001/')
      expect(deniedCrossPort.preventDefault).toHaveBeenCalledTimes(1)

      const deniedNonHttp = { preventDefault: vi.fn() }
      navigate?.(deniedNonHttp, 'file:///etc/passwd')
      expect(deniedNonHttp.preventDefault).toHaveBeenCalledTimes(1)
    }
  })

  it('弹窗一律拒绝', () => {
    const win = openInstanceWindow({
      instanceId: `w-${++seq}`,
      title: 't',
      url: ORIGIN
    }) as unknown as TestWin
    const handler = win.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as () => {
      action: string
    }
    expect(handler()).toEqual({ action: 'deny' })
  })

  it('实例分区会话安装统一权限策略:纯音频采集与剪贴板写入放行,其余拒绝', () => {
    const win = openInstanceWindow({
      instanceId: `p-${++seq}`,
      title: 't',
      url: ORIGIN
    }) as unknown as TestWin
    const setPerm = win.webContents.session.setPermissionRequestHandler
    expect(setPerm).toHaveBeenCalledTimes(1)
    expect(win.webContents.session.setPermissionCheckHandler).toHaveBeenCalledTimes(1)
    const handler = setPerm.mock.calls[0]?.[0] as (
      _webContents: unknown,
      _permission: string,
      callback: (granted: boolean) => void,
      details?: unknown
    ) => void
    const callback = vi.fn()
    handler(null, 'notifications', callback)
    expect(callback).toHaveBeenCalledWith(false)
    handler(null, 'media', callback, { mediaTypes: ['audio'] })
    expect(callback).toHaveBeenLastCalledWith(true)
    handler(null, 'media', callback, { mediaTypes: ['video'] })
    expect(callback).toHaveBeenLastCalledWith(false)
  })

  it('窗口加载失败经 .catch 处理(不产生未处理拒绝)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const win = openInstanceWindow({
      instanceId: `l-${++seq}`,
      title: 't',
      url: ORIGIN
    }) as unknown as TestWin
    // 复用分支的第二次加载失败 → .catch 兜住并记录主进程日志
    win.webContents.loadURL.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))
    openInstanceWindow({ instanceId: `l-${seq}`, title: 't2', url: ORIGIN })
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalled())
  })

  it('autoLoad:false 时不自动加载( 顺序纪律的前提)', () => {
    const id = `nl-${++seq}`
    const win = openInstanceWindow({
      instanceId: id,
      title: 't',
      url: ORIGIN,
      autoLoad: false
    }) as unknown as TestWin
    // 顺序纪律(先注入 Cookie 再 loadURL)完全依赖这里不加载:
    expect(win.loadURL).not.toHaveBeenCalled()
    expect(win.webContents.loadURL).not.toHaveBeenCalled()
  })

  it('autoLoad 缺省(及显式 true)时按原行为加载', () => {
    const idDefault = `al-${++seq}`
    const byDefault = openInstanceWindow({
      instanceId: idDefault,
      title: 't',
      url: ORIGIN
    }) as unknown as TestWin
    expect(byDefault.loadURL).toHaveBeenCalledWith(ORIGIN)

    const idTrue = `al-${++seq}`
    const explicit = openInstanceWindow({
      instanceId: idTrue,
      title: 't',
      url: ORIGIN,
      autoLoad: true
    }) as unknown as TestWin
    expect(explicit.loadURL).toHaveBeenCalledWith(ORIGIN)
  })

  it('复用窗口时 autoLoad:false 同样不加载(编排负责注入后再加载)', () => {
    const id = `rl-${++seq}`
    const first = openInstanceWindow({
      instanceId: id,
      title: 't',
      url: ORIGIN,
      autoLoad: false
    }) as unknown as TestWin
    expect(first.loadURL).not.toHaveBeenCalled()

    const reused = openInstanceWindow({
      instanceId: id,
      title: 't2',
      url: ORIGIN,
      autoLoad: false
    }) as unknown as TestWin
    expect(reused).toBe(first)
    expect(reused.loadURL).not.toHaveBeenCalled()
    expect(reused.focus).toHaveBeenCalled()
  })

  it('同实例复用窗口;close 后重新开窗', () => {
    const id = `r-${++seq}`
    const w1 = openInstanceWindow({ instanceId: id, title: 't', url: ORIGIN }) as unknown as TestWin
    const w2 = openInstanceWindow({
      instanceId: id,
      title: 't2',
      url: ORIGIN
    }) as unknown as TestWin
    expect(w2).toBe(w1)
    expect(w2.setTitle).toHaveBeenCalledWith('t2')

    closeInstanceWindow(id)
    expect(w1.close).toHaveBeenCalledTimes(1)

    const w3 = openInstanceWindow({
      instanceId: id,
      title: 't3',
      url: ORIGIN
    }) as unknown as TestWin
    expect(w3).not.toBe(w1)

    // 'closed' 事件回调同样负责清理 Map:触发后再开同 id → 又得新窗口
    w3.closedListener?.()
    const w4 = openInstanceWindow({
      instanceId: id,
      title: 't4',
      url: ORIGIN
    }) as unknown as TestWin
    expect(w4).not.toBe(w3)
  })
})
