import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '@shared/settings'
import type { VaultStatusSnapshot } from '@shared/contracts'
import { toStatusInfo } from './lib/format'

/**
 * store.ts tests run in Node, so browser globals are stubbed before dynamically importing the store.
 */

const DEFAULTS: Settings = {
  language: 'system',
  theme: 'system',
  tray: false,
  autoStart: false,
  notifications: true,
  preventSleepWhenRunning: false,
  workspaceCacheSize: 3,
  inheritShellEnv: true,
  npmRegistry: ''
}

type SettingsResult = { ok: true; value: Settings } | { ok: false; message: string }

let settingsValue: Settings
let updateResult: SettingsResult | null
let updateCalls: Array<Partial<Settings>>
let updateImpl: ((patch: Partial<Settings>) => SettingsResult | Promise<SettingsResult>) | null
let themeListeners: Array<() => void>
/** 订阅/退订**调用次数**(只看存活监听器数量抓不到「读了取消函数却没调用」的泄漏) */
let themeAdds: number
let themeRemoves: number
let matchDark: boolean
let storedTheme: string | null
/** sessionStorage 的内存内容(刷新后恢复视图用)：installGlobals 每次清空，用例可预置。 */
let sessionValues: Record<string, string>
/** vault.status 的返回值；登录成功后就地刷新「凭证存储」依赖它 */
let vaultResult: { ok: true; value: VaultStatusSnapshot } | { ok: false; message: string }

function installGlobals(): void {
  settingsValue = { ...DEFAULTS }
  updateResult = null
  updateCalls = []
  updateImpl = null
  themeListeners = []
  themeAdds = 0
  themeRemoves = 0
  matchDark = false
  storedTheme = null
  sessionValues = {}
  vaultResult = {
    ok: true,
    value: { available: true, degraded: false, rememberedInstances: [], policies: {} }
  }

  const media = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => {
      themeAdds += 1
      themeListeners.push(listener)
    },
    removeEventListener: (_: string, listener: () => void) => {
      themeRemoves += 1
      themeListeners = themeListeners.filter((entry) => entry !== listener)
    }
  }
  Object.defineProperty(media, 'matches', { get: () => matchDark })

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'dshhub-theme' ? storedTheme : null),
    setItem: (key: string, value: string) => {
      if (key === 'dshhub-theme') storedTheme = value
    }
  })
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => sessionValues[key] ?? null,
    setItem: (key: string, value: string) => {
      sessionValues[key] = value
    }
  })
  vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string> } })
  vi.stubGlobal('navigator', { language: 'zh-CN' })
  vi.stubGlobal('window', {
    // window-mode 模块顶层读 location.search 判定「关于」窗口,桩必须提供。
    location: { search: '' },
    matchMedia: () => media,
    dshHub: {
      settings: {
        get: async () => ({ ok: true, value: settingsValue }),
        update: async (patch: Partial<Settings>) => {
          updateCalls.push(patch)
          if (updateImpl) return await updateImpl(patch)
          if (updateResult) return updateResult
          settingsValue = { ...settingsValue, ...patch }
          return { ok: true, value: settingsValue }
        }
      },
      getInfo: async () => ({ ok: false }),
      instances: { list: async () => ({ ok: true, value: [] }) },
      vault: { status: async () => vaultResult }
    }
  })
}

async function freshStore(): Promise<typeof import('./store').useAppStore> {
  vi.resetModules()
  installGlobals()
  const module = await import('./store')
  return module.useAppStore
}

