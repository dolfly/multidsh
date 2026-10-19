import { beforeEach, describe, expect, it, vi } from 'vitest'
import { freshStore, harness } from './store.testkit'

/**
 * store 的保险库状态、活动日志、启动后自动打开与视图恢复：
 * 都由 store 的生命周期回调驱动，与设置项读写相互独立。
 */

describe('store vault', () => {
  it('refreshVault 写入主进程返回的最新快照', async () => {
    const useAppStore = await freshStore()
    expect(useAppStore.getState().vaultStatus).toBeNull()

    await useAppStore.getState().refreshVault()
    expect(useAppStore.getState().vaultStatus?.rememberedInstances).toEqual([])

    harness.vaultResult = {
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
    harness.vaultResult = {
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

    harness.vaultResult = { ok: false, message: '保险库不可用' }
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
    harness.sessionValues['dshhub-view'] = JSON.stringify({
      selection: INSTANCE_ID,
      settingsOpen: false
    })

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
    harness.sessionValues['dshhub-view'] = JSON.stringify({
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
    harness.sessionValues['dshhub-view'] = JSON.stringify({
      selection: INSTANCE_ID,
      settingsOpen: false
    })

    await useAppStore.getState().load()
    expect(useAppStore.getState().selection).toBeNull()
  })

  it('刷新后回到设置页', async () => {
    const useAppStore = await freshStore()
    stubInstanceBridge()
    harness.sessionValues['dshhub-view'] = JSON.stringify({ selection: null, settingsOpen: true })

    await useAppStore.getState().load()
    expect(useAppStore.getState().settingsOpen).toBe(true)
  })

  it('select 与设置页开合都会记下当前视图', async () => {
    const useAppStore = await freshStore()
    const stored = (): unknown => JSON.parse(harness.sessionValues['dshhub-view']!)

    useAppStore.getState().select(INSTANCE_ID)
    expect(stored()).toEqual({ selection: INSTANCE_ID, settingsOpen: false })

    useAppStore.getState().setSettingsOpen(true)
    expect(stored()).toEqual({ selection: null, settingsOpen: true })

    useAppStore.getState().select(null)
    expect(stored()).toEqual({ selection: null, settingsOpen: false })
  })
})
