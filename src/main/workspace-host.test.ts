import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class FakeWebContents {
    handlers = new Map<string, (...args: unknown[]) => void>()
    loadURL = vi.fn(async () => undefined)
    focus = vi.fn()
    isDestroyed = vi.fn(() => false)
    getURL = vi.fn(() => '')
    getUserAgent = vi.fn(() => 'DSH Hub Test Agent')
    setUserAgent = vi.fn()
    reload = vi.fn()
    setWindowOpenHandler = vi.fn()
    session = {
      setUserAgent: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      on: vi.fn(),
      cookies: { set: vi.fn(async () => undefined) }
    }
    on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      this.handlers.set(event, listener)
    })
    close = vi.fn()
  }
  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    webContents = new FakeWebContents()
    setBounds = vi.fn()
    setVisible = vi.fn()
    constructor() {
      FakeWebContentsView.instances.push(this)
    }
  }
  return {
    WebContentsView: FakeWebContentsView,
    BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
    app: { getPath: vi.fn(() => '/tmp') },
    shell: { openExternal: vi.fn(async () => undefined) }
  }
})

import { WebContentsView, shell } from 'electron'
import { createWorkspaceHost } from './workspace-host'

interface TestView {
  webContents: {
    handlers: Map<string, (...args: unknown[]) => void>
    loadURL: ReturnType<typeof vi.fn>
    focus: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
    getURL: ReturnType<typeof vi.fn>
    getUserAgent: ReturnType<typeof vi.fn>
    setUserAgent: ReturnType<typeof vi.fn>
    reload: ReturnType<typeof vi.fn>
    setWindowOpenHandler: ReturnType<typeof vi.fn>
    session: {
      setUserAgent: ReturnType<typeof vi.fn>
      setPermissionRequestHandler: ReturnType<typeof vi.fn>
      setPermissionCheckHandler: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
      cookies: { set: ReturnType<typeof vi.fn> }
    }
    close: ReturnType<typeof vi.fn>
  }
  setBounds: ReturnType<typeof vi.fn>
  setVisible: ReturnType<typeof vi.fn>
}

function fakeViews(): TestView[] {
  return (WebContentsView as unknown as { instances: TestView[] }).instances
}

function hubWindow(focused = true) {
  return {
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => focused),
    // 暴露 focus 以便断言工作区路径**从不**抢宿主窗口焦点。
    focus: vi.fn(),
    // hide() 交还键盘焦点的目标(webContents 级,不激活窗口)。
    webContents: { focus: vi.fn() },
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width: 1180, height: 780 })),
    contentView: {
      addChildView: vi.fn(),
      removeChildView: vi.fn()
    }
  }
}