describe('store settings', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrateSettings 应用偏好语言并刷新翻译器', async () => {
    const useAppStore = await freshStore()
    settingsValue = { ...DEFAULTS, language: 'en' }
    await useAppStore.getState().hydrateSettings()
    const state = useAppStore.getState()
    expect(state.settings.language).toBe('en')
    expect(state.language).toBe('en')
    // 刷新翻译器后界面显示英文。
    expect(state.t('nav.settings')).toBe('Settings')
  })

  it('updateSettings 持久化后刷新翻译器与主题', async () => {
    const useAppStore = await freshStore()
    await useAppStore.getState().updateSettings({ language: 'en', theme: 'dark' })
    const state = useAppStore.getState()
    expect(updateCalls).toEqual([{ language: 'en', theme: 'dark' }])
    expect(state.language).toBe('en')
    expect(state.t('common.cancel')).toBe('Cancel')
    expect(state.theme).toBe('dark')
    expect((document.documentElement.dataset as Record<string, string>)['theme']).toBe('dark')
  })

  it('updateSettings 失败时抛出错误', async () => {
    const useAppStore = await freshStore()
    updateResult = { ok: false, message: '磁盘满' }
    await expect(useAppStore.getState().updateSettings({ language: 'en' })).rejects.toThrow(
      '磁盘满'
    )
    // 失败不得污染本地偏好
    expect(useAppStore.getState().settings.language).toBe('system')
  })

  it('subscribeSystemTheme 仅在偏好为 system 时跟随系统变化', async () => {
    const useAppStore = await freshStore()
    settingsValue = { ...DEFAULTS, theme: 'dark' }
    await useAppStore.getState().hydrateSettings()
    useAppStore.getState().subscribeSystemTheme()
    expect(themeListeners.length).toBe(1)

    // 显式 dark 偏好下，系统变化不得覆盖用户选择
    matchDark = false
    themeListeners.forEach((listener) => listener())
    expect(useAppStore.getState().theme).toBe('dark')

    // 切到 system 后，系统变化应生效
    await useAppStore.getState().updateSettings({ theme: 'system' })
    matchDark = true
    themeListeners.forEach((listener) => listener())
    expect(useAppStore.getState().theme).toBe('dark')

    matchDark = false
    themeListeners.forEach((listener) => listener())
    expect(useAppStore.getState().theme).toBe('light')
  })

  it('load() 重复调用时只保留一个系统主题监听', async () => {
    const useAppStore = await freshStore()

    await useAppStore.getState().load()
    // 第二次加载前取消先前的订阅。
    await useAppStore.getState().load()

    // 保留一个监听器，并在下一次加载前取消前一个监听器。
    expect(themeAdds).toBe(2)
    expect(themeRemoves).toBe(1)
    expect(themeListeners.length).toBe(1)
    // 订阅和退订的差值等于当前存活的监听器数量。
    expect(themeAdds - themeRemoves).toBe(themeListeners.length)

    // 新订阅仍会跟随系统主题。
    matchDark = true
    themeListeners.forEach((listener) => listener())
    expect(useAppStore.getState().theme).toBe('dark')
  })

  it('toggleTheme 持久化失败时显示 settings.saveFailed', async () => {
    const useAppStore = await freshStore()
    await useAppStore.getState().hydrateSettings()
    const failureTitle = useAppStore.getState().t('settings.saveFailed')

    // 成功时不显示失败提示。
    useAppStore.getState().toggleTheme()
    await vi.waitFor(() => {
      expect(updateCalls).toEqual([{ theme: 'dark' }])
    })
    expect(useAppStore.getState().toasts.some((item) => item.title === failureTitle)).toBe(false)

    // 失败时显示错误提示。
    updateImpl = () => {
      throw new Error('磁盘满')
    }
    useAppStore.getState().toggleTheme()
    await vi.waitFor(() => {
      expect(useAppStore.getState().toasts.some((item) => item.title === failureTitle)).toBe(true)
    })
    const failureToast = useAppStore.getState().toasts.find((item) => item.title === failureTitle)
    expect(failureToast?.kind).toBe('err')
    // 失败不改变已应用的本地主题。
    expect(useAppStore.getState().theme).toBe('dark')
  })

  it('刷新列表用主进程运行态快照恢复已连接状态，避免侧栏回退为灰色', async () => {
    const useAppStore = await freshStore()
    settingsValue = { ...DEFAULTS }
    vi.stubGlobal('window', {
      ...window,
      dshHub: {
        ...window.dshHub,
        instances: {
          list: async () => ({
            ok: true as const,
            value: [
              {
                id: 'running-instance',
                name: '运行中实例',
                transport: 'local' as const,
                authMode: 'auto' as const,
                address: '127.0.0.1:3080',
                runtimeStatus: 'running' as const,
                updatedAt: '2026-09-16T00:00:00.000Z'
              }
            ]
          })
        }
      }
    })

    await useAppStore.getState().refreshList()
    expect(toStatusInfo(useAppStore.getState().statuses['running-instance']?.status).dotClass).toBe(
      's-connected'
    )
  })

  it('打开向导前先隐藏工作区，避免原生视图覆盖弹窗；关闭后恢复同一缓存视图', async () => {
    const useAppStore = await freshStore()
    let resolveHide: (() => void) | undefined
    const hideView = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveHide = resolve
        })
    )
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView } }
    })
    useAppStore.setState({ selection: 'instance-1', workspaceOpen: true })

    useAppStore.getState().setWizardOpen(true)
    expect(hideView).toHaveBeenCalledOnce()
    expect(useAppStore.getState().wizardOpen).toBe(false)
    expect(useAppStore.getState().workspaceOpen).toBe(false)
    expect(useAppStore.getState().workspaceSuspended).toBe(true)

    resolveHide?.()
    await vi.waitFor(() => expect(useAppStore.getState().wizardOpen).toBe(true))

    useAppStore.getState().setWizardOpen(false)
    await vi.waitFor(() => expect(openView).toHaveBeenCalledWith('instance-1'))
    expect(useAppStore.getState().workspaceOpen).toBe(true)
  })

  it('选中实例或回到总览都会退出设置页（设置页不能困住导航）', async () => {
    const useAppStore = await freshStore()
    useAppStore.getState().setSettingsOpen(true)
    expect(useAppStore.getState().settingsOpen).toBe(true)

    useAppStore.getState().select('instance-1')
    expect(useAppStore.getState().selection).toBe('instance-1')
    expect(useAppStore.getState().settingsOpen).toBe(false)

    useAppStore.getState().setSettingsOpen(true)
    useAppStore.getState().select(null)
    expect(useAppStore.getState().selection).toBeNull()
    expect(useAppStore.getState().settingsOpen).toBe(false)
  })

  it('断开工作区只清除工作区连接状态，不停止仍在运行的实例', async () => {
    const useAppStore = await freshStore()
    const disconnectView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { disconnectView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      statuses: { running: { id: 'running', status: 'running', at: '2026-09-18T00:00:00.000Z' } },
      workspaceConnected: { running: true }
    })

    await useAppStore.getState().disconnectWorkspace('running')

    expect(disconnectView).toHaveBeenCalledWith('running')
    expect(useAppStore.getState().workspaceConnected.running).toBe(false)
    expect(useAppStore.getState().statuses.running?.status).toBe('running')
  })

  it('断开后的运行实例按未连接展示，再次打开工作区后恢复已连接', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      selection: 'running',
      statuses: { running: { id: 'running', status: 'running', at: '2026-09-18T00:00:00.000Z' } },
      workspaceConnected: { running: false }
    })

    expect(
      toStatusInfo('running', useAppStore.getState().workspaceConnected.running).labelKey
    ).toBe('state.idle')
    await useAppStore.getState().openWorkspace('running')
    expect(openView).toHaveBeenCalledWith('running')
    expect(useAppStore.getState().workspaceConnected.running).toBe(true)
    expect(
      toStatusInfo('running', useAppStore.getState().workspaceConnected.running).labelKey
    ).toBe('state.connected')
  })

  it('重新登录后重新打开工作区并刷新：先 openView 再 reloadView', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    const reloadView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, reloadView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      selection: 'running',
      statuses: { running: { id: 'running', status: 'running', at: '2026-09-18T00:00:00.000Z' } },
      workspaceConnected: { running: true }
    })

    await useAppStore.getState().reopenWorkspaceRefreshed('running')

    expect(openView).toHaveBeenCalledWith('running')
    expect(reloadView).toHaveBeenCalledWith('running')
    expect(useAppStore.getState().workspaceOpen).toBe(true)
  })

  it('重新打开工作区失败时不刷新（openView 失败则不 reloadView）', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({
      ok: false as const,
      code: 'invalid-state',
      message: '未运行'
    }))
    const reloadView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, reloadView, hideView: vi.fn() } }
    })
    useAppStore.setState({ selection: 'running' })

    await useAppStore.getState().reopenWorkspaceRefreshed('running')

    expect(openView).toHaveBeenCalledWith('running')
    expect(reloadView).not.toHaveBeenCalled()
  })

  it('打开工作区成功时先显示加载状态，再保留 selection 并显示内嵌工作区', async () => {
    const useAppStore = await freshStore()
    let resolveOpen: ((value: { ok: true; value: null }) => void) | undefined
    const openView = vi.fn(
      () =>
        new Promise<{ ok: true; value: null }>((resolve) => {
          resolveOpen = resolve
        })
    )
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.getState().select('instance-1')
    const opening = useAppStore.getState().openWorkspace('instance-1')
    expect(useAppStore.getState().selection).toBe('instance-1')
    expect(useAppStore.getState().workspaceOpening).toBe(true)
    expect(useAppStore.getState().workspaceOpen).toBe(false)

    resolveOpen?.({ ok: true, value: null })
    await opening
    expect(openView).toHaveBeenCalledWith('instance-1')
    expect(useAppStore.getState().workspaceOpening).toBe(false)
    expect(useAppStore.getState().workspaceOpen).toBe(true)
  })

  it('工作区已打开时重复打开同一实例不再隐藏和重开原生视图', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    const hideView = vi.fn()
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView } }
    })
    useAppStore.setState({ selection: 'instance-1', workspaceOpen: true })

    await useAppStore.getState().openWorkspace('instance-1')
    expect(hideView).not.toHaveBeenCalled()
    expect(openView).not.toHaveBeenCalled()
    expect(useAppStore.getState().workspaceOpen).toBe(true)
    expect(useAppStore.getState().workspaceOpening).toBe(false)
  })

  it('openView 在途时收到 running 状态不重复触发打开', async () => {
    const useAppStore = await freshStore()
    let resolveOpen!: (value: { ok: true; value: null }) => void
    const openView = vi.fn(
      () =>
        new Promise<{ ok: true; value: null }>((resolve) => {
          resolveOpen = resolve
        })
    )
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      selection: 'instance-1',
      workspaceOpening: true,
      statuses: {
        'instance-1': { id: 'instance-1', status: 'starting', at: '2026-09-18T00:00:00.000Z' }
      }
    })

    const opening = useAppStore.getState().openWorkspace('instance-1')
    useAppStore.getState().applyStatus({
      id: 'instance-1',
      status: 'running',
      at: '2026-09-18T00:00:01.000Z'
    })
    expect(openView).toHaveBeenCalledTimes(1)
    resolveOpen({ ok: true, value: null })
    await opening
    expect(useAppStore.getState()).toMatchObject({
      workspaceOpen: true,
      workspaceOpening: false
    })
  })

  it('工作区打开失败后退出加载状态并保留实例详情', async () => {
    const useAppStore = await freshStore()
    vi.stubGlobal('window', {
      ...window,
      dshHub: {
        ...window.dshHub,
        runtime: {
          openView: vi.fn(async () => ({ ok: false, code: 'invalid-state', message: '连接失败' })),
          hideView: vi.fn()
        }
      }
    })

    await useAppStore.getState().openWorkspace('instance-1')
    expect(useAppStore.getState().selection).toBe('instance-1')
    expect(useAppStore.getState().workspaceOpening).toBe(false)
    expect(useAppStore.getState().workspaceOpen).toBe(false)
  })

  it('侧栏点击任意错误实例时直接进入详情，不发起必然失败的打开请求', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      instances: [
        {
          id: 'broken-ssh',
          name: '损坏 SSH 实例',
          transport: 'ssh',
          authMode: 'auto',
          address: 'dsh.internal:8080',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ],
      statuses: {
        'broken-ssh': {
          id: 'broken-ssh',
          status: 'error',
          at: '2026-09-18T00:00:00.000Z',
          detail: 'SSH 鉴权失败'
        }
      }
    })

    useAppStore.getState().openFromSidebar('broken-ssh')
    expect(useAppStore.getState().selection).toBe('broken-ssh')
    expect(useAppStore.getState().workspaceOpen).toBe(false)
    expect(useAppStore.getState().workspaceOpening).toBe(false)
    expect(openView).not.toHaveBeenCalled()
  })

  it('连接中实例在侧栏点击后保持加载页，收到运行状态后打开工作区', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      instances: [
        {
          id: 'starting-ssh',
          name: '连接中的 SSH 实例',
          transport: 'ssh',
          authMode: 'auto',
          address: 'dsh.internal:8080',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ],
      statuses: {
        'starting-ssh': {
          id: 'starting-ssh',
          status: 'starting',
          at: '2026-09-18T00:00:00.000Z'
        }
      }
    })

    useAppStore.getState().openFromSidebar('starting-ssh')
    expect(useAppStore.getState()).toMatchObject({
      selection: 'starting-ssh',
      workspaceOpening: true,
      workspaceOpen: false
    })
    expect(openView).not.toHaveBeenCalled()
    useAppStore.getState().applyStatus({
      id: 'starting-ssh',
      status: 'running',
      url: 'http://127.0.0.1:30000/',
      at: '2026-09-18T00:00:01.000Z'
    })
    await vi.waitFor(() => expect(openView).toHaveBeenCalledWith('starting-ssh'))
    expect(useAppStore.getState().workspaceOpen).toBe(true)
  })

  it('连接中实例收到失败状态时回到实例详情', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      instances: [
        {
          id: 'failed-ssh',
          name: '失败中的 SSH 实例',
          transport: 'ssh',
          authMode: 'auto',
          address: 'dsh.internal:8080',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ],
      statuses: {
        'failed-ssh': {
          id: 'failed-ssh',
          status: 'starting',
          at: '2026-09-18T00:00:00.000Z'
        }
      }
    })

    useAppStore.getState().openFromSidebar('failed-ssh')
    expect(useAppStore.getState().workspaceOpening).toBe(true)
    useAppStore.getState().applyStatus({
      id: 'failed-ssh',
      status: 'error',
      detail: 'SSH 隧道失败',
      at: '2026-09-18T00:00:01.000Z'
    })
    expect(useAppStore.getState()).toMatchObject({
      selection: 'failed-ssh',
      workspaceOpen: false,
      workspaceOpening: false
    })
  })

  it('侧栏点击非错误实例时仍按原流程打开工作区', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({
      instances: [
        {
          id: 'ready-local',
          name: '可用本机实例',
          transport: 'local',
          authMode: 'auto',
          address: '127.0.0.1:3080',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ]
    })

    useAppStore.getState().openFromSidebar('ready-local')
    await vi.waitFor(() => expect(openView).toHaveBeenCalledWith('ready-local'))
  })

  it('网关远程实例运行后弹登录框、保留 loginGate，不直接打开工作区', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    const probe = vi.fn(async () => ({
      ok: true as const,
      value: {
        phase: 'await-credentials' as const,
        needsOnboarding: false,
        otpEnabled: false,
        lockedForMs: 0,
        message: null,
        lastErrorCode: null
      }
    }))
    const dispatched: Array<{ type: string; detail: unknown }> = []
    class FakeCustomEvent {
      type: string
      detail: unknown
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type
        this.detail = init?.detail
      }
    }
    vi.stubGlobal('CustomEvent', FakeCustomEvent)
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() }, auth: { probe } },
      dispatchEvent: (event: { type: string; detail: unknown }) =>
        dispatched.push({ type: event.type, detail: event.detail })
    })
    useAppStore.setState({
      instances: [
        {
          id: 'gw-remote',
          name: '网关远程实例',
          transport: 'http',
          authMode: 'auto',
          address: 'gw.example.com',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ]
    })
    useAppStore.getState().setPendingOpen('gw-remote')
    useAppStore.getState().setLoginGate('gw-remote')
    useAppStore.getState().applyStatus({
      id: 'gw-remote',
      status: 'running',
      url: 'https://gw.example.com/',
      at: '2026-09-18T00:00:01.000Z'
    })

    await vi.waitFor(() => expect(probe).toHaveBeenCalledWith('gw-remote'))
    await vi.waitFor(() =>
      expect(dispatched).toContainEqual({
        type: 'dsh-hub:open-auth',
        detail: { id: 'gw-remote', name: '网关远程实例' }
      })
    )
    expect(openView).not.toHaveBeenCalled()
    // 保留门：登录成功后由 App 的 auth:state 订阅打开工作区。
    expect(useAppStore.getState().loginGate).toContain('gw-remote')
    expect(useAppStore.getState().pendingOpen).not.toContain('gw-remote')
  })

  it('无网关远程实例运行后直接打开工作区并清除 loginGate', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    const probe = vi.fn(async () => ({
      ok: true as const,
      value: {
        phase: 'connected' as const,
        needsOnboarding: false,
        otpEnabled: false,
        lockedForMs: 0,
        message: null,
        lastErrorCode: null
      }
    }))
    vi.stubGlobal(
      'CustomEvent',
      class {
        constructor(
          public type: string,
          public init?: unknown
        ) {}
      }
    )
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() }, auth: { probe } },
      dispatchEvent: vi.fn()
    })
    useAppStore.setState({
      instances: [
        {
          id: 'open-remote',
          name: '无网关远程实例',
          transport: 'http',
          authMode: 'none',
          address: 'open.example.com',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ]
    })
    useAppStore.getState().setPendingOpen('open-remote')
    useAppStore.getState().setLoginGate('open-remote')
    useAppStore.getState().applyStatus({
      id: 'open-remote',
      status: 'running',
      url: 'https://open.example.com/',
      at: '2026-09-18T00:00:01.000Z'
    })

    await vi.waitFor(() => expect(openView).toHaveBeenCalledWith('open-remote'))
    expect(probe).toHaveBeenCalledWith('open-remote')
    expect(useAppStore.getState().loginGate).not.toContain('open-remote')
  })

  it('登录门实例启动失败时清除 loginGate、不探测认证', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    const probe = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() }, auth: { probe } },
      dispatchEvent: vi.fn()
    })
    useAppStore.setState({
      instances: [
        {
          id: 'fail-remote',
          name: '失败远程实例',
          transport: 'http',
          authMode: 'auto',
          address: 'fail.example.com',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ]
    })
    useAppStore.getState().setPendingOpen('fail-remote')
    useAppStore.getState().setLoginGate('fail-remote')
    useAppStore.getState().applyStatus({
      id: 'fail-remote',
      status: 'error',
      detail: '端点不可达',
      at: '2026-09-18T00:00:01.000Z'
    })

    expect(useAppStore.getState().loginGate).not.toContain('fail-remote')
    expect(openView).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('离开工作区前使在途打开失效，迟到完成不能重新显示原生视图', async () => {
    const useAppStore = await freshStore()
    let resolveOpen!: (value: { ok: true; value: null }) => void
    const hideView = vi.fn(async () => ({ ok: true as const, value: null }))
    const openView = vi.fn(
      () =>
        new Promise<{ ok: true; value: null }>((resolve) => {
          resolveOpen = resolve
        })
    )
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView } }
    })

    const opening = useAppStore.getState().openWorkspace('instance-a')
    useAppStore.getState().setSettingsOpen(true)
    resolveOpen({ ok: true, value: null })
    await opening

    expect(useAppStore.getState()).toMatchObject({
      settingsOpen: true,
      selection: null,
      workspaceOpen: false,
      workspaceOpening: false
    })
  })

  it('过期工作区打开完成不会隐藏后一次选择的原生视图', async () => {
    const useAppStore = await freshStore()
    let resolveA!: (value: { ok: true; value: null }) => void
    let resolveB!: (value: { ok: true; value: null }) => void
    const hideView = vi.fn(async () => ({ ok: true as const, value: null }))
    const openView = vi.fn(
      (id: string) =>
        new Promise<{ ok: true; value: null }>((resolve) => {
          if (id === 'instance-a') resolveA = resolve
          else resolveB = resolve
        })
    )
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView } }
    })

    const first = useAppStore.getState().openWorkspace('instance-a')
    const second = useAppStore.getState().openWorkspace('instance-b')
    resolveB({ ok: true, value: null })
    await second
    resolveA({ ok: true, value: null })
    await first

    expect(useAppStore.getState()).toMatchObject({
      selection: 'instance-b',
      workspaceOpen: true,
      workspaceOpening: false
    })
    expect(hideView).toHaveBeenCalledTimes(2)
  })

  it('openView 永不返回：超时兜底退出加载页并提示', async () => {
    const useAppStore = await freshStore()
    // 与 store 同一次 resetModules 后的模块实例（static import 会拿到旧图）
    const { workspaceOpenInFlight } = await import('./store/workspace-slice')
    const openView = vi.fn(() => new Promise<never>(() => undefined))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.getState().select('instance-1')
    vi.useFakeTimers()
    try {
      void useAppStore.getState().openWorkspace('instance-1')
      expect(useAppStore.getState().workspaceOpening).toBe(true)

      await vi.advanceTimersByTimeAsync(10_000)
      // 界面不停在「正在打开工作区…」：加载页退出 + 明确提示 + 在途标记清除
      expect(useAppStore.getState().workspaceOpening).toBe(false)
      const timeoutTitle = useAppStore.getState().t('detail.openViewTimeout')
      expect(useAppStore.getState().toasts.some((item) => item.title === timeoutTitle)).toBe(true)
      expect(workspaceOpenInFlight()).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('运行中的本机实例从详情打开工作区时不重复启动', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    const start = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, start, hideView: vi.fn() } }
    })

    useAppStore.setState({
      selection: 'running-local',
      statuses: {
        'running-local': { id: 'running-local', status: 'running', at: '2026-09-18T00:00:00.000Z' }
      }
    })
    await useAppStore.getState().openWorkspace('running-local')
    expect(openView).toHaveBeenCalledWith('running-local')
    expect(start).not.toHaveBeenCalled()
  })

  it('本机实例运行事件带实际端口时立即更新左侧列表地址', async () => {
    const useAppStore = await freshStore()
    useAppStore.setState({
      instances: [
        {
          id: 'auto-port-local',
          name: '自动端口实例',
          transport: 'local',
          authMode: 'auto',
          address: '127.0.0.1:—',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ]
    })

    useAppStore.getState().applyStatus({
      id: 'auto-port-local',
      status: 'running',
      port: 30123,
      at: '2026-09-18T00:00:01.000Z'
    })
    expect(useAppStore.getState().instances[0]?.address).toBe('127.0.0.1:30123')
  })

  it('运行事件的启动命令写入详情记录，stopped 清状态后该行仍能显示', async () => {
    const useAppStore = await freshStore()
    useAppStore.setState({
      records: {
        'cmd-local': {
          id: 'cmd-local',
          name: '命令实例',
          transport: 'local',
          authMode: 'auto',
          dshVersion: null,
          port: null,
          profile: null,
          launcher: null,
          useDefaultSpace: false,
          runCommand: null,
          autoStart: false,
          createdAt: '2026-09-18T00:00:00.000Z',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      }
    })
    const command = '/tmp/dsh --profile web --port 3080 --no-open'

    useAppStore.getState().applyStatus({
      id: 'cmd-local',
      status: 'running',
      command,
      at: '2026-09-18T00:00:01.000Z'
    })
    expect(useAppStore.getState().records['cmd-local']).toMatchObject({ runCommand: command })

    useAppStore.getState().applyStatus({
      id: 'cmd-local',
      status: 'stopped',
      at: '2026-09-18T00:00:02.000Z'
    })
    expect(useAppStore.getState().statuses['cmd-local']).toBeUndefined()
    expect(useAppStore.getState().records['cmd-local']).toMatchObject({ runCommand: command })
  })

  it('applyStatus 每次事件都换 statuses 引用(订阅者才会重渲染),圆点随之实时变化', async () => {
    const useAppStore = await freshStore()
    const before = useAppStore.getState().statuses

    // starting:未连接(灰)→ 连接中(蓝)
    useAppStore.getState().applyStatus({
      id: 'i1',
      status: 'starting',
      at: '2026-09-16T00:00:00.000Z'
    })
    const starting = useAppStore.getState().statuses
    expect(starting, 'statuses 必须是新对象,否则列表收不到状态事件').not.toBe(before)
    expect(toStatusInfo(starting['i1']?.status).dotClass).toBe('s-connecting')

    // running:连接中(蓝)→ 已连接(绿)。同一行**不重建**也要拿到新类名
    useAppStore.getState().applyStatus({
      id: 'i1',
      status: 'running',
      at: '2026-09-16T00:00:01.000Z'
    })
    const running = useAppStore.getState().statuses
    expect(running).not.toBe(starting)
    expect(toStatusInfo(running['i1']?.status).dotClass).toBe('s-connected')

    // 状态按实例隔离。
    useAppStore.getState().applyStatus({
      id: 'i2',
      status: 'error',
      at: '2026-09-16T00:00:02.000Z'
    })
    const mixed = useAppStore.getState().statuses
    expect(toStatusInfo(mixed['i1']?.status).dotClass).toBe('s-connected')
    expect(toStatusInfo(mixed['i2']?.status).dotClass).toBe('s-error')
  })

  it('applyStatus 的 stopped 事件清掉该实例状态(圆点回落到灰),不残留上一帧的绿点', async () => {
    const useAppStore = await freshStore()
    useAppStore.getState().applyStatus({
      id: 'i1',
      status: 'running',
      at: '2026-09-16T00:00:00.000Z'
    })
    expect(toStatusInfo(useAppStore.getState().statuses['i1']?.status).dotClass).toBe('s-connected')

    useAppStore.getState().applyStatus({
      id: 'i1',
      status: 'stopped',
      at: '2026-09-16T00:00:02.000Z'
    })
    const stopped = useAppStore.getState().statuses
    // stopped 时移除状态记录，展示回到 idle。
    expect(stopped['i1']).toBeUndefined()
    expect(toStatusInfo(stopped['i1']?.status).dotClass).toBe('')
  })
})

describe('store vault', () => {
  it('refreshVault 写入主进程返回的最新快照', async () => {
    const useAppStore = await freshStore()
    expect(useAppStore.getState().vaultStatus).toBeNull()

    await useAppStore.getState().refreshVault()
    expect(useAppStore.getState().vaultStatus?.rememberedInstances).toEqual([])

    vaultResult = {
      ok: true,
      value: {
        available: true,
        degraded: false,
        rememberedInstances: ['instance-1'],
        policies: { 'instance-1': { rememberPassword: true, rememberSession: true } }
      }
    }
    await useAppStore.getState().refreshVault()
    expect(useAppStore.getState().vaultStatus?.rememberedInstances).toEqual(['instance-1'])
  })

  it('读取失败时保留上一份快照，不把已记住的凭据显示成未记住', async () => {
    const useAppStore = await freshStore()
    vaultResult = {
      ok: true,
      value: {
        available: true,
        degraded: false,
        rememberedInstances: ['instance-1'],
        policies: {}
      }
    }
    await useAppStore.getState().refreshVault()
    expect(useAppStore.getState().vaultStatus?.rememberedInstances).toEqual(['instance-1'])

    vaultResult = { ok: false, message: '保险库不可用' }
    await useAppStore.getState().refreshVault()
    expect(useAppStore.getState().vaultStatus?.rememberedInstances).toEqual(['instance-1'])
  })
})