describe('createWorkspaceHost', () => {
  beforeEach(() => {
    fakeViews().length = 0
  })

  it('creates a main-owned, sandboxed view with popup, permission, download, and navigation guards', async () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(
      () => hub as never,
      () => 'zh-Hans-CN'
    )
    const view = host.prepare(
      '11111111-1111-4111-8111-111111111111',
      'http://127.0.0.1:3080/?token=abc'
    )
    const created = fakeViews()[0]
    expect(created).toBeDefined()
    expect(hub.contentView.addChildView).toHaveBeenCalledWith(created)
    expect(created?.webContents.session.setUserAgent).toHaveBeenCalledWith(
      'DSH Hub Test Agent',
      'zh-CN,zh,en-US,en'
    )
    host.setBounds({ x: 64, y: 92, width: 1116, height: 688 })
    expect(created?.setBounds).toHaveBeenCalledWith({ x: 64, y: 92, width: 1116, height: 688 })
    await vi.waitFor(() => expect(created?.webContents.focus).toHaveBeenCalledTimes(1))
    // 绝不从工作区路径抢宿主窗口焦点：那会打断 macOS 的应用激活。
    expect(hub.focus).not.toHaveBeenCalled()
    // 后续布局变化不得再次抢夺焦点，否则会打断用户正在输入的登录表单。
    host.setBounds({ x: 64, y: 92, width: 1100, height: 688 })
    expect(created?.webContents.focus).toHaveBeenCalledTimes(1)
    expect(created?.webContents.setWindowOpenHandler.mock.calls[0]?.[0]({ url: '' })).toEqual({
      action: 'deny'
    })

    const permissionRequest = created?.webContents.session.setPermissionRequestHandler.mock
      .calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      callback: (allowed: boolean) => void,
      details?: unknown
    ) => void
    const callback = vi.fn()
    permissionRequest(null, 'notifications', callback)
    expect(callback).toHaveBeenCalledWith(false)
    // 语音输入(getUserMedia 纯音频)放行,摄像头拒绝
    permissionRequest(null, 'media', callback, { mediaTypes: ['audio'] })
    expect(callback).toHaveBeenLastCalledWith(true)
    permissionRequest(null, 'media', callback, { mediaTypes: ['video'] })
    expect(callback).toHaveBeenLastCalledWith(false)
    const permissionCheck = created?.webContents.session.setPermissionCheckHandler.mock
      .calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      requestingOrigin: string,
      details?: unknown
    ) => boolean
    expect(permissionCheck(null, 'notifications', 'http://127.0.0.1:3080/')).toBe(false)
    expect(permissionCheck(null, 'media', 'http://127.0.0.1:3080/', { mediaType: 'audio' })).toBe(
      true
    )
    expect(permissionCheck(null, 'media', 'http://127.0.0.1:3080/', { mediaType: 'video' })).toBe(
      false
    )
    expect(created?.webContents.session.on).toHaveBeenCalledWith(
      'will-download',
      expect.any(Function)
    )

    for (const eventName of ['will-navigate', 'will-redirect']) {
      const navigate = created?.webContents.handlers.get(eventName)
      const denied = { preventDefault: vi.fn() }
      navigate?.(denied, 'https://evil.example.com/')
      expect(denied.preventDefault).toHaveBeenCalled()
      const allowed = { preventDefault: vi.fn() }
      navigate?.(allowed, 'http://localhost:3080/jobs')
      expect(allowed.preventDefault).not.toHaveBeenCalled()
    }

    void view.loadURL('http://127.0.0.1:3080/?token=abc')
    expect(created?.webContents.loadURL).toHaveBeenCalledWith('http://127.0.0.1:3080/?token=abc')
  })

  it('弹窗 URL 走外跳白名单:危险协议不触达系统,外部 http(s) 才交给系统浏览器', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(
      () => hub as never,
      () => 'en-US'
    )
    host.prepare('22222222-2222-4222-8222-222222222222', 'http://127.0.0.1:3080/?token=abc')
    const created = fakeViews()[0]
    const handler = created?.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as (args: {
      url: string
    }) => { action: string }
    const openExternal = shell.openExternal as ReturnType<typeof vi.fn>

    // 沙箱内远程内容用任意协议拉起本地程序的入口:一律 deny 且不调 shell。
    expect(handler({ url: 'file:///Applications/Calculator.app' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'ms-settings:privacy' })).toEqual({ action: 'deny' })
    expect(handler({ url: 'search-ms:query=secret' })).toEqual({ action: 'deny' })
    // 同 origin 是顶层导航场景,不开外部浏览器。
    expect(handler({ url: 'http://127.0.0.1:3080/jobs' })).toEqual({ action: 'deny' })
    expect(openExternal).not.toHaveBeenCalled()

    // 真正的外部链接交给系统浏览器。
    expect(handler({ url: 'https://example.com/docs' })).toEqual({ action: 'deny' })
    expect(openExternal).toHaveBeenCalledTimes(1)
    expect(openExternal).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('updates locale for cached workspace views when the Hub language changes', () => {
    let locale = 'zh'
    const hub = hubWindow()
    const host = createWorkspaceHost(
      () => hub as never,
      () => locale
    )
    host.prepare('77777777-7777-4777-8777-777777777777', 'https://gw.example.com/')
    const created = fakeViews()[0]
    locale = 'en'
    host.setLocale()
    expect(created?.webContents.session.setUserAgent).toHaveBeenLastCalledWith(
      'DSH Hub Test Agent',
      'en-US,en,zh-CN,zh'
    )
    expect(created?.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('reports the cached view URL read-only, and null when nothing is cached', () => {
    const host = createWorkspaceHost(() => hubWindow() as never)
    const id = '99999999-9999-4999-8999-999999999999'
    // 尚未 prepare → 无缓存视图
    expect(host.loadedUrl(id)).toBeNull()
    host.prepare(id, 'https://gw.example.com/dsh/')
    // prepare 只创建视图，尚未导航完成 → 仍视为「不可复用」
    expect(host.loadedUrl(id)).toBeNull()
    const created = fakeViews()[0]
    created?.webContents.getURL.mockReturnValue('https://gw.example.com/dsh/')
    // 只读：查询不得改变可见性、边界或激活目标
    const boundsCalls = created?.setBounds.mock.calls.length
    const visibleCalls = created?.setVisible.mock.calls.length
    expect(host.loadedUrl(id)).toBe('https://gw.example.com/dsh/')
    expect(created?.setBounds.mock.calls.length).toBe(boundsCalls)
    expect(created?.setVisible.mock.calls.length).toBe(visibleCalls)
    // 视图已销毁 → 不可复用
    created?.webContents.isDestroyed.mockReturnValue(true)
    expect(host.loadedUrl(id)).toBeNull()
  })

  it('reloads the active workspace view after credentials are silently restored', () => {
    const host = createWorkspaceHost(() => hubWindow() as never)
    host.prepare('88888888-8888-4888-8888-888888888888', 'https://gw.example.com/')
    const created = fakeViews()[0]
    host.reload()
    expect(created?.webContents.reload).toHaveBeenCalledTimes(1)
  })

  it('reloadSession 把新会话 Cookie 写回分区并把视图导航回目标 URL', async () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    const id = '66666666-6666-4666-8666-666666666666'
    host.prepare(id, 'https://gw.example.com/dsh/')
    const created = fakeViews()[0]
    const boundsCalls = created?.setBounds.mock.calls.length
    const visibleCalls = created?.setVisible.mock.calls.length

    await host.reloadSession(id, { name: 'dsh_auth', value: 'new-session', expiresAt: null })

    expect(created?.webContents.session.cookies.set).toHaveBeenCalledWith({
      url: 'https://gw.example.com/dsh/',
      name: 'dsh_auth',
      value: 'new-session',
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict'
    })
    expect(created?.webContents.loadURL).toHaveBeenCalledWith('https://gw.example.com/dsh/')
    // 刷新只重载内容，不改变可见性与边界
    expect(created?.setBounds.mock.calls.length).toBe(boundsCalls)
    expect(created?.setVisible.mock.calls.length).toBe(visibleCalls)
    // 只导航一次：未缓存视图的实例不会触发任何操作
    expect(created?.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('reloadSession 无会话 Cookie 时仍导航(交给拦截层重新认证)', async () => {
    const host = createWorkspaceHost(() => hubWindow() as never)
    const id = '77777777-7777-4777-8777-777777777777'
    host.prepare(id, 'http://127.0.0.1:3080/')
    const created = fakeViews()[0]

    await host.reloadSession(id, null)

    expect(created?.webContents.session.cookies.set).not.toHaveBeenCalled()
    expect(created?.webContents.loadURL).toHaveBeenCalledWith('http://127.0.0.1:3080/')
  })

  it('reloadSession 对未缓存视图是 no-op', async () => {
    const host = createWorkspaceHost(() => hubWindow() as never)
    await expect(
      host.reloadSession('99999999-9999-4999-8999-999999999999', {
        name: 'dsh_auth',
        value: 'x',
        expiresAt: null
      })
    ).resolves.toBeUndefined()
    expect(fakeViews()).toHaveLength(0)
  })

  it('keeps a new workspace view hidden until the renderer supplies content bounds', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    host.prepare('44444444-4444-4444-8444-444444444444', 'https://gw.example.com/login')
    const created = fakeViews()[0]

    expect(created?.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    expect(created?.setVisible).toHaveBeenCalledWith(false)
    expect(created?.setBounds.mock.invocationCallOrder[0]).toBeLessThan(
      hub.contentView.addChildView.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    )
    host.setBounds({ x: 262, y: 46, width: 918, height: 734 })
    expect(created?.setBounds).toHaveBeenCalledWith({ x: 262, y: 46, width: 918, height: 734 })
    expect(created?.setVisible).toHaveBeenLastCalledWith(true)
  })

  it('does not reveal a replacement workspace using bounds cached for the previous view', () => {
    const host = createWorkspaceHost(() => hubWindow() as never)
    host.prepare('55555555-5555-4555-8555-555555555555', 'https://first.example.com/')
    host.setBounds({ x: 262, y: 46, width: 918, height: 734 })
    host.prepare('66666666-6666-4666-8666-666666666666', 'https://second.example.com/login')
    const replacement = fakeViews()[1]

    expect(replacement?.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    expect(replacement?.setVisible).toHaveBeenLastCalledWith(false)
  })

  it('updates the navigation allowlist when a trusted reopen uses a new local port', () => {
    const host = createWorkspaceHost(() => hubWindow() as never)
    host.prepare('33333333-3333-4333-8333-333333333333', 'http://127.0.0.1:3080/')
    host.prepare('33333333-3333-4333-8333-333333333333', 'http://127.0.0.1:3081/')
    const navigate = fakeViews()[0]?.webContents.handlers.get('will-navigate')
    const allowed = { preventDefault: vi.fn() }
    navigate?.(allowed, 'http://127.0.0.1:3081/jobs')
    expect(allowed.preventDefault).not.toHaveBeenCalled()
  })

  it('按 LRU 保留有限数量的非活动工作区视图', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    host.setCacheLimit(2)
    host.prepare('11111111-1111-4111-8111-111111111111', 'http://127.0.0.1:3080/')
    host.prepare('22222222-2222-4222-8222-222222222222', 'http://127.0.0.1:3081/')
    host.prepare('33333333-3333-4333-8333-333333333333', 'http://127.0.0.1:3082/')

    expect(fakeViews()).toHaveLength(3)
    expect(hub.contentView.removeChildView).toHaveBeenCalledWith(fakeViews()[0])
    expect(fakeViews()[0]?.webContents.close).toHaveBeenCalled()
    expect(fakeViews()[1]?.webContents.close).not.toHaveBeenCalled()
    expect(fakeViews()[2]?.webContents.close).not.toHaveBeenCalled()
  })

  it('降低缓存上限时不回收当前可见工作区', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    host.setCacheLimit(3)
    host.prepare('11111111-1111-4111-8111-111111111111', 'http://127.0.0.1:3080/')
    host.prepare('22222222-2222-4222-8222-222222222222', 'http://127.0.0.1:3081/')
    host.prepare('33333333-3333-4333-8333-333333333333', 'http://127.0.0.1:3082/')

    host.setCacheLimit(1)
    expect(fakeViews()[0]?.webContents.close).toHaveBeenCalled()
    expect(fakeViews()[1]?.webContents.close).toHaveBeenCalled()
    expect(fakeViews()[2]?.webContents.close).not.toHaveBeenCalled()
  })

  it('白名单转发工作区的切换修饰键与其数字组合,其余输入不转发、不拦截', () => {
    const forward = vi.fn()
    const hub = hubWindow()
    const host = createWorkspaceHost(
      () => hub as never,
      () => 'en-US',
      forward
    )
    host.prepare('22222222-2222-4222-8222-222222222222', 'https://gw.example.com/')
    const beforeInput = fakeViews()[0]?.webContents.handlers.get('before-input-event')
    expect(beforeInput).toBeDefined()

    const base = {
      isAutoRepeat: false,
      isComposing: false,
      shift: false,
      meta: false,
      control: false,
      alt: false,
      location: 0,
      modifiers: []
    }
    const guard = { preventDefault: vi.fn() }
    // 切换修饰键随宿主平台:macOS 为 ⌘(Meta),其余平台(Windows/Linux)为 Alt。
    const isMac = process.platform === 'darwin'
    const modKey = isMac ? 'Meta' : 'Alt'
    const modCode = isMac ? 'MetaLeft' : 'AltLeft'
    const modDown = isMac ? { meta: true } : { alt: true }

    beforeInput?.(guard, { ...base, type: 'keyDown', key: modKey, code: modCode })
    beforeInput?.(guard, { ...base, type: 'keyDown', key: '2', code: 'Digit2', ...modDown })
    beforeInput?.(guard, { ...base, type: 'keyUp', key: modKey, code: modCode })
    expect(forward.mock.calls.map((call) => call[0])).toEqual([
      { phase: 'down', key: modKey, code: modCode, meta: false, ctrl: false, alt: false },
      { phase: 'down', key: '2', code: 'Digit2', meta: isMac, ctrl: false, alt: !isMac },
      { phase: 'up', key: modKey, code: modCode, meta: false, ctrl: false, alt: false }
    ])

    // 工作区页面自己的键盘输入既不转发,也绝不被 preventDefault 拦截。
    beforeInput?.(guard, { ...base, type: 'keyDown', key: 'a', code: 'KeyA' })
    beforeInput?.(guard, { ...base, type: 'keyDown', key: 'c', code: 'KeyC', ...modDown })
    beforeInput?.(guard, { ...base, type: 'char', key: '1', code: 'Digit1', ...modDown })
    expect(forward).toHaveBeenCalledTimes(3)
    expect(guard.preventDefault).not.toHaveBeenCalled()
  })

  it('disconnect destroys only the selected guest view so reopening creates a fresh one', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    const instanceId = '88888888-8888-4888-8888-888888888888'
    host.prepare(instanceId, 'http://127.0.0.1:3080/')
    const first = fakeViews()[0]

    host.disconnect(instanceId)

    expect(hub.contentView.removeChildView).toHaveBeenCalledWith(first)
    expect(first?.webContents.close).toHaveBeenCalledOnce()
    host.prepare(instanceId, 'http://127.0.0.1:3080/')
    expect(fakeViews()).toHaveLength(2)
  })

  it('hides and destroys guest views without exposing them to the renderer', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    host.prepare('22222222-2222-4222-8222-222222222222', 'http://127.0.0.1:3081/')
    const created = fakeViews()[0]
    host.hide()
    expect(created?.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    expect(created?.setVisible).toHaveBeenCalledWith(false)
    // 隐藏后把键盘焦点交还宿主渲染层;窗口本身不被抢占(makeKey 会打断应用激活)。
    expect(hub.webContents.focus).toHaveBeenCalledTimes(1)
    expect(hub.focus).not.toHaveBeenCalled()
    host.close('22222222-2222-4222-8222-222222222222')
    expect(hub.contentView.removeChildView).toHaveBeenCalledWith(created)
    expect(created?.webContents.close).toHaveBeenCalled()
  })

  it('focusActive gives keyboard focus to the visible workspace view', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    const instanceId = '99999999-9999-4999-9999-999999999999'
    host.prepare(instanceId, 'http://127.0.0.1:3082/')
    const view = fakeViews()[0]!

    host.focusActive()

    // focusEntry uses setImmediate; flush it.
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(view.webContents.focus).toHaveBeenCalled()
        resolve()
      })
    )
  })

  it('focusActive is a no-op when no workspace is visible', () => {
    const hub = hubWindow()
    const host = createWorkspaceHost(() => hub as never)
    host.prepare('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', 'http://127.0.0.1:3083/')
    const view = fakeViews()[0]!
    // hide() clears activeId, so focusActive should be a no-op.
    host.hide()
    host.focusActive()
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(view.webContents.focus).not.toHaveBeenCalled()
        resolve()
      })
    )
  })

  it('应用在后台(窗口未聚焦)时 setBounds 变可见不抢焦点', () => {
    const hub = hubWindow(false)
    const host = createWorkspaceHost(() => hub as never)
    host.prepare('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'http://127.0.0.1:3084/')
    const view = fakeViews()[0]!
    host.setBounds({ x: 64, y: 92, width: 1116, height: 688 })
    // 边界仍施加（视图照常可见），但不得调用 webContents.focus() 把后台应用顶到前台。
    expect(view.setBounds).toHaveBeenCalledWith({ x: 64, y: 92, width: 1116, height: 688 })
    expect(view.setVisible).toHaveBeenCalledWith(true)
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(view.webContents.focus).not.toHaveBeenCalled()
        resolve()
      })
    )
  })

  it('应用在后台(窗口未聚焦)时 focusActive 不抢焦点', () => {
    const hub = hubWindow(false)
    const host = createWorkspaceHost(() => hub as never)
    host.prepare('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'http://127.0.0.1:3085/')
    const view = fakeViews()[0]!
    host.focusActive()
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(view.webContents.focus).not.toHaveBeenCalled()
        resolve()
      })
    )
  })

  it('应用在后台(窗口未聚焦)时 hide 不把焦点交还宿主(避免顶到前台)', () => {
    const hub = hubWindow(false)
    const host = createWorkspaceHost(() => hub as never)
    host.prepare('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'http://127.0.0.1:3086/')
    host.hide()
    expect(hub.webContents.focus).not.toHaveBeenCalled()
    expect(hub.focus).not.toHaveBeenCalled()
  })
})