describe('store 活动日志（详情页底部信息栏）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('追加运行状态与升级进度行，连续重复行去重', async () => {
    const store = await freshStore()
    const id = 'activity-dedupe'
    store.getState().appendActivity(id, {
      source: 'runtime',
      at: '2026-09-23T00:00:00.000Z',
      detail: '准备 dsh 0.1.6 运行时'
    })
    store.getState().appendActivity(id, {
      source: 'runtime',
      at: '2026-09-23T00:00:01.000Z',
      detail: '准备 dsh 0.1.6 运行时'
    })
    store.getState().appendActivity(id, {
      source: 'runtime',
      at: '2026-09-23T00:00:02.000Z',
      detail: '分配端口并启动进程（端口 3080）'
    })
    expect(store.getState().activityLog[id]).toHaveLength(2)

    const checking = { instanceId: id, phase: 'checking' as const, at: '2026-09-23T00:00:03.000Z' }
    store.getState().appendActivity(id, { source: 'version', event: checking })
    store.getState().appendActivity(id, {
      source: 'version',
      event: { ...checking, at: '2026-09-23T00:00:04.000Z' }
    })
    expect(store.getState().activityLog[id]).toHaveLength(3)
  })

  it('超限丢弃最旧行，clearActivity 清空', async () => {
    const store = await freshStore()
    const id = 'activity-cap'
    for (let index = 0; index < 205; index += 1) {
      store
        .getState()
        .appendActivity(id, { source: 'runtime', at: `t${index}`, detail: `行 ${index}` })
    }
    const lines = store.getState().activityLog[id]
    expect(lines).toHaveLength(200)
    expect(lines?.[0]).toMatchObject({ source: 'runtime', detail: '行 5' })
    expect(lines?.[lines.length - 1]).toMatchObject({ source: 'runtime', detail: '行 204' })

    store.getState().clearActivity(id)
    expect(store.getState().activityLog[id]).toBeUndefined()
  })

  it('每行分配单调递增 seq 作 React key：截尾后已存在行的 seq 不变', async () => {
    const store = await freshStore()
    const id = 'activity-seq'
    // 先追加满 200 行
    for (let index = 0; index < 200; index += 1) {
      store
        .getState()
        .appendActivity(id, { source: 'runtime', at: `t${index}`, detail: `行 ${index}` })
    }
    const before = store.getState().activityLog[id]!
    // 记录截尾前尾部若干行的 seq（它们在下次追加后仍在窗口内）
    const tailSeqBefore = before.slice(-3).map((line) => line.seq)
    const tailDetailBefore = before
      .slice(-3)
      .map((line) => (line.source === 'runtime' ? line.detail : ''))

    // 再追加一行 → 触发截尾（首行被丢），窗口整体左移
    store.getState().appendActivity(id, { source: 'runtime', at: 't200', detail: '行 200' })
    const after = store.getState().activityLog[id]!
    expect(after).toHaveLength(200)

    // 原尾部三行现在位于倒数 4..2，seq 未变（若用 index 作 key 会全部左移一位 → 全量重挂）
    const relocated = after.slice(-4, -1)
    expect(relocated.map((line) => line.seq)).toEqual(tailSeqBefore)
    expect(relocated.map((line) => (line.source === 'runtime' ? line.detail : ''))).toEqual(
      tailDetailBefore
    )
    // seq 全局唯一，无重复
    expect(new Set(after.map((line) => line.seq)).size).toBe(after.length)
  })
})

describe('pendingOpen（启动完成后自动打开工作区）', () => {
  it('同一实例等待启动时 running 仍自动打开工作区', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({ selection: 'boot-a', pendingOpen: ['boot-a'] })

    useAppStore.getState().applyStatus({
      id: 'boot-a',
      status: 'running',
      at: '2026-09-18T00:00:01.000Z'
    })
    await vi.waitFor(() => expect(openView).toHaveBeenCalledWith('boot-a'))
    expect(useAppStore.getState().pendingOpen).toEqual([])
  })

  it('切换实例即放弃待打开:该实例 running 不再把界面拽回工作区', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({ selection: 'boot-a', pendingOpen: ['boot-a'] })

    useAppStore.getState().select('boot-b')
    expect(useAppStore.getState().pendingOpen).toEqual([])

    useAppStore.getState().applyStatus({
      id: 'boot-a',
      status: 'running',
      at: '2026-09-18T00:00:01.000Z'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(openView).not.toHaveBeenCalled()
    expect(useAppStore.getState().selection).toBe('boot-b')
  })

  it('打开设置页即放弃待打开:实例启动完成不会关掉设置页', async () => {
    const useAppStore = await freshStore()
    const openView = vi.fn(async () => ({ ok: true as const, value: null }))
    vi.stubGlobal('window', {
      ...window,
      dshHub: { ...window.dshHub, runtime: { openView, hideView: vi.fn() } }
    })
    useAppStore.setState({ selection: 'boot-a', pendingOpen: ['boot-a'] })

    useAppStore.getState().setSettingsOpen(true)
    expect(useAppStore.getState().pendingOpen).toEqual([])

    useAppStore.getState().applyStatus({
      id: 'boot-a',
      status: 'running',
      at: '2026-09-18T00:00:01.000Z'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(openView).not.toHaveBeenCalled()
    expect(useAppStore.getState().settingsOpen).toBe(true)
    expect(useAppStore.getState().selection).toBeNull()
  })
})

describe('refreshList 错误态', () => {
  it('列表加载失败记录 listError,成功后清除', async () => {
    const useAppStore = await freshStore()
    vi.stubGlobal('window', {
      ...window,
      dshHub: {
        ...window.dshHub,
        instances: {
          list: async () => ({ ok: false as const, code: 'io-error', message: '注册表读取失败' })
        }
      }
    })

    await useAppStore.getState().refreshList()
    expect(useAppStore.getState().listError).toBe('注册表读取失败')

    vi.stubGlobal('window', {
      ...window,
      dshHub: {
        ...window.dshHub,
        instances: { list: async () => ({ ok: true as const, value: [] }) }
      }
    })
    await useAppStore.getState().refreshList()
    expect(useAppStore.getState().listError).toBeNull()
  })

  it('加载失败不清空已有列表,已有数据仍可展示', async () => {
    const useAppStore = await freshStore()
    useAppStore.setState({
      instances: [
        {
          id: 'kept',
          name: '保留实例',
          transport: 'local',
          authMode: 'auto',
          address: '127.0.0.1:3080',
          updatedAt: '2026-09-18T00:00:00.000Z'
        }
      ]
    })
    vi.stubGlobal('window', {
      ...window,
      dshHub: {
        ...window.dshHub,
        instances: {
          list: async () => ({ ok: false as const, code: 'io-error', message: '注册表读取失败' })
        }
      }
    })

    await useAppStore.getState().refreshList()
    expect(useAppStore.getState().listError).toBe('注册表读取失败')
    expect(useAppStore.getState().instances).toHaveLength(1)
  })
})

describe('自动禁用提示的发送权', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('同一实例同一 dsh 版本只发一次；并发调用也只有先到的一次通过', async () => {
    const useAppStore = await freshStore()
    const once = (): boolean =>
      useAppStore.getState().notifyAutoDisabledOnce('inst-1', '0.2.0-rc.2')

    // 两次「并发」领取（模拟 StrictMode 双调用挂载 effect 的两次加载）：只有第一次拿到发送权。
    expect(once()).toBe(true)
    expect(once()).toBe(false)
    expect(useAppStore.getState().autoDisabledNotified).toEqual({ 'inst-1': '0.2.0-rc.2' })
  })

  it('dsh 版本再次变更或换实例都会重新提示', async () => {
    const useAppStore = await freshStore()
    expect(useAppStore.getState().notifyAutoDisabledOnce('inst-1', '0.2.0-rc.2')).toBe(true)
    // 同一实例的新版本（下一次升级后又禁用了一批插件）要重新提示。
    expect(useAppStore.getState().notifyAutoDisabledOnce('inst-1', '0.3.0')).toBe(true)
    // 其它实例各自独立。
    expect(useAppStore.getState().notifyAutoDisabledOnce('inst-2', '0.2.0-rc.2')).toBe(true)
  })
})

describe('刷新后的视图恢复', () => {
  const INSTANCE_ID = '11111111-1111-4111-8111-111111111111'

  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  /** 列表里有 INSTANCE_ID 这个实例，且 instances.get 能取回它的完整记录。 */
  function stubInstanceBridge(): void {
    vi.stubGlobal('window', {
      ...window,
      dshHub: {
        ...window.dshHub,
        instances: {
          list: async () => ({
            ok: true as const,
            value: [
              {
                id: INSTANCE_ID,
                name: '恢复实例',
                transport: 'local' as const,
                authMode: 'auto' as const,
                address: '127.0.0.1:3080',
                updatedAt: '2026-09-30T00:00:00.000Z'
              }
            ]
          }),
          get: async (id: string) => ({
            ok: true as const,
            value: {
              id,
              name: '恢复实例',
              transport: 'local' as const,
              authMode: 'auto' as const,
              createdAt: '2026-09-30T00:00:00.000Z',
              updatedAt: '2026-09-30T00:00:00.000Z',
              dshVersion: '0.2.0-rc.2',
              port: 3080,
              profile: null,
              launcher: null,
              useDefaultSpace: false,
              runCommand: null,
              autoStart: false
            }
          })
        }
      }
    })
  }

  it('刷新后回到详情页：先把记录取回来再切视图', async () => {
    const useAppStore = await freshStore()
    stubInstanceBridge()
    sessionValues['dshhub-view'] = JSON.stringify({ selection: INSTANCE_ID, settingsOpen: false })

    await useAppStore.getState().load()

    const state = useAppStore.getState()
    expect(state.loaded).toBe(true)
    expect(state.selection).toBe(INSTANCE_ID)
    // 记录已在切视图前就位：详情页不会先闪一帧「找不到该实例」占位。
    expect(state.records[INSTANCE_ID]?.name).toBe('恢复实例')
  })

  it('选中的实例已不存在（被删除）→ 留在总览，不进空详情页', async () => {
    const useAppStore = await freshStore()
    stubInstanceBridge()
    sessionValues['dshhub-view'] = JSON.stringify({
      selection: '22222222-2222-4222-8222-222222222222',
      settingsOpen: false
    })

    await useAppStore.getState().load()
    expect(useAppStore.getState().loaded).toBe(true)
    expect(useAppStore.getState().selection).toBeNull()
  })

  it('记录取不回来时同样留在总览', async () => {
    const useAppStore = await freshStore()
    stubInstanceBridge()
    vi.stubGlobal('window', {
      ...window,
      dshHub: {
        ...window.dshHub,
        instances: {
          ...window.dshHub.instances,
          get: async () => ({ ok: false, code: 'not-found', message: '找不到' })
        }
      }
    })
    sessionValues['dshhub-view'] = JSON.stringify({ selection: INSTANCE_ID, settingsOpen: false })

    await useAppStore.getState().load()
    expect(useAppStore.getState().selection).toBeNull()
  })

  it('刷新后回到设置页', async () => {
    const useAppStore = await freshStore()
    stubInstanceBridge()
    sessionValues['dshhub-view'] = JSON.stringify({ selection: null, settingsOpen: true })

    await useAppStore.getState().load()
    expect(useAppStore.getState().settingsOpen).toBe(true)
  })

  it('select 与设置页开合都会记下当前视图', async () => {
    const useAppStore = await freshStore()
    const stored = (): unknown => JSON.parse(sessionValues['dshhub-view']!)

    useAppStore.getState().select(INSTANCE_ID)
    expect(stored()).toEqual({ selection: INSTANCE_ID, settingsOpen: false })

    useAppStore.getState().setSettingsOpen(true)
    expect(stored()).toEqual({ selection: null, settingsOpen: true })

    useAppStore.getState().select(null)
    expect(stored()).toEqual({ selection: null, settingsOpen: false })
  })
})
