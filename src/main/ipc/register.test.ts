import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// electron 在 vitest node 环境不可加载——整体 mock 掉,只验证注册与边界行为
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getVersion: () => '9.9.9',
    getPath: () => '/tmp/fake-userdata',
    getLocale: () => 'zh-CN',
    getPreferredSystemLanguages: () => ['zh-Hans-CN', 'en']
  }
}))

import { ipcMain } from 'electron'
import type { InstanceStatusEvent } from '@shared/contracts'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import type { SshTunnelManager } from '../transport/ssh-tunnel'
import type { HttpEndpointManager } from '../transport/http-endpoint'
import { createInstanceStore } from '../registry/instance-store'
import { emptyEnvironmentDiff } from '../local-runtime/env-diff'
import { registerIpc } from './register'

type Listener = (...args: unknown[]) => unknown

const TEST_BASE = join(process.cwd(), 'hub-data', 'test-tmp')

let dir: string
let handlers: Map<string, Listener>
let runtimeFake: {
  onStatus: ReturnType<typeof vi.fn>
  onUpgradeProgress: ReturnType<typeof vi.fn>
  statusOf: ReturnType<typeof vi.fn>
  urlOf: ReturnType<typeof vi.fn>
  runningIds: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  stopAll: ReturnType<typeof vi.fn>
  refreshEnv: ReturnType<typeof vi.fn>
  adopt: ReturnType<typeof vi.fn>
  upgradeInstance: ReturnType<typeof vi.fn>
}
let tunnelsFake: {
  onStatus: ReturnType<typeof vi.fn>
  statusOf: ReturnType<typeof vi.fn>
  runningIds: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  stopAll: ReturnType<typeof vi.fn>
  forgetHostKey: ReturnType<typeof vi.fn>
}
let openInstanceView: ReturnType<typeof vi.fn>
let openExternalUrl: ReturnType<typeof vi.fn>
let instanceViewUrlFake: ReturnType<typeof vi.fn>
let externalDshScannerFake: { scan: ReturnType<typeof vi.fn> }
let httpFake: {
  onStatus: ReturnType<typeof vi.fn>
  statusOf: ReturnType<typeof vi.fn>
  runningIds: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  stopAll: ReturnType<typeof vi.fn>
}
let authFake: {
  probe: ReturnType<typeof vi.fn>
  login: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
  stateOf: ReturnType<typeof vi.fn>
  forget: ReturnType<typeof vi.fn>
  beginLogout: ReturnType<typeof vi.fn>
  endLogout: ReturnType<typeof vi.fn>
  isLoggingOut: ReturnType<typeof vi.fn>
  client: ReturnType<typeof vi.fn>
  sessionCookie: ReturnType<typeof vi.fn>
  clientIds: ReturnType<typeof vi.fn>
}
let clearPartitionSession: ReturnType<typeof vi.fn>
let closeInstanceView: ReturnType<typeof vi.fn>
let reloadInstanceView: ReturnType<typeof vi.fn>
let showInstanceTooltip: ReturnType<typeof vi.fn>
let hideInstanceTooltip: ReturnType<typeof vi.fn>
let vaultFake: Record<string, ReturnType<typeof vi.fn>>
let auditSpy: (entry: { instanceId?: string | null; event: string; result?: string }) => void
let settingsFake: Record<string, ReturnType<typeof vi.fn>>
let onSettingsChanged: ReturnType<typeof vi.fn>
let promptBrokerFake: {
  requestHostKey: ReturnType<typeof vi.fn>
  requestAskpass: ReturnType<typeof vi.fn>
  replyHostKey: ReturnType<typeof vi.fn>
  replyAskpass: ReturnType<typeof vi.fn>
  replyConfirm: ReturnType<typeof vi.fn>
  listConfirms: ReturnType<typeof vi.fn>
  cancelAll: ReturnType<typeof vi.fn>
}
let currentStatus: InstanceStatusEvent | null
let verifyExternalAccess: ReturnType<typeof vi.fn>
let listLocalSpaces: ReturnType<typeof vi.fn>
let trashLocalSpace: ReturnType<typeof vi.fn>
let installerFake: {
  listAvailableVersions: ReturnType<typeof vi.fn>
  resolveDefaultVersion: ReturnType<typeof vi.fn>
  resolveLatestVersion: ReturnType<typeof vi.fn>
  listInstalled: ReturnType<typeof vi.fn>
  isInstalled: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
  ensureInstalled: ReturnType<typeof vi.fn>
  resolveEntry: ReturnType<typeof vi.fn>
  hasIncompleteInstall: ReturnType<typeof vi.fn>
  resolveGlobalPrefix: ReturnType<typeof vi.fn>
  installGlobal: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}
let pluginManagerFake: {
  list: ReturnType<typeof vi.fn>
  check: ReturnType<typeof vi.fn>
  checkState: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
  upgrade: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
}
let ipcDeps: Parameters<typeof registerIpc>[1]

beforeEach(async () => {
  await mkdir(TEST_BASE, { recursive: true })
  dir = await mkdtemp(join(TEST_BASE, 'ipc-'))
  handlers = new Map()
  vi.mocked(ipcMain.handle).mockImplementation((channel, listener) => {
    handlers.set(channel as string, listener as Listener)
    return undefined as never
  })
  currentStatus = null
  verifyExternalAccess = vi.fn(async () => true)
  listLocalSpaces = vi.fn(async () => [])
  trashLocalSpace = vi.fn(async () => undefined)
  installerFake = {
    listAvailableVersions: vi.fn(async () => ['0.1.4', '0.1.5']),
    resolveDefaultVersion: vi.fn(async () => '0.1.5'),
    resolveLatestVersion: vi.fn(async () => '0.1.5'),
    listInstalled: vi.fn(async () => []),
    isInstalled: vi.fn(async () => false),
    install: vi.fn(async () => ({ version: '0.1.5', dir: '/tmp/d', entry: '/tmp/e', installedAt: '' })),
    ensureInstalled: vi.fn(async () => ({ version: '0.1.5', dir: '/tmp/d', entry: '/tmp/e', installedAt: '' })),
    resolveEntry: vi.fn((v: string) => `/tmp/${v}`),
    hasIncompleteInstall: vi.fn(async () => false),
    resolveGlobalPrefix: vi.fn(async () => '/usr/local'),
    installGlobal: vi.fn(async () => undefined),
    dispose: vi.fn(() => undefined)
  }
  runtimeFake = {
    onStatus: vi.fn(() => () => undefined),
    onUpgradeProgress: vi.fn(() => () => undefined),
    statusOf: vi.fn(() => currentStatus),
    urlOf: vi.fn(() => currentStatus?.url ?? null),
    runningIds: vi.fn(() => []),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    refreshEnv: vi.fn(async () => emptyEnvironmentDiff()),
    adopt: vi.fn(async () => undefined),
    upgradeInstance: vi.fn(async () => undefined)
  }
  tunnelsFake = {
    onStatus: vi.fn(() => () => undefined),
    statusOf: vi.fn(() => null),
    runningIds: vi.fn(() => []),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    forgetHostKey: vi.fn(async () => undefined)
  }
  httpFake = {
    onStatus: vi.fn(() => () => undefined),
    statusOf: vi.fn(() => null),
    runningIds: vi.fn(() => []),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined)
  }
  authFake = {
    probe: vi.fn(async () => null),
    login: vi.fn(async () => null),
    logout: vi.fn(async () => null),
    stateOf: vi.fn(() => null),
    forget: vi.fn(),
    beginLogout: vi.fn(),
    endLogout: vi.fn(),
    isLoggingOut: vi.fn(() => false),
    client: vi.fn(async () => null),
    sessionCookie: vi.fn(() => null),
    clientIds: vi.fn(() => [])
  }
  clearPartitionSession = vi.fn(async () => undefined)
  closeInstanceView = vi.fn()
  reloadInstanceView = vi.fn(async () => undefined)
  showInstanceTooltip = vi.fn(async () => undefined)
  hideInstanceTooltip = vi.fn()
  vaultFake = {
    status: vi.fn(() => ({ available: true, degraded: false, instanceCount: 0 })),
    getPolicy: vi.fn(() => ({ rememberPassword: false, rememberSession: false })),
    setPolicy: vi.fn(async () => undefined),
    rememberPassword: vi.fn(async () => undefined),
    rememberExternalAccessToken: vi.fn(async () => undefined),
    rememberSession: vi.fn(async () => undefined),
    forgetPassword: vi.fn(async () => undefined),
    forgetExternalAccessToken: vi.fn(async () => undefined),
    forgetSession: vi.fn(async () => undefined),
    forgetInstance: vi.fn(async () => undefined),
    clearAll: vi.fn(async () => undefined),
    hasPassword: vi.fn(() => false),
    getPassword: vi.fn(() => null),
    hasExternalAccessToken: vi.fn(() => false),
    getExternalAccessToken: vi.fn(() => null),
    hasSession: vi.fn(() => false),
    getSession: vi.fn(() => null),
    rememberedIds: vi.fn(() => []),
    policyIds: vi.fn(() => [])
  }
  auditSpy = vi.fn() as unknown as typeof auditSpy
  onSettingsChanged = vi.fn()
  settingsFake = {
    read: vi.fn(() => ({
      language: 'zh',
      theme: 'system',
      tray: false,
      autoStart: false,
      notifications: true
    })),
    update: vi.fn(async (patch: Record<string, unknown>) => ({
      language: 'zh',
      theme: 'system',
      tray: false,
      autoStart: false,
      notifications: true,
      ...patch
    })),
    filePath: vi.fn(() => '/tmp/settings.json')
  }
  openInstanceView = vi.fn()
  openExternalUrl = vi.fn(async () => undefined)
  pluginManagerFake = {
    list: vi.fn(async () => []),
    check: vi.fn(async () => ({
      name: 'p',
      current: '1.0.0',
      latest: '1.0.0',
      hasUpdate: false,
      compatible: true,
      dshPeer: null,
      dshVersion: null,
      publishedAt: null
    })),
    checkState: vi.fn(async () => ({ lastCheckedAt: null, updates: {}, checking: [] })),
    install: vi.fn(async () => ({ hasHostSide: false })),
    upgrade: vi.fn(async () => ({ hasHostSide: false })),
    remove: vi.fn(async () => ({ hasHostSide: false })),
    setEnabled: vi.fn(async (instance, name, enabled) => ({ name, enabled }))
  }
  instanceViewUrlFake = vi.fn(() => null)
  externalDshScannerFake = { scan: vi.fn(async () => []) }
  promptBrokerFake = {
    requestHostKey: vi.fn(async () => 'trust'),
    requestAskpass: vi.fn(async () => null),
    replyHostKey: vi.fn(() => true),
    replyAskpass: vi.fn(() => true),
    replyConfirm: vi.fn(() => true),
    listConfirms: vi.fn(() => []),
    cancelAll: vi.fn()
  }
  ipcDeps = {
    runtime: runtimeFake as unknown as LocalRuntimeManager,
    tunnels: tunnelsFake as unknown as SshTunnelManager,
    http: httpFake as unknown as HttpEndpointManager,
    auth: authFake as never,
    externalDshScanner: externalDshScannerFake as never,
    verifyExternalAccess: verifyExternalAccess as (url: string) => Promise<boolean>,
    listLocalSpaces: listLocalSpaces as never,
    trashLocalSpace: trashLocalSpace as never,
    localHomePath: (record: { id: string }) => join(TEST_BASE, 'homes', record.id),
    vault: vaultFake as never,
    settings: settingsFake as never,
    audit: auditSpy,
    onSettingsChanged: onSettingsChanged as never,
    clearPartitionSession: clearPartitionSession as never,
    closeInstanceView: closeInstanceView as never,
    reloadInstanceView: reloadInstanceView as never,
    showInstanceTooltip: showInstanceTooltip as never,
    hideInstanceTooltip: hideInstanceTooltip as never,
    instanceViewUrl: instanceViewUrlFake as never,
    promptBroker: promptBrokerFake as never,
    openInstanceView: openInstanceView as never,
    openExternalUrl: openExternalUrl as never,
    installer: installerFake as never,
    pluginManager: pluginManagerFake as never
  }
  registerIpc(createInstanceStore({ dir }), ipcDeps)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function invoke(channel: string, ...args: unknown[]): unknown {
  const listener = handlers.get(channel)
  if (!listener) throw new Error(`通道未注册：${channel}`)
  return listener({} as never, ...args)
}

const VALID_LOCAL = { transport: 'local', name: 'IPC 实例' }

describe('registerIpc', () => {
  it('注册 app 双探针 + 实例 CRUD + 运行时控制 + /辅助通道', () => {
    const expected = [
      'app:info',
      'app:ping',
      'app:open-homepage',
      'app:open-about',
      'instances:list',
      'instances:get',
      'instances:create',
      'instances:update',
      'instances:delete',
      'instances:reorder',
      'instances:openDirectory',
      'instances:openLogDirectory',
      'instances:start',
      'instances:stop',
      'instances:restart',
      'instances:openView',
      'instances:reloadView',
      'instances:openInBrowser',
      'instances:updateViewBounds',
      'instances:showTooltip',
      'instances:hideTooltip',
      'instances:hideView',
      'instances:disconnectView',
      'instances:probeLocalDsh',
      'instances:scanExternal',
      'instances:adoptExternal',
      'dsh-version:check',
      'dsh-version:upgrade',
      'dsh-version:list',
      'dsh-version:confirmList',
      'dsh-version:confirmReply',
      'plugin:list',
      'plugin:check',
      'plugin:checkState',
      'plugin:install',
      'plugin:upgrade',
      'plugin:remove',
      'plugin:setEnabled',
      'plugin:openExternal',
      'ssh:keyPreview',
      'ssh:hostKeyReply',
      'ssh:hostKeyForget',
      'ssh:askpassReply',
      'http:detect',
      'auth:probe',
      'auth:login',
      'auth:loginStored',
      'auth:logout',
      'vault:status',
      'vault:setPolicy',
      'vault:forget',
      'vault:clear',
      'settings:get',
      'settings:openDataDir',
      'settings:refreshEnvironment',
      'settings:update',
      'spaces:list',
      'spaces:trash'
    ]
    expect([...handlers.keys()].sort()).toEqual(expected.sort())
  })

  it('将经 schema 校验的原生提示交给主进程，并在隐藏时撤销', async () => {
    const shown = (await invoke('instances:showTooltip', { text: '实例名称', x: 72, y: 160 })) as {
      ok: boolean
      value: null
    }
    const hidden = (await invoke('instances:hideTooltip')) as { ok: boolean; value: null }

    expect(shown).toEqual({ ok: true, value: null })
    expect(hidden).toEqual({ ok: true, value: null })
    expect(showInstanceTooltip).toHaveBeenCalledWith({ text: '实例名称', x: 72, y: 160 })
    expect(hideInstanceTooltip).toHaveBeenCalledOnce()
  })

  it('拒绝超长或越界的原生提示载荷', async () => {
    const result = (await invoke('instances:showTooltip', { text: 'x'.repeat(201), x: -1, y: 160 })) as {
      ok: boolean
      code?: string
    }

    expect(result).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(showInstanceTooltip).not.toHaveBeenCalled()
  })

  it('disconnectView 只销毁指定 WebContentsView，不停止运行时或清除凭据', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:disconnectView', created.value.id)) as { ok: boolean; value: null }

    expect(result).toEqual({ ok: true, value: null })
    expect(closeInstanceView).toHaveBeenCalledWith(created.value.id)
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(tunnelsFake.stop).not.toHaveBeenCalled()
    expect(httpFake.stop).not.toHaveBeenCalled()
    expect(authFake.forget).not.toHaveBeenCalled()
    expect(vaultFake['forgetInstance']).not.toHaveBeenCalled()
    expect(vaultFake['forgetSession']).not.toHaveBeenCalled()
  })

  it('reloadView 刷新指定实例的内嵌工作区会话（重新登录后导航回工作区 URL）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:reloadView', created.value.id)) as { ok: boolean; value: null }

    expect(result).toEqual({ ok: true, value: null })
    expect(reloadInstanceView).toHaveBeenCalledWith(created.value.id)
    expect(runtimeFake.stop).not.toHaveBeenCalled()
  })

  it('restart:运行中的 hub 托管实例先停止再按注册表记录重新拉起', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = { id: created.value.id, status: 'running', runtimeSource: 'hub', at: new Date().toISOString() }

    const result = (await invoke('instances:restart', created.value.id)) as { ok: boolean; value: null }

    expect(result).toEqual({ ok: true, value: null })
    expect(runtimeFake.stop).toHaveBeenCalledWith(created.value.id)
    // 重启前刷新登录环境缓存：新装的工具重启实例即可解析到，无需重启 app
    expect(runtimeFake.refreshEnv).toHaveBeenCalledOnce()
    expect(runtimeFake.start).toHaveBeenCalledTimes(1)
    const started = runtimeFake.start.mock.calls[0]?.[0] as { id: string }
    expect(started.id).toBe(created.value.id)
  })

  it('restart:非 local 传输被拒绝且不触碰运行时', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: 'HTTP 实例',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:restart', created.value.id)) as { ok: boolean; code?: string }

    expect(result).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('restart:未运行或外部接管被拒绝', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    // 未运行:statusOf 返回 null
    currentStatus = null
    const idle = (await invoke('instances:restart', created.value.id)) as { ok: boolean; code?: string }
    expect(idle).toMatchObject({ ok: false, code: 'invalid-state' })

    // 外部接管:进程归用户所有,hub 无权重启
    currentStatus = { id: created.value.id, status: 'running', runtimeSource: 'external', at: new Date().toISOString() }
    const external = (await invoke('instances:restart', created.value.id)) as { ok: boolean; code?: string }
    expect(external).toMatchObject({ ok: false, code: 'invalid-state' })

    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('restart:实例不存在报 not-found', async () => {
    const result = (await invoke('instances:restart', '00000000-0000-4000-8000-000000000000')) as {
      ok: boolean
      code?: string
    }
    expect(result).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('check：hub 托管 local 实例，current < latest 时报告有更新且可升级', async () => {
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      dshVersion: '0.1.4'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = { id: created.value.id, status: 'stopped', runtimeSource: 'hub', at: new Date().toISOString() }

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      ok: boolean
      value: {
        current: string | null
        latest: string
        hasUpdate: boolean
        canUpgrade: boolean
        reason?: string
      }
    }

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      current: '0.1.4',
      latest: '0.1.5',
      hasUpdate: true,
      canUpgrade: true
    })
    expect(result.value.reason).toBeUndefined()
  })

  it('check：状态事件版本优先于注册表 dshVersion，已是最新时 hasUpdate=false', async () => {
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      dshVersion: '0.1.4'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = {
      id: created.value.id,
      status: 'running',
      runtimeSource: 'hub',
      version: '0.1.5',
      at: new Date().toISOString()
    }

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      ok: boolean
      value: { current: string | null; hasUpdate: boolean }
    }

    expect(result.value.current).toBe('0.1.5')
    expect(result.value.hasUpdate).toBe(false)
  })

  it('check：从未启动过（current=null）的 hub 实例视为有更新', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = null

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      ok: boolean
      value: { current: string | null; hasUpdate: boolean; canUpgrade: boolean }
    }

    expect(result.value).toMatchObject({ current: null, hasUpdate: true, canUpgrade: true })
  })

  it('check：本地实例（含 dush/duush、path 来源）可升级；仅外部接管与非本地不可升级并给出原因', async () => {
    for (const launcher of ['dush', 'duush'] as const) {
      // 隔离空间：hub 代管自己的运行时（含 path 来源在升级时接管）
      const isolated = (await invoke('instances:create', {
        ...VALID_LOCAL,
        launcher
      })) as { ok: boolean; value: { id: string } }
      if (!isolated.ok) throw new Error('创建失败')
      currentStatus = {
        id: isolated.value.id,
        status: 'running',
        runtimeSource: 'path',
        at: new Date().toISOString()
      }
      const isolatedResult = (await invoke('dsh-version:check', isolated.value.id)) as {
        value: { canUpgrade: boolean; reason?: string }
      }
      expect(isolatedResult.value).toMatchObject({ canUpgrade: true })
      expect(isolatedResult.value.reason).toBeUndefined()

      // 公共空间：升级对象是系统默认 dsh（默认装配不带 pathProbe 时跳过来源检测）
      const shared = (await invoke('instances:create', {
        ...VALID_LOCAL,
        launcher,
        useDefaultSpace: true
      })) as { ok: boolean; value: { id: string } }
      if (!shared.ok) throw new Error('创建失败')
      currentStatus = {
        id: shared.value.id,
        status: 'running',
        runtimeSource: 'path',
        at: new Date().toISOString()
      }
      const sharedResult = (await invoke('dsh-version:check', shared.value.id)) as {
        value: { canUpgrade: boolean; reason?: string }
      }
      expect(sharedResult.value).toMatchObject({ canUpgrade: true })
      expect(sharedResult.value.reason).toBeUndefined()
    }

    // 推广：默认 dsh 启动器的 path 来源同样可升级（升级时接管进 hub 隔离目录）
    const local = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!local.ok) throw new Error('创建失败')
    currentStatus = { id: local.value.id, status: 'running', runtimeSource: 'path', at: new Date().toISOString() }
    const pathResult = (await invoke('dsh-version:check', local.value.id)) as {
      value: { canUpgrade: boolean; reason?: string }
    }
    expect(pathResult.value).toMatchObject({ canUpgrade: true })
    expect(pathResult.value.reason).toBeUndefined()

    currentStatus = {
      id: local.value.id,
      status: 'running',
      runtimeSource: 'external',
      at: new Date().toISOString()
    }
    const externalResult = (await invoke('dsh-version:check', local.value.id)) as {
      value: { canUpgrade: boolean; reason?: string }
    }
    expect(externalResult.value).toMatchObject({ canUpgrade: false, reason: 'runtime-external' })
  })

  it('check：公共空间实例的 current 取 PATH 实测版本；来源无法代管时主动给出原因', async () => {
    const probe = vi.fn(
      async (): Promise<{ command: string; version: string } | null> => ({
        command: '/Users/x/.local/bin/dsh',
        version: '0.1.6'
      })
    )
    registerIpc(createInstanceStore({ dir }), {
      ...ipcDeps,
      pathProbe: { probe, probeLauncher: async () => null }
    })
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      launcher: 'dush',
      useDefaultSpace: true,
      dshVersion: '0.1.4'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    // 注册表里的 0.1.4 已过期：公共空间以系统 dsh 实测版本为准
    currentStatus = null

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      value: { current: string | null; latest: string; hasUpdate: boolean; canUpgrade: boolean; reason?: string }
    }
    expect(probe).toHaveBeenCalled()
    expect(result.value).toMatchObject({ current: '0.1.6', latest: '0.1.5', hasUpdate: false, canUpgrade: true })
    expect(installerFake.resolveGlobalPrefix).toHaveBeenCalledWith('/Users/x/.local/bin/dsh')

    // 来源检测：系统 dsh 非 npm 全局安装 → 检查时就给出不可代管原因，不等用户点升级才失败
    installerFake.resolveGlobalPrefix.mockResolvedValueOnce(null)
    const unmanaged = (await invoke('dsh-version:check', created.value.id)) as {
      value: { canUpgrade: boolean; reason?: string }
    }
    expect(unmanaged.value).toMatchObject({ canUpgrade: false, reason: 'global-unmanaged' })

    // 探不到系统 dsh：current 按未知，同样主动提示不可代管
    probe.mockResolvedValueOnce(null)
    const missing = (await invoke('dsh-version:check', created.value.id)) as {
      value: { current: string | null; hasUpdate: boolean; canUpgrade: boolean; reason?: string }
    }
    expect(missing.value).toMatchObject({
      current: null,
      hasUpdate: false,
      canUpgrade: false,
      reason: 'global-unmanaged'
    })
  })

  it('check：公共空间默认启动器未启动时按启动计划判定，hub 已装固定版本不按 PATH 改写 current', async () => {
    const probe = vi.fn(async () => ({ command: '/Users/x/.local/bin/dsh', version: '0.1.9' }))
    const listInstalled = vi.fn(async () => [
      { version: '0.1.4', dir: '/tmp/dsh-0.1.4', entry: '/tmp/e', installedAt: '2026-09-18T00:00:00.000Z' }
    ])
    registerIpc(createInstanceStore({ dir }), {
      ...ipcDeps,
      pathProbe: { probe, probeLauncher: async () => null },
      installer: { ...installerFake, listInstalled } as never
    })
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      useDefaultSpace: true,
      dshVersion: '0.1.4'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = null

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      value: { current: string | null; canUpgrade: boolean; reason?: string }
    }

    // 计划 = 固定版本已在 hub → 下次启动跑 hub 副本：current 取注册表版本，
    // 不被 PATH 实测版本改写，也不做系统 dsh 的安装来源检测。
    expect(result.value).toMatchObject({ current: '0.1.4', canUpgrade: true })
    expect(result.value.reason).toBeUndefined()
    expect(listInstalled).toHaveBeenCalled()
    expect(installerFake.resolveGlobalPrefix).not.toHaveBeenCalled()
  })

  it('probeLocalDsh：按 LAUNCHERS 逐个探测，命中项含 duush、未命中项不出现', async () => {
    registerIpc(createInstanceStore({ dir }), {
      ...ipcDeps,
      pathProbe: {
        probe: async () => ({ command: '/Users/x/.local/bin/dsh', version: '0.1.6' }),
        probeLauncher: async (launcher) =>
          launcher === 'dush'
            ? null
            : { command: `/Users/x/.local/bin/${launcher}`, version: '0.1.6' }
      }
    })

    const result = (await invoke('instances:probeLocalDsh')) as {
      value: Array<{ launcher: string; version: string }>
    }
    expect(result.value).toEqual([
      { launcher: 'dsh', version: '0.1.6' },
      { launcher: 'duush', version: '0.1.6' }
    ])
  })

  it('check：非 local 传输报 not-local', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: 'HTTP 实例',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      value: { canUpgrade: boolean; reason?: string }
    }
    expect(result.value).toMatchObject({ canUpgrade: false, reason: 'not-local' })
  })

  it('plugin:list：本机实例转发给 pluginManager', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    pluginManagerFake.list.mockResolvedValueOnce([{ name: 'p', version: '1.0.0' }])
    const result = (await invoke('plugin:list', created.value.id)) as {
      ok: boolean
      value: Array<{ name: string }>
    }
    expect(result.ok).toBe(true)
    expect(result.value[0]?.name).toBe('p')
    expect(pluginManagerFake.list).toHaveBeenCalled()
  })

  it('plugin:list：非 local 实例报 invalid-input', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: 'HTTP',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:list', created.value.id)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-input')
  })

  it('plugin:checkState：转发持久化检查状态（供挂载时恢复标记）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    pluginManagerFake.checkState.mockResolvedValueOnce({
      lastCheckedAt: '2026-09-29T10:00:00.000Z',
      updates: { p: { current: '1.0.0', latest: '2.0.0', compatible: true, dshPeer: null, dshVersion: null } },
      checking: []
    })
    const result = (await invoke('plugin:checkState', created.value.id)) as {
      ok: boolean
      value: { lastCheckedAt: string | null; updates: Record<string, unknown> }
    }
    expect(result.ok).toBe(true)
    expect(result.value.lastCheckedAt).toBe('2026-09-29T10:00:00.000Z')
    expect(Object.keys(result.value.updates)).toEqual(['p'])
  })

  it('plugin:upgrade：显式版本经校验后转发', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:upgrade', created.value.id, 'dsh-free-search', '0.4.40')) as {
      ok: boolean
    }
    expect(result.ok).toBe(true)
    expect(pluginManagerFake.upgrade).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id }),
      'dsh-free-search',
      '0.4.40'
    )
  })

  it('plugin:install：非法 spec 被拒（含 shell 元字符）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:install', created.value.id, 'foo; rm -rf /')) as {
      ok: boolean
      code?: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-input')
    expect(pluginManagerFake.install).not.toHaveBeenCalled()
  })

  it('plugin:setEnabled：校验入参后转发（布尔 + 包名）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:setEnabled', created.value.id, 'dsh-free-search', false)) as {
      ok: boolean
      value: { name: string; enabled: boolean }
    }
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ name: 'dsh-free-search', enabled: false })

    const bad = (await invoke('plugin:setEnabled', created.value.id, 'dsh-free-search', 'nope')) as {
      ok: boolean
      code?: string
    }
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('invalid-input')
  })

  it('plugin:openExternal：白名单外域名被拒，白名单内放行', async () => {
    const denied = (await invoke('plugin:openExternal', 'https://evil.example.com/x')) as {
      ok: boolean
      code?: string
    }
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('invalid-input')
    expect(openExternalUrl).not.toHaveBeenCalled()

    const allowed = (await invoke('plugin:openExternal', 'https://www.npmjs.com/package/x')) as {
      ok: boolean
    }
    expect(allowed.ok).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.npmjs.com/package/x')
  })

  it('plugin:list：pluginManager 未装配 → ok:false code=internal', async () => {
    registerIpc(createInstanceStore({ dir }), { ...ipcDeps, pluginManager: undefined })
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:list', created.value.id)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('internal')
  })

  it('check/list：installer 未装配 → ok:false code=internal', async () => {
    // 装配层缺 installer 时 check/list 必须回错误信封，不能让渲染层拿到半份结果。
    registerIpc(createInstanceStore({ dir }), { ...ipcDeps, installer: undefined })
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(result).toMatchObject({ ok: false, code: 'internal' })

    const listResult = (await invoke('dsh-version:list')) as { ok: boolean; code?: string }
    expect(listResult).toMatchObject({ ok: false, code: 'internal' })
  })

  it('dsh-version:list：按版本从新到旧返回可用版本与已装版本', async () => {
    installerFake.listAvailableVersions.mockResolvedValueOnce(['0.1.5', '0.1.7-alpha.2', '0.1.6-alpha.2'])
    installerFake.listInstalled.mockResolvedValueOnce([
      { version: '0.1.5-rc.1', dir: '/tmp/runtimes/dsh-0.1.5-rc.1', entry: '/tmp/e1', installedAt: '' },
      { version: '0.1.6-alpha.2', dir: '/tmp/runtimes/dsh-0.1.6-alpha.2', entry: '/tmp/e2', installedAt: '' }
    ])

    const result = (await invoke('dsh-version:list')) as {
      ok: boolean
      value?: { versions: string[]; installed: string[] }
    }

    expect(result).toEqual({
      ok: true,
      value: {
        versions: ['0.1.7-alpha.2', '0.1.6-alpha.2', '0.1.5'],
        installed: ['0.1.6-alpha.2', '0.1.5-rc.1']
      }
    })
  })

  it('dsh-version:list：registry 读取失败 → ok:false code=internal（透传原因）', async () => {
    installerFake.listAvailableVersions.mockRejectedValueOnce(new Error('registry 不可达'))

    const result = (await invoke('dsh-version:list')) as {
      ok: boolean
      code?: string
      message?: string
    }

    expect(result).toMatchObject({
      ok: false,
      code: 'internal',
      message: expect.stringContaining('registry 不可达')
    })
  })

  it('upgrade：可升级 → 触发 runtime.upgradeInstance 并立即返回 null', async () => {
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      dshVersion: '0.1.4'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = { id: created.value.id, status: 'stopped', runtimeSource: 'hub', at: new Date().toISOString() }

    const result = (await invoke('dsh-version:upgrade', created.value.id)) as {
      ok: boolean
      value: null
    }

    expect(result).toEqual({ ok: true, value: null })
    expect(runtimeFake.upgradeInstance).toHaveBeenCalledTimes(1)
    expect(runtimeFake.upgradeInstance).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id, transport: 'local' })
    )
  })

  it('upgrade：本地实例（默认/dush/duush 启动器 × 公共/隔离空间、path 来源）都转交升级编排', async () => {
    for (const launcher of [null, 'dush', 'duush'] as const) {
      for (const useDefaultSpace of [false, true]) {
        const created = (await invoke('instances:create', {
          ...VALID_LOCAL,
          ...(launcher === null ? {} : { launcher }),
          useDefaultSpace
        })) as { ok: boolean; value: { id: string } }
        if (!created.ok) throw new Error('创建失败')
        currentStatus = {
          id: created.value.id,
          status: 'running',
          runtimeSource: 'path',
          at: new Date().toISOString()
        }

        const result = (await invoke('dsh-version:upgrade', created.value.id)) as {
          ok: boolean
          value: null
        }

        expect(result).toEqual({ ok: true, value: null })
        expect(runtimeFake.upgradeInstance).toHaveBeenCalledWith(
          expect.objectContaining({ id: created.value.id, launcher, useDefaultSpace })
        )
      }
    }
    expect(runtimeFake.upgradeInstance).toHaveBeenCalledTimes(6)
  })

  it('dsh-version:confirmList/confirmReply：待答快照补拉与回答经 broker，入参走 zod 边界', async () => {
    const payload = { requestId: randomUUID(), kind: 'dsh-download' as const, version: '0.1.7-rc.1' }
    promptBrokerFake.listConfirms.mockReturnValue([payload])

    const list = (await invoke('dsh-version:confirmList')) as { ok: boolean; value: unknown }
    expect(list).toEqual({ ok: true, value: [payload] })

    const reply = (await invoke('dsh-version:confirmReply', payload.requestId, true)) as {
      ok: boolean
      value: null
    }
    expect(reply).toEqual({ ok: true, value: null })
    expect(promptBrokerFake.replyConfirm).toHaveBeenCalledWith(payload.requestId, true)

    // 非法 requestId / 非布尔回答都在 IPC 边界被拒，不触碰 broker。
    const badId = (await invoke('dsh-version:confirmReply', 'not-a-uuid', true)) as {
      ok: boolean
      code?: string
    }
    expect(badId).toMatchObject({ ok: false, code: 'invalid-input' })
    const badAnswer = (await invoke('dsh-version:confirmReply', randomUUID(), 'yes')) as {
      ok: boolean
      code?: string
    }
    expect(badAnswer).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(promptBrokerFake.replyConfirm).toHaveBeenCalledTimes(1)
  })

  it('upgrade：不可升级来源 → ok:false invalid-input，不触发编排', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!local.ok) throw new Error('创建失败')
    currentStatus = {
      id: local.value.id,
      status: 'running',
      runtimeSource: 'external',
      at: new Date().toISOString()
    }
    const adopted = (await invoke('dsh-version:upgrade', local.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(adopted).toMatchObject({ ok: false, code: 'invalid-input' })

    const remote = (await invoke('instances:create', {
      transport: 'http',
      name: '远程实例',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!remote.ok) throw new Error('创建失败')
    const notLocal = (await invoke('dsh-version:upgrade', remote.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(notLocal).toMatchObject({ ok: false, code: 'invalid-input' })

    expect(runtimeFake.upgradeInstance).not.toHaveBeenCalled()
  })

  it('upgrade：实例不存在报 not-found', async () => {
    const result = (await invoke('dsh-version:upgrade', '00000000-0000-4000-8000-000000000000')) as {
      ok: boolean
      code?: string
    }
    expect(result).toMatchObject({ ok: false, code: 'not-found' })
    expect(runtimeFake.upgradeInstance).not.toHaveBeenCalled()
  })

  it('ssh:hostKeyForget:入参走 zod 边界,只有 ssh 实例才转交 tunnels.forgetHostKey', async () => {
    // 非 ssh 实例没有主机指纹 → invalid-input。三种情况都不许触碰隧道管理器。
    const invalid = (await invoke('ssh:hostKeyForget', { instanceId: 'not-a-uuid' })) as {
      ok: boolean
      code?: string
    }
    expect(invalid.ok).toBe(false)
    expect(invalid.code).toBe('invalid-input')

    const missing = (await invoke('ssh:hostKeyForget', { instanceId: randomUUID() })) as {
      ok: boolean
      code?: string
    }
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe('not-found')

    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    const wrongTransport = (await invoke('ssh:hostKeyForget', {
      instanceId: local.value.id
    })) as { ok: boolean; code?: string }
    expect(wrongTransport.ok).toBe(false)
    expect(wrongTransport.code).toBe('invalid-input')
    expect(tunnelsFake.forgetHostKey).not.toHaveBeenCalled()

    // ssh 实例 → 转交显式恢复动作,成功返回 null 信封
    const ssh = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!ssh.ok) throw new Error('创建失败')
    const done = (await invoke('ssh:hostKeyForget', { instanceId: ssh.value.id })) as {
      ok: boolean
      value: null
    }
    expect(done.ok).toBe(true)
    expect(done.value).toBeNull()
    expect(tunnelsFake.forgetHostKey).toHaveBeenCalledWith(
      expect.objectContaining({ id: ssh.value.id, transport: 'ssh' })
    )
  })

  it('app:info 返回版本快照', async () => {
    const result = (await invoke('app:info')) as {
      ok: boolean
      value: { appVersion: string; buildCommit: string; buildTime: string }
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.appVersion).toBe('9.9.9')
      // 构建期常量在单测环境无 define 注入，回落 'unknown'；此处守住字段存在与类型。
      expect(typeof result.value.buildCommit).toBe('string')
      expect(typeof result.value.buildTime).toBe('string')
    }
  })

  it('app:ping 原样回显', async () => {
    const result = (await invoke('app:ping', 'hello')) as { ok: boolean; value: { echo: string | null } }
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.echo).toBe('hello')
  })

  it('app:ping 非字符串入参 → invalid-input', async () => {
    const result = (await invoke('app:ping', 123)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-input')
  })

  it('create 合法输入 → ok + 完整记录', async () => {
    const result = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string; transport: string }
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(result.value.transport).toBe('local')
    }
  })

  it('删除隔离本地实例时仅在明确请求后移入废纸篓', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const withoutTrash = (await invoke('instances:delete', created.value.id, {})) as { ok: boolean }
    expect(withoutTrash.ok).toBe(true)
    expect(trashLocalSpace).not.toHaveBeenCalled()

    const another = (await invoke('instances:create', { transport: 'local', name: '移入废纸篓' })) as {
      ok: boolean
      value: { id: string }
    }
    if (!another.ok) throw new Error('创建失败')
    const withTrash = (await invoke('instances:delete', another.value.id, { trashSpace: true })) as { ok: boolean }
    expect(withTrash.ok).toBe(true)
    expect(trashLocalSpace).toHaveBeenCalledWith(another.value.id)
  })

  it('列出空间时标注已被本地实例使用的空间', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    listLocalSpaces.mockResolvedValueOnce([
      { id: '11111111-1111-4111-8111-111111111111', sizeBytes: 4, modifiedAt: '2026-09-20T00:00:00.000Z' },
      { id: created.value.id, sizeBytes: 3, modifiedAt: '2026-09-21T00:00:00.000Z' }
    ])

    const result = (await invoke('spaces:list')) as { ok: boolean; value: Array<{ id: string; inUse: boolean }> }
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual([
      { id: created.value.id, sizeBytes: 3, modifiedAt: '2026-09-21T00:00:00.000Z', inUse: true, instanceName: 'IPC 实例' },
      { id: '11111111-1111-4111-8111-111111111111', sizeBytes: 4, modifiedAt: '2026-09-20T00:00:00.000Z', inUse: false, instanceName: null }
    ])
  })

  it('reuses only an unassigned existing local space', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    listLocalSpaces.mockResolvedValueOnce([{ id, sizeBytes: 4, modifiedAt: '2026-09-20T00:00:00.000Z' }])
    const created = (await invoke('instances:create', { transport: 'local', name: '复用空间', existingSpaceId: id })) as {
      ok: boolean
      value: { id: string }
    }
    expect(created.ok).toBe(true)
    if (created.ok) expect(created.value.id).toBe(id)
  })
  it('删除实例一并清理认证客户端与分区会话', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('instances:delete', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(authFake.forget).toHaveBeenCalledWith(created.value.id)
    expect(clearPartitionSession).toHaveBeenCalledWith(created.value.id)
  })

  it('logout 后清理实例分区会话 Cookie(否则 webview 仍带旧会话)', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const result = (await invoke('auth:logout', id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(authFake.logout).toHaveBeenCalledWith(id)
    expect(clearPartitionSession).toHaveBeenCalledWith(id)
    expect(auditSpy).toHaveBeenCalledWith({
      instanceId: id,
      event: 'session-revoked',
      result: 'logout'
    })
    expect(auditSpy).toHaveBeenCalledWith({
      instanceId: id,
      event: 'cookie-cleared',
      result: 'logout'
    })
  })

  it('logout 全程覆盖登出窗口:begin 先于登出,end 在 vault 会话清理之后', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const order: string[] = []
    authFake.beginLogout.mockImplementation(() => {
      order.push('begin')
    })
    authFake.logout.mockImplementation(async () => {
      order.push('logout')
      return null
    })
    authFake.endLogout.mockImplementation(() => {
      order.push('end')
    })
    vaultFake.forgetSession = vi.fn(async () => {
      order.push('forgetSession')
    })

    const result = (await invoke('auth:logout', id)) as { ok: boolean }

    expect(result.ok).toBe(true)
    // 并发探测只可能落在 begin → end 之间：恢复/静默登录/回写在整段窗口内被压住。
    expect(order).toEqual(['begin', 'logout', 'forgetSession', 'end'])
  })

  it('logout 清理失败：登出仍回成功信封，清理降级为留痕，后续步骤必达', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      clearPartitionSession.mockRejectedValueOnce(new Error('partition 不可用'))
      const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
      const result = (await invoke('auth:logout', id)) as { ok: boolean }
      // 登出成功 → 成功信封（渲染层只在 ok 时提示「已登出」，报错信封会让用户失去反馈）。
      expect(result).toMatchObject({ ok: true })
      expect(authFake.logout).toHaveBeenCalledWith(id)
      // 失败点之后的步骤必达：vault 会话被遗忘、两条安全审计都记录。
      expect(vaultFake.forgetSession).toHaveBeenCalledWith(id)
      expect(auditSpy).toHaveBeenCalledWith({
        instanceId: id,
        event: 'session-revoked',
        result: 'logout'
      })
      // cookie 清理失败如实标记，而不是让这条审计消失。
      expect(auditSpy).toHaveBeenCalledWith({
        instanceId: id,
        event: 'cookie-cleared',
        result: 'failed'
      })
      // 留痕（二）：console 记录失败原因，主进程日志可查。
      expect(errSpy).toHaveBeenCalledWith(
        '[ipc] 登出时清理分区会话失败：',
        id,
        expect.any(Error)
      )
    } finally {
      errSpy.mockRestore()
    }
  })

  it('auth:loginStored requires an enabled password policy', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: false, rememberSession: true })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    const result = (await invoke('auth:loginStored', id, null)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-input')
    expect(authFake.login).not.toHaveBeenCalled()
  })

  it('auth:loginStored rejects an unavailable stored password', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue(null)
    const result = (await invoke('auth:loginStored', id, null)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-input')
    expect(authFake.login).not.toHaveBeenCalled()
  })

  it('auth:loginStored reads the stored password in the main process', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    authFake.login.mockResolvedValueOnce({ phase: 'connected', lockedForMs: 0 })
    const result = (await invoke('auth:loginStored', id, '654321')) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(authFake.login).toHaveBeenCalledWith(id, 'stored-secret', '654321')
  })

  it('auth:loginStored validates OTP length before logging in', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    const result = (await invoke('auth:loginStored', id, '12')) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-input')
    expect(authFake.login).not.toHaveBeenCalled()
  })

  // 真实状态机下 probe 终态是 await-credentials(probe-gateway → session-absent),
  // 只认 needs-auth 会让静默登录生产不可达。
  it('probe attempts stored-password login once from await-credentials', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    authFake.stateOf.mockReturnValue({ phase: 'await-credentials', lockedForMs: 0 })
    authFake.login.mockResolvedValue({ phase: 'connected', lockedForMs: 0 })
    const first = (await invoke('auth:probe', id)) as { ok: boolean; value?: { phase: string } }
    expect(first.ok).toBe(true)
    expect(first.value?.phase).toBe('connected')
    expect(authFake.login).toHaveBeenCalledTimes(1)
    expect(authFake.login).toHaveBeenCalledWith(id, 'stored-secret', undefined)
    // 第二次探测:已尝试过,不再自动登录(401/429 一律交还用户)
    await invoke('auth:probe', id)
    expect(authFake.login).toHaveBeenCalledTimes(1)
  })

  it('remote session expiry from connected resets the stored-password attempt', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    const connected = { phase: 'connected', lockedForMs: 0 }
    const awaiting = { phase: 'await-credentials', lockedForMs: 0 }
    authFake.stateOf
      .mockReturnValueOnce(connected)
      .mockReturnValueOnce(awaiting)
      .mockReturnValueOnce(connected)
      .mockReturnValueOnce(awaiting)
    authFake.login.mockResolvedValue({ phase: 'connected', lockedForMs: 0 })

    await invoke('auth:probe', id)
    await invoke('auth:probe', id)

    expect(authFake.login).toHaveBeenCalledTimes(2)
    expect(authFake.login).toHaveBeenNthCalledWith(1, id, 'stored-secret', undefined)
    expect(authFake.login).toHaveBeenNthCalledWith(2, id, 'stored-secret', undefined)
  })

  it('probe only attempts silent login from eligible phases', async () => {
    // 每个相用独立实例:静默尝试「每实例一次」的记账不该掩盖相本身的判定
    const uid = ((): (() => string) => {
      let n = 0
      return () => `f47ac10b-58cc-4372-a567-${String(++n).padStart(12, '0')}`
    })()
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    authFake.login.mockResolvedValue({ phase: 'connected', lockedForMs: 0 })
    // needs-auth(首探瞬间相):防御性触发
    authFake.stateOf.mockReturnValue({ phase: 'needs-auth', lockedForMs: 0 })
    await invoke('auth:probe', uid())
    expect(authFake.login).toHaveBeenCalledTimes(1)
    // await-otp:已到验证码阶段,密码复用走 AuthPanel 的 loginStored,不再自动重发
    authFake.stateOf.mockReturnValue({ phase: 'await-otp', lockedForMs: 0 })
    await invoke('auth:probe', uid())
    expect(authFake.login).toHaveBeenCalledTimes(1)
    // connected / error / null:无认证需求
    for (const phase of ['connected', 'error']) {
      authFake.stateOf.mockReturnValue({ phase, lockedForMs: 0 })
      await invoke('auth:probe', uid())
    }
    authFake.stateOf.mockReturnValue(null)
    await invoke('auth:probe', uid())
    expect(authFake.login).toHaveBeenCalledTimes(1)
    // 锁定中(429 之后):不自动重试
    authFake.stateOf.mockReturnValue({ phase: 'await-credentials', lockedForMs: 30_000 })
    await invoke('auth:probe', uid())
    expect(authFake.login).toHaveBeenCalledTimes(1)
  })

  it('successful manual login re-enables silent login after logout', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    authFake.stateOf.mockReturnValue({ phase: 'await-credentials', lockedForMs: 0 })
    authFake.login.mockResolvedValue({ phase: 'connected', lockedForMs: 0 })
    // 登出 → 探测:不得立即用已存密码复活会话
    await invoke('auth:logout', id)
    await invoke('auth:probe', id)
    expect(authFake.login).not.toHaveBeenCalled()
    // 手动登录成功 → 解除压制;此后会话再次失效时允许静默登录
    await invoke('auth:login', id, 'manual-pw')
    await invoke('auth:probe', id)
    expect(authFake.login).toHaveBeenCalledTimes(2) // 1 次手动 + 1 次静默
    expect(authFake.login).toHaveBeenLastCalledWith(id, 'stored-secret', undefined)
  })

  it('silent login errors do not change the probe result', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    const awaiting = { phase: 'await-credentials', lockedForMs: 0 }
    authFake.stateOf.mockReturnValue(awaiting)
    authFake.login.mockRejectedValueOnce(new Error('network down'))
    const result = (await invoke('auth:probe', id)) as { ok: boolean; value?: unknown }
    expect(result.ok).toBe(true)
    expect(result.value).toEqual(awaiting)
    expect(authFake.login).toHaveBeenCalledTimes(1)
    // 抛错同样记账:会话内不再重试
    await invoke('auth:probe', id)
    expect(authFake.login).toHaveBeenCalledTimes(1)
  })

  it('集成 —— 真实 auth-registry + 真实状态机(不 mock stateOf)打通静默登录', async () => {
    // 静默登录必须在该前提下真实可达 —— mock stateOf 成 needs-auth 掩盖过这个前提。
    const { createAuthRegistry } = await import('../auth/auth-registry')
    const gwUrl = 'https://gw.example.com/dsh'
    const realRegistry = createAuthRegistry({
      resolveEndpoint: async () => gwUrl,
      fetchImpl: (async (input: string | URL) => {
        const url = String(input)
        if (url.includes('/login/auth')) {
          // 登录成功:200 + Set-Cookie(网关协议要求会话 Cookie,缺失 = 协议异常)
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie': 'dsh_auth=ticket; Path=/; HttpOnly'
            }
          })
        }
        // 探测:302 → /login = 网关登录页
        return new Response('', {
          status: 302,
          headers: { 'content-type': 'text/html', location: '/dsh/login' }
        })
      }) as unknown as typeof fetch
    })
    // 用真实注册表的三个方法替换 fake(probe/login/stateOf 是静默登录链路全部);
    // 其余方法(forget/client/sessionCookie/clientIds)继续用 fake,避免牵连别的用例
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const saved = { ...authFake }
    authFake.probe = realRegistry.probe.bind(realRegistry) as never
    authFake.login = realRegistry.login.bind(realRegistry) as never
    authFake.stateOf = realRegistry.stateOf.bind(realRegistry) as never
    try {
      vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
      vaultFake.getPassword?.mockReturnValue('stored-secret')
      const result = (await invoke('auth:probe', id)) as {
        ok: boolean
        value?: { phase: string }
      }
      expect(result.ok).toBe(true)
      expect(result.value?.phase).toBe('connected')
      // 会话 Cookie 已入罐(静默登录真实生效,不是状态对象凑出来的)
      expect(realRegistry.sessionCookie(id)?.name).toBe('dsh_auth')
    } finally {
      Object.assign(authFake, saved)
    }
  })

  it('openView:SSH 未连接时主动建立隧道，准备完成后开窗', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '按需连接的隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    tunnelsFake.start.mockImplementation(async (instance) => {
      tunnelsFake.statusOf.mockReturnValue({
        id: instance.id,
        status: 'running',
        url: 'http://127.0.0.1:39001/',
        at: '2026-09-16T00:00:00.000Z'
      })
    })

    const opened = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(tunnelsFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: created.value.id }))
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id, transport: 'ssh' }),
      'http://127.0.0.1:39001/'
    )
  })

  it('SSH 连接失败时向调用方返回可见错误', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '失败的隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    tunnelsFake.start.mockRejectedValueOnce(new Error('SSH 认证失败'))

    const opened = (await invoke('instances:openView', created.value.id)) as {
      ok: boolean
      code?: string
      message?: string
    }
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.code).toBe('internal')
      expect(opened.message).toContain('内部错误')
    }
    expect(openInstanceView).not.toHaveBeenCalled()
  })

  it('未提供接管 token 时不会把外部 dsh 当作可直接访问的工作区', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValueOnce([
      { pid: 84758, port: 3080, patch: '/x.yml', command: 'node /x/dsh web --patch /x.yml' }
    ])

    const opened = (await invoke('instances:openView', local.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(runtimeFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: local.value.id }))
    expect(openInstanceView).not.toHaveBeenCalled()
  })

  it('本机未运行时会启动实例自身的 dsh', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    runtimeFake.start.mockImplementation(async (instance) => {
      const url = 'http://127.0.0.1:39002/'
      runtimeFake.statusOf.mockReturnValue({
        id: instance.id,
        status: 'running',
        at: '2026-09-16T00:00:00.000Z'
      })
      runtimeFake.urlOf.mockReturnValue(url)
    })

    const opened = (await invoke('instances:openView', local.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(runtimeFake.adopt).not.toHaveBeenCalled()
    expect(runtimeFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: local.value.id }))
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: local.value.id }),
      'http://127.0.0.1:39002/'
    )
  })


  it('同一实例的并发打开请求只导航一次', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    let release!: () => void
    const starting = new Promise<void>((resolve) => {
      release = resolve
    })
    runtimeFake.start.mockImplementation(async (instance) => {
      await starting
      const url = 'http://127.0.0.1:39003/'
      runtimeFake.statusOf.mockReturnValue({
        id: instance.id,
        status: 'running',
        at: '2026-09-16T00:00:00.000Z'
      })
      runtimeFake.urlOf.mockReturnValue(url)
    })

    const first = invoke('instances:openView', local.value.id) as Promise<{ ok: boolean }>
    await vi.waitFor(() => expect(runtimeFake.start).toHaveBeenCalledTimes(1))
    const second = invoke('instances:openView', local.value.id) as Promise<{ ok: boolean }>
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true, value: null }, { ok: true, value: null }])
    expect(openInstanceView).toHaveBeenCalledTimes(1)
  })

  it('http 实例未「启动」也能打开视图(启动的意义就是开窗,不该做两遍)', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '免启动远程',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    // http 管理器尚未启动 → statusOf 为 null(正是用户遇到的「必须先点启动」)
    httpFake.statusOf.mockReturnValue(null)
    const opened = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    // 用实例自身端点开窗(httpDirectEndpoint 的归一化结果)
    expect(httpFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: created.value.id }))
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id, transport: 'http' }),
      expect.stringContaining('gw.example.com')
    )
  })

  it('已停在同一 URL 的远程工作区不再等待认证探测', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '已打开的远程',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    const endpoint = 'https://gw.example.com/dsh/'
    httpFake.statusOf.mockReturnValue({
      id: created.value.id,
      status: 'running',
      url: endpoint,
      at: '2026-09-15T00:00:00.000Z'
    })
    // 缓存视图已停在同一 URL → 本次打开不会导航，探测不该阻塞显示。
    instanceViewUrlFake.mockReturnValue(endpoint)
    let probeSettled = false
    authFake.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            probeSettled = true
            resolve(null)
          }, 50)
        })
    )

    const opened = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(probeSettled).toBe(false)
    expect(openInstanceView).toHaveBeenCalledWith(expect.objectContaining({ id: created.value.id }), endpoint)
  })

  it('缓存视图停在别的 URL 时仍先完成认证探测再开窗', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '换址的远程',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    const endpoint = 'https://gw.example.com/dsh/'
    httpFake.statusOf.mockReturnValue({
      id: created.value.id,
      status: 'running',
      url: endpoint,
      at: '2026-09-15T00:00:00.000Z'
    })
    instanceViewUrlFake.mockReturnValue('https://gw.example.com/dsh/other')
    const order: string[] = []
    authFake.probe.mockImplementation(async () => {
      order.push('probe')
      return null
    })
    openInstanceView.mockImplementation(async () => {
      order.push('openInstanceView')
    })

    const opened = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(order).toEqual(['probe', 'openInstanceView'])
  })

  it('未连接的 SSH 和本机实例会在打开工作区时开始准备', async () => {
    const ssh = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道实例',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!ssh.ok) throw new Error('创建失败')
    tunnelsFake.statusOf.mockReturnValue(null)
    const pendingSsh = (await invoke('instances:openView', ssh.value.id)) as { ok: boolean }
    expect(pendingSsh.ok).toBe(true)
    expect(tunnelsFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: ssh.value.id }))

    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValueOnce([])
    runtimeFake.statusOf.mockReturnValue(null)
    const pendingLocal = (await invoke('instances:openView', local.value.id)) as { ok: boolean }
    expect(pendingLocal.ok).toBe(true)
    expect(runtimeFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: local.value.id }))
  })

  it('重启后的本机实例从保险库读取 token，验证后自动打开已接管的端口', async () => {
    const local = (await invoke('instances:create', { ...VALID_LOCAL, port: 3080 })) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([{ pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }])
    vaultFake['getExternalAccessToken']!.mockReturnValue('saved-token')

    const opened = (await invoke('instances:openView', local.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(verifyExternalAccess).toHaveBeenCalledWith('http://127.0.0.1:3080/?token=saved-token')
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: local.value.id }),
      'http://127.0.0.1:3080/?token=saved-token'
    )
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('保存的外部 token 无效时清除它并要求重新输入', async () => {
    const local = (await invoke('instances:create', { ...VALID_LOCAL, port: 3080 })) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([{ pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }])
    vaultFake['getExternalAccessToken']!.mockReturnValue('expired-token')
    verifyExternalAccess.mockResolvedValueOnce(false)

    const opened = (await invoke('instances:openView', local.value.id)) as { ok: boolean; code?: string; message?: string }
    expect(opened.ok).toBe(false)
    expect(opened.code).toBe('invalid-state')
    expect(opened.message).toContain('实例详情中更新')
    expect(vaultFake['forgetExternalAccessToken']).toHaveBeenCalledWith(local.value.id)
    expect(openInstanceView).not.toHaveBeenCalled()
  })

  it('接管的外部 dsh 重启后断开旧接管，并提示在详情页更新访问 token', async () => {
    const local = (await invoke('instances:create', { ...VALID_LOCAL, port: 3080 })) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    vaultFake['getExternalAccessToken']!.mockReturnValue('old-token')
    externalDshScannerFake.scan.mockResolvedValueOnce([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    await expect(invoke('instances:openView', local.value.id)).resolves.toEqual({ ok: true, value: null })

    externalDshScannerFake.scan.mockResolvedValueOnce([
      { pid: 84759, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    const reopened = (await invoke('instances:openView', local.value.id)) as {
      ok: boolean
      code?: string
      message?: string
    }

    expect(reopened).toEqual({
      ok: false,
      code: 'invalid-state',
      message: '本机 dsh 已重启，请在实例详情中更新访问 token'
    })
    expect(runtimeFake.stop).toHaveBeenCalledWith(local.value.id)

    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84759, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    currentStatus = { id: local.value.id, status: 'running', runtimeSource: 'external', at: '2026-09-17T00:00:00.000Z' }
    await expect(invoke('instances:adoptExternal', local.value.id, 84759, 'new-token')).resolves.toEqual({
      ok: true,
      value: null
    })
    expect(vaultFake['rememberExternalAccessToken']).toHaveBeenCalledWith(local.value.id, 'new-token')
  })

  it('外部接管创建在 token 持久化失败时回滚实例记录', async () => {
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 52300, patch: null, command: 'node /x/dsh web' }
    ])
    vaultFake['rememberExternalAccessToken']!.mockRejectedValueOnce(new Error('keychain unavailable'))

    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      useExistingExternal: true,
      externalPid: 84758,
      externalAccess: 'access-token'
    })) as { ok: boolean }

    expect(created.ok).toBe(false)
    expect((await invoke('instances:list'))).toMatchObject({ ok: true, value: [] })
    expect(vaultFake['forgetExternalAccessToken']).toHaveBeenCalledOnce()
    expect(runtimeFake.stop).toHaveBeenCalledOnce()
  })

  it('本机已有 dsh web 时创建实例会绑定其端口，而非额外启动新进程', async () => {
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 52300, patch: '/x.yml', command: 'node /x/dsh web --patch /x.yml' }
    ])
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      useExistingExternal: true,
      externalPid: 84758,
      externalAccess: 'access-token'
    })) as {
      ok: boolean
      value: { id: string; port: number | null }
    }
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.port).toBe(52300)

    const opened = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id }),
      'http://127.0.0.1:52300/?token=access-token'
    )
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('scanExternal:无参数、只读投影、缺省装配返回空列表', async () => {
    externalDshScannerFake.scan.mockResolvedValueOnce([
      {
        pid: 84758,
        port: 3080,
        patch: '/Users/x/.dush/cordis.dush.patch.yml',
        command: 'node /Users/x/.local/bin/dsh web --patch /x.yml --no-open',
        // 探测器内部字段不应外泄(只投影 pid/port/patch/command)
        internalNote: 'should-not-leak'
      }
    ])
    const result = (await invoke('instances:scanExternal')) as {
      ok: boolean
      value: Array<Record<string, unknown>>
    }
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(Object.keys(result.value[0] ?? {}).sort()).toEqual(
      ['command', 'patch', 'pid', 'port'].sort()
    )
  })

  it('adoptExternal:端口/patch 由主进程重新扫描认定,渲染层只传 pid', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: '/x.yml', command: 'node /x/dsh web --patch /x.yml' }
    ])
    const adopted = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'http://127.0.0.1:3080/?token=token-value'
    )) as {
      ok: boolean
    }
    expect(adopted.ok).toBe(true)
    expect(runtimeFake.adopt).toHaveBeenCalledWith(
      expect.objectContaining({ id: local.value.id }),
      { pid: 84758, port: 3080, patch: '/x.yml' }
    )
    expect(auditSpy).toHaveBeenCalledWith({
      instanceId: local.value.id,
      event: 'connect',
      result: 'adopt-external'
    })
  })

  it('接管时可复用已保存的外部 token，渲染层无需再次提交凭据', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([{ pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }])
    vaultFake['getExternalAccessToken']!.mockReturnValue('saved-token')

    const adopted = (await invoke('instances:adoptExternal', local.value.id, 84758, '')) as { ok: boolean }
    expect(adopted.ok).toBe(true)
    expect(verifyExternalAccess).toHaveBeenCalledWith('http://127.0.0.1:3080/?token=saved-token')
    expect(vaultFake['rememberExternalAccessToken']).not.toHaveBeenCalled()
  })

  it('外部接管的 token 持久化失败时不改变现有运行时', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([{ pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }])
    vaultFake['rememberExternalAccessToken']!.mockRejectedValueOnce(new Error('keychain unavailable'))

    const adopted = (await invoke('instances:adoptExternal', local.value.id, 84758, 'new-token')) as { ok: boolean }

    expect(adopted.ok).toBe(false)
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(runtimeFake.adopt).not.toHaveBeenCalled()
  })

  it('外部 dsh 接管验证 token 后保存，失效 token 会被清除并要求重新输入', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([{ pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }])

    const saved = (await invoke('instances:adoptExternal', local.value.id, 84758, 'valid-token')) as { ok: boolean }
    expect(saved.ok).toBe(true)
    expect(verifyExternalAccess).toHaveBeenCalledWith('http://127.0.0.1:3080/?token=valid-token')
    expect(vaultFake['rememberExternalAccessToken']).toHaveBeenCalledWith(local.value.id, 'valid-token')

    currentStatus = null
    verifyExternalAccess.mockResolvedValueOnce(false)
    const rejected = (await invoke('instances:adoptExternal', local.value.id, 84758, 'invalid-token')) as {
      ok: boolean
      code?: string
    }
    expect(rejected.ok).toBe(false)
    expect(rejected.code).toBe('invalid-state')
    expect(vaultFake['forgetExternalAccessToken']).not.toHaveBeenCalled()
  })


  it('接管外部 dsh 的 token 只用于匹配 PID 的回环 URL，拒绝远程或错误端口', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])

    const remote = (await invoke('instances:adoptExternal', local.value.id, 84758, 'https://example.com/?token=x')) as {
      ok: boolean
      code?: string
    }
    expect(remote.ok).toBe(false)
    expect(remote.code).toBe('invalid-input')

    const localhost = (await invoke('instances:adoptExternal', local.value.id, 84758, 'http://localhost:3080/?token=x')) as {
      ok: boolean
      code?: string
    }
    expect(localhost.ok).toBe(false)
    expect(localhost.code).toBe('invalid-input')

    const wrongPort = (await invoke('instances:adoptExternal', local.value.id, 84758, 'http://127.0.0.1:3081/?token=x')) as {
      ok: boolean
      code?: string
    }
    expect(wrongPort.ok).toBe(false)
    expect(wrongPort.code).toBe('invalid-input')

    const nullByte = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'http://127.0.0.1:3080/?token=%00'
    )) as { ok: boolean; code?: string }
    expect(nullByte.ok).toBe(false)
    expect(nullByte.code).toBe('invalid-input')

    const newline = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'http://127.0.0.1:3080/?token=%0A'
    )) as { ok: boolean; code?: string }
    expect(newline.ok).toBe(false)
    expect(newline.code).toBe('invalid-input')
  })


  it('不允许运行中的实例覆盖已接管外部 dsh 的访问会话', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!local.ok) throw new Error('创建失败')
    currentStatus = { id: local.value.id, status: 'running', at: '2026-09-17T00:00:00.000Z' }
    runtimeFake.runningIds.mockReturnValue([local.value.id])
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    const adopted = (await invoke('instances:adoptExternal', local.value.id, 84758, 'token')) as {
      ok: boolean
      code?: string
    }
    expect(adopted.ok).toBe(false)
    expect(adopted.code).toBe('invalid-state')
    expect(runtimeFake.adopt).not.toHaveBeenCalled()
  })

  it('已接管的外部 dsh 可用新 token 重新接管，但 hub 启动的实例仍被拒绝', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!local.ok) throw new Error('创建失败')
    currentStatus = {
      id: local.value.id,
      status: 'running',
      runtimeSource: 'external',
      at: '2026-09-17T00:00:00.000Z'
    }
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    runtimeFake.runningIds.mockReturnValue([local.value.id])

    await expect(invoke('instances:adoptExternal', local.value.id, 84758, 'rotated-token')).resolves.toEqual({
      ok: true,
      value: null
    })
    expect(runtimeFake.stop).toHaveBeenCalledWith(local.value.id)
    expect(runtimeFake.adopt).toHaveBeenCalledWith(expect.objectContaining({ id: local.value.id }), {
      pid: 84758,
      port: 3080,
      patch: null
    })
  })

  it('意外退出留下 error 状态时，仍可用新 token 接管重启的外部 dsh', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!local.ok) throw new Error('创建失败')
    currentStatus = { id: local.value.id, status: 'error', at: '2026-09-17T00:00:00.000Z' }
    runtimeFake.runningIds.mockReturnValue([])
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84759, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])

    await expect(invoke('instances:adoptExternal', local.value.id, 84759, 'new-token')).resolves.toEqual({
      ok: true,
      value: null
    })
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(runtimeFake.adopt).toHaveBeenCalledWith(expect.objectContaining({ id: local.value.id }), {
      pid: 84759,
      port: 3080,
      patch: null
    })
  })

  it('adoptExternal 边界:pid 不存在 / 端口未知 / 非本地实例 / 非法 pid 都被拒', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')

    // pid 不在扫描结果里 → not-found
    externalDshScannerFake.scan.mockResolvedValue([])
    const missing = (await invoke('instances:adoptExternal', local.value.id, 999, 'token')) as {
      ok: boolean
      code?: string
    }
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('not-found')

    // 端口未知 → invalid-state(接管也无法开窗)
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 5, port: null, patch: null, command: 'node /x/dsh web' }
    ])
    const noPort = (await invoke('instances:adoptExternal', local.value.id, 5, 'token')) as {
      ok: boolean
      code?: string
    }
    expect(noPort.ok).toBe(false)
    if (!noPort.ok) expect(noPort.code).toBe('invalid-state')

    // 非本地实例 → invalid-input(http/ssh 不能「本机接管」)
    const httpInstance = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!httpInstance.ok) throw new Error('创建失败')
    const wrongTransport = (await invoke('instances:adoptExternal', httpInstance.value.id, 5, 'token')) as {
      ok: boolean
      code?: string
    }
    expect(wrongTransport.ok).toBe(false)
    if (!wrongTransport.ok) expect(wrongTransport.code).toBe('invalid-input')

    // 非法 pid(负数/非整数)→ invalid-input;不触碰 runtime.adopt
    runtimeFake.adopt.mockClear()
    const badPid = (await invoke('instances:adoptExternal', local.value.id, -1, 'token')) as {
      ok: boolean
      code?: string
    }
    expect(badPid.ok).toBe(false)
    if (!badPid.ok) expect(badPid.code).toBe('invalid-input')
    expect(runtimeFake.adopt).not.toHaveBeenCalled()
  })



  it('/http:detect 非法 URL → invalid-input(而非 internal)', async () => {
    for (const bad of ['ftp://x', 'http://user:pw@h/', 'not a url', '']) {
      const result = (await invoke('http:detect', bad)) as { ok: boolean; code?: string }
      expect(result.ok, `URL=${JSON.stringify(bad)} 应被拒绝`).toBe(false)
      if (!result.ok) {
        expect(result.code, `URL=${JSON.stringify(bad)} 的错误码`).toBe('invalid-input')
      }
    }
  })

  it('http:detect 合法 URL 调通(本地 200 服务 → none)', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>ok</html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const result = (await invoke('http:detect', `http://127.0.0.1:${port}`)) as {
        ok: boolean
        value?: { mode: string }
      }
      expect(result.ok).toBe(true)
      expect(result.value?.mode).toBe('none')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('host 以 - 开头被拒(argv 选项注入面)', async () => {
    for (const host of ['-p2222', '-lroot', '-Fevil', '-oProxyCommand=evil']) {
      const result = (await invoke('instances:create', {
        transport: 'ssh',
        name: '注入尝试',
        host,
        username: 'dev'
      })) as { ok: boolean; code?: string; message?: string }
      expect(result.ok, `host=${host} 应被拒绝`).toBe(false)
      if (!result.ok) expect(result.code).toBe('invalid-input')
    }
    // 合法别名/主机仍可用
    const okHost = (await invoke('instances:create', {
      transport: 'ssh',
      name: '别名',
      host: 'build-01',
      username: 'dev'
    })) as { ok: boolean }
    expect(okHost.ok).toBe(true)
  })

  it('create 非法输入 → 错误信封 invalid-input,不抛异常', async () => {
    const result = (await invoke('instances:create', {
      transport: 'local',
      name: 'x',
      unknownField: 1
    })) as { ok: boolean; code: string; message: string }
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('invalid-input')
      expect(result.message).toContain('unknownField')
    }
  })

  it('list 返回摘要形态(不含 notes 等详情)', async () => {
    await invoke('instances:create', { ...VALID_LOCAL, notes: '秘密备注' })
    const result = (await invoke('instances:list')) as {
      ok: boolean
      value: Array<Record<string, unknown>>
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      const summary = result.value[0]
      expect(summary).toBeDefined()
      expect(summary).not.toHaveProperty('notes')
      expect(summary).toHaveProperty('transport')
      expect(summary).toHaveProperty('authMode')
      // 数据目录由主进程按平台分隔符拼好，渲染层不再自行拼接
      expect(summary).toHaveProperty(
        'localHome',
        join(TEST_BASE, 'homes', (summary as { id: string }).id)
      )
    }
  })

  it('list：本机实例停止后版本回落到注册表 dshVersion，不退回空', async () => {
    const created = (await invoke('instances:create', { ...VALID_LOCAL, dshVersion: '0.1.7-rc.2' })) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    // 运行时未运行 → statusOf 返回 null（无实时版本），摘要应回落到注册表固定的版本。
    currentStatus = null

    const result = (await invoke('instances:list')) as {
      ok: boolean
      value: Array<{ id: string; version?: string }>
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      const summary = result.value.find((item) => item.id === created.value.id)
      expect(summary?.version).toBe('0.1.7-rc.2')
    }
  })

  it('list：运行中的实时版本优先于注册表 dshVersion', async () => {
    const created = (await invoke('instances:create', { ...VALID_LOCAL, dshVersion: '0.1.4' })) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = {
      id: created.value.id,
      status: 'running',
      version: '0.1.7-rc.2',
      at: '2026-09-28T00:00:00.000Z'
    }

    const result = (await invoke('instances:list')) as {
      ok: boolean
      value: Array<{ id: string; version?: string }>
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      const summary = result.value.find((item) => item.id === created.value.id)
      expect(summary?.version).toBe('0.1.7-rc.2')
    }
  })

  it('get 非法 id → invalid-input;不存在 → ok null', async () => {
    const bad = (await invoke('instances:get', 'not-a-uuid')) as { ok: boolean; code: string }
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('invalid-input')

    const missing = (await invoke('instances:get', randomUUID())) as { ok: boolean; value: unknown }
    expect(missing.ok).toBe(true)
    if (missing.ok) expect(missing.value).toBeNull()
  })

  it('update 非法补丁 → invalid-input;不存在 → not-found', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const badPatch = (await invoke('instances:update', created.value.id, {
      port: 'x'
    })) as { ok: boolean; code: string }
    expect(badPatch.ok).toBe(false)
    expect(badPatch.code).toBe('invalid-input')

    const missingId = (await invoke('instances:update', randomUUID(), {
      name: 'x'
    })) as { ok: boolean; code: string }
    expect(missingId.ok).toBe(false)
    expect(missingId.code).toBe('not-found')
  })

  it('delete 返回 removed 标志', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const removed = (await invoke('instances:delete', created.value.id)) as {
      ok: boolean
      value: { removed: boolean }
    }
    expect(removed.ok).toBe(true)
    if (removed.ok) expect(removed.value.removed).toBe(true)

    const again = (await invoke('instances:delete', created.value.id)) as {
      ok: boolean
      value: { removed: boolean }
    }
    if (again.ok) expect(again.value.removed).toBe(false)
  })

  it('delete:local 实例 → 先 runtime.stop 再移除记录(运行中不留孤儿进程)', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:delete', created.value.id)) as {
      ok: boolean
      value: { removed: boolean }
    }
    expect(runtimeFake.stop).toHaveBeenCalledWith(created.value.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.removed).toBe(true)
  })

  it('delete:非 local 实例不触碰运行时', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:delete', created.value.id)) as { ok: boolean }
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('delete:保险库清理失败不阻断实例记录移除(留痕而非报错)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
      if (!created.ok) throw new Error('创建失败')
      // 模拟 Windows 上 vault 落盘偶发失败：删除仍必须成功移除记录。
      vaultFake['forgetInstance'] = vi.fn(async () => {
        throw new Error('vault 落盘失败')
      })

      const result = (await invoke('instances:delete', created.value.id)) as {
        ok: boolean
        value: { removed: boolean }
      }
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.removed).toBe(true)
      expect(errSpy).toHaveBeenCalledWith(
        '[ipc] 删除时清理保险库条目失败：',
        created.value.id,
        expect.any(Error)
      )
    } finally {
      errSpy.mockRestore()
    }
  })

  it('start:local 实例 → 交给 runtime.start 并立即返回(不阻塞安装/启动)', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(runtimeFake.start).toHaveBeenCalledTimes(1)
    const record = runtimeFake.start.mock.calls[0]?.[0]
    expect(record).toMatchObject({ id: created.value.id, transport: 'local' })
  })

  it('start:http 实例 → 交给 http 管理器(起 HTTP 可启动),不误触 local/ssh', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(httpFake.start).toHaveBeenCalledTimes(1)
    expect(runtimeFake.start).not.toHaveBeenCalled()
    expect(tunnelsFake.start).not.toHaveBeenCalled()
  })

  it('start:不存在的 id → not-found', async () => {
    const result = (await invoke('instances:start', randomUUID())) as { ok: boolean; code: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('not-found')
  })

  it('start:ssh 实例 → 交给 tunnels.start 并立即返回(不碰 local 运行时)', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(tunnelsFake.start).toHaveBeenCalledTimes(1)
    const record = tunnelsFake.start.mock.calls[0]?.[0]
    expect(record).toMatchObject({ id: created.value.id, transport: 'ssh' })
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('http 实例 start/stop/openView 走 http 管理器', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程直连',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    // start 路由本身由上一条用例守（http→httpFake、不误触 local/ssh），此处只保留 start 副作用。
    const startResult = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(startResult.ok).toBe(true)

    httpFake.statusOf.mockReturnValue({
      id: created.value.id,
      status: 'running',
      url: 'https://gw.example.com/dsh/',
      at: '2026-09-15T00:00:00.000Z'
    })
    const openResult = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(openResult.ok).toBe(true)
    expect(openInstanceView).toHaveBeenCalledTimes(1)

    const stopResult = (await invoke('instances:stop', created.value.id)) as { ok: boolean }
    expect(stopResult.ok).toBe(true)
    expect(httpFake.stop).toHaveBeenCalledWith(created.value.id)
  })

  it('stop:ssh 实例 → tunnels.stop;local 实例 → runtime.stop', async () => {
    const ssh = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!ssh.ok) throw new Error('创建失败')
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')

    const sshStop = (await invoke('instances:stop', ssh.value.id)) as { ok: boolean }
    expect(sshStop.ok).toBe(true)
    expect(tunnelsFake.stop).toHaveBeenCalledWith(ssh.value.id)
    expect(runtimeFake.stop).not.toHaveBeenCalled()

    const localStop = (await invoke('instances:stop', local.value.id)) as { ok: boolean }
    expect(localStop.ok).toBe(true)
    expect(runtimeFake.stop).toHaveBeenCalledWith(local.value.id)
  })

  it('delete:ssh 实例 → 先 tunnels.stop 再移除;http 不触碰传输层', async () => {
    const ssh = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!ssh.ok) throw new Error('创建失败')
    const result = (await invoke('instances:delete', ssh.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(tunnelsFake.stop).toHaveBeenCalledWith(ssh.value.id)

    const http = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!http.ok) throw new Error('创建失败')
    await invoke('instances:delete', http.value.id)
    expect(tunnelsFake.stop).not.toHaveBeenCalledWith(http.value.id)
    expect(runtimeFake.stop).not.toHaveBeenCalledWith(http.value.id)
  })

  it('stop 交给 runtime.stop；之后打开工作区会再次开始准备', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const stopResult = (await invoke('instances:stop', created.value.id)) as { ok: boolean }
    expect(stopResult.ok).toBe(true)
    expect(runtimeFake.stop).toHaveBeenCalledWith(created.value.id)

    const viewResult = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(viewResult.ok).toBe(true)
    expect(runtimeFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: created.value.id }))
  })

  it("openView:ssh 实例 running → 从 tunnels 取状态开窗", async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    tunnelsFake.statusOf.mockReturnValue({
      id: created.value.id,
      status: 'running',
      url: 'http://127.0.0.1:30000/',
      port: 30000,
      at: '2026-09-15T00:00:00.000Z'
    })
    // runtime 侧没有该实例的状态(running 只在 tunnels 里)
    currentStatus = null

    const result = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(tunnelsFake.statusOf).toHaveBeenCalledWith(created.value.id)
    expect(openInstanceView).toHaveBeenCalledTimes(1)
    expect(openInstanceView.mock.calls[0]?.[1]).toBe('http://127.0.0.1:30000/')
  })

  it('openView:运行中实例 → 先完成认证探测再打开窗口，避免首个请求落到登录页', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = {
      id: created.value.id,
      status: 'running',
      url: 'http://127.0.0.1:31234/?token=abc',
      port: 31234,
      at: '2026-09-15T00:00:00.000Z'
    }
    let releaseProbe!: () => void
    const probeFinished = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const order: string[] = []
    authFake.probe.mockImplementation(async () => {
      order.push('probe-start')
      await probeFinished
      order.push('probe-end')
      return null
    })
    openInstanceView.mockImplementation(async () => {
      order.push('open-view')
    })

    const opening = invoke('instances:openView', created.value.id) as Promise<{ ok: boolean }>
    await vi.waitFor(() => expect(order).toEqual(['probe-start']))
    expect(openInstanceView).not.toHaveBeenCalled()
    releaseProbe()

    const result = await opening
    expect(result.ok).toBe(true)
    expect(order).toEqual(['probe-start', 'probe-end', 'open-view'])
    expect(openInstanceView.mock.calls[0]?.[1]).toBe('http://127.0.0.1:31234/?token=abc')
  })

  it('openInBrowser:http 实例用归一化端点交给系统浏览器', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程浏览器',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const opened = (await invoke('instances:openInBrowser', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith('https://gw.example.com/dsh/')
  })

  it('openInBrowser:运行中的本机实例带 token 的就绪 URL 交给系统浏览器', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    runtimeFake.urlOf.mockReturnValue('http://127.0.0.1:31234/?token=abc')

    const opened = (await invoke('instances:openInBrowser', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith('http://127.0.0.1:31234/?token=abc')
  })

  it('openInBrowser:未运行的本机实例返回可见错误，不打开浏览器', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    runtimeFake.urlOf.mockReturnValue(null)

    const opened = (await invoke('instances:openInBrowser', created.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(opened.ok).toBe(false)
    expect(opened.code).toBe('invalid-state')
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('openInBrowser:SSH 实例不支持在浏览器中打开', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道浏览器',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const opened = (await invoke('instances:openInBrowser', created.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(opened.ok).toBe(false)
    expect(opened.code).toBe('invalid-input')
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('vault:status 返回降级与已记住实例', async () => {
    vaultFake['status']!.mockReturnValueOnce({ available: false, degraded: true, instanceCount: 2 })
    vaultFake['rememberedIds']!.mockReturnValueOnce(['a', 'b'])
    vaultFake['policyIds']!.mockReturnValueOnce(['a', 'b', 'c'])
    vaultFake['getPolicy']!.mockReturnValue({ rememberPassword: true, rememberSession: false })
    const result = (await invoke('vault:status')) as {
      ok: boolean
      value: {
        available: boolean
        degraded: boolean
        rememberedInstances: string[]
        policies: Record<string, unknown>
      }
    }
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      available: false,
      degraded: true,
      rememberedInstances: ['a', 'b'],
      policies: {
        a: { rememberPassword: true, rememberSession: false },
        b: { rememberPassword: true, rememberSession: false },
        c: { rememberPassword: true, rememberSession: false }
      }
    })
  })

  it('vault:setPolicy 经 zod 边界校验后落库', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const ok = (await invoke('vault:setPolicy', created.value.id, {
      rememberPassword: true,
      rememberSession: false
    })) as { ok: boolean; value: { rememberPassword: boolean } }
    expect(ok.ok).toBe(true)
    expect(ok.value.rememberPassword).toBe(true)
    expect(vaultFake['setPolicy']).toHaveBeenCalledWith(created.value.id, {
      rememberPassword: true,
      rememberSession: false
    })

    // 非法入参在 IPC 边界被拒(错误信封,不抛异常)
    const bad = (await invoke('vault:setPolicy', created.value.id, { rememberPassword: 'yes' })) as {
      ok: boolean
      code?: string
    }
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('invalid-input')
  })

  it('vault:forget 缺省两个都忘,并同步取消勾选', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    vaultFake['getPolicy']!.mockReturnValue({ rememberPassword: true, rememberSession: true })

    const result = (await invoke('vault:forget', created.value.id)) as {
      ok: boolean
      value: { rememberPassword: boolean; rememberSession: boolean }
    }
    expect(result.ok).toBe(true)
    expect(vaultFake['forgetPassword']).toHaveBeenCalledWith(created.value.id)
    expect(vaultFake['forgetSession']).toHaveBeenCalledWith(created.value.id)
    // 忘记凭据必须同时取消勾选,否则下次登录又写回来
    expect(vaultFake['setPolicy']).toHaveBeenCalledWith(created.value.id, {
      rememberPassword: false,
      rememberSession: false
    })
  })

  it('vault:clear 清空并写审计(审计只记枚举)', async () => {
    const result = (await invoke('vault:clear')) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(vaultFake['clearAll']).toHaveBeenCalledTimes(1)
    expect(auditSpy).toHaveBeenCalledWith({ event: 'vault-clear', result: 'ok' })
  })

  it('登录成功且勾选「记住密码」才写 vault(失败不写)', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    // 未勾选:登录成功也不写
    authFake.login.mockResolvedValueOnce({
      phase: 'connected',
      needsOnboarding: false,
      otpEnabled: false,
      lockedForMs: 0,
      message: null,
      lastErrorCode: null
    })
    await invoke('auth:login', created.value.id, 'pw', null)
    expect(vaultFake['rememberPassword']).not.toHaveBeenCalled()

    // 勾选 + 成功 → 写
    vaultFake['getPolicy']!.mockReturnValue({ rememberPassword: true, rememberSession: false })
    authFake.login.mockResolvedValueOnce({
      phase: 'connected',
      needsOnboarding: false,
      otpEnabled: false,
      lockedForMs: 0,
      message: null,
      lastErrorCode: null
    })
    await invoke('auth:login', created.value.id, 'hunter2', null)
    expect(vaultFake['rememberPassword']).toHaveBeenCalledWith(created.value.id, 'hunter2')
    expect(auditSpy).toHaveBeenCalledWith({
      instanceId: created.value.id,
      event: 'vault-write',
      result: 'password'
    })

    // 勾选但登录失败 → 不写(否则一次错误输入会把错密码存进钥匙串)
    vaultFake['rememberPassword']!.mockClear()
    authFake.login.mockResolvedValueOnce({
      phase: 'await-credentials',
      needsOnboarding: false,
      otpEnabled: false,
      lockedForMs: 0,
      message: '凭据不正确',
      lastErrorCode: 'invalid-credentials'
    })
    await invoke('auth:login', created.value.id, 'wrong', null)
    expect(vaultFake['rememberPassword']).not.toHaveBeenCalled()
  })

  it('删除实例一并清掉已记住凭据与勾选策略', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    await invoke('instances:delete', created.value.id)
    expect(vaultFake['forgetInstance']).toHaveBeenCalledWith(created.value.id)
  })

  it('settings:get 返回偏好快照', async () => {
    const result = (await invoke('settings:get')) as {
      ok: boolean
      value: { language: string; theme: string }
    }
    expect(result.ok).toBe(true)
    expect(result.value.language).toBe('zh')
    expect(result.value.theme).toBe('system')
  })

  it('settings:update 只接受已知字段的部分补丁', async () => {
    const ok = (await invoke('settings:update', { language: 'en', tray: true })) as {
      ok: boolean
      value: { language: string; tray: boolean }
    }
    expect(ok.ok).toBe(true)
    expect(settingsFake['update']).toHaveBeenCalledWith({ language: 'en', tray: true })
    expect(onSettingsChanged).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'en', tray: true }),
      ['language', 'tray']
    )

    onSettingsChanged.mockClear()
    const languageOnly = (await invoke('settings:update', { language: 'zh' })) as { ok: boolean }
    expect(languageOnly.ok).toBe(true)
    expect(onSettingsChanged).toHaveBeenCalledWith(expect.anything(), ['language'])

    // 未知字段被 .strict() 拒绝(错误信封,不抛异常)
    const unknown = (await invoke('settings:update', { nope: 1 })) as { ok: boolean; code?: string }
    expect(unknown.ok).toBe(false)
    expect(unknown.code).toBe('invalid-input')

    // 非法取值同样被拒
    const bad = (await invoke('settings:update', { theme: 'rainbow' })) as { ok: boolean }
    expect(bad.ok).toBe(false)
  })

  it('settings:refreshEnvironment 刷新缓存并返回环境差异与可重启的本机实例', async () => {
    runtimeFake.runningIds.mockReturnValue(['a', 'b', 'ext'])
    runtimeFake.statusOf.mockImplementation((id: string) =>
      id === 'ext' ? { runtimeSource: 'external' } : { runtimeSource: 'hub' }
    )
    runtimeFake.refreshEnv.mockResolvedValue({
      pathComparable: true,
      varsComparable: false,
      pathAdded: ['/opt/homebrew/bin'],
      pathRemoved: [],
      varsAdded: [],
      varsRemoved: [],
      varsChanged: []
    })

    const result = (await invoke('settings:refreshEnvironment')) as {
      ok: boolean
      value: { instances: string[]; diff: { pathAdded: string[] } }
    }

    expect(result.ok).toBe(true)
    // 外部接管的实例不可由 hub 重启，必须被排除
    expect(result.value.instances).toEqual(['a', 'b'])
    // 刷新前后的环境差异原样回传，供渲染层报告「多了什么」
    expect(result.value.diff.pathAdded).toEqual(['/opt/homebrew/bin'])
    expect(runtimeFake.refreshEnv).toHaveBeenCalledOnce()
  })

  it('settings:refreshEnvironment 拒绝多余参数', async () => {
    const result = (await invoke('settings:refreshEnvironment', 'x')) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-input')
  })
})

  it("ssh:askpassReply 空串/全空白在 IPC 边界拒绝(invalid-input)", async () => {
    const reply = (secret: unknown) => invoke('ssh:askpassReply', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', secret)
    // 空串与全空白都不是有效口令(UI 已 disabled,这里是 IPC 边界的第二道闸)
    const empty = (await reply('')) as { ok: boolean; code?: string }
    expect(empty.ok).toBe(false)
    expect(empty.code).toBe('invalid-input')
    const blank = (await reply('   ')) as { ok: boolean; code?: string }
    expect(blank.ok).toBe(false)
    expect(blank.code).toBe('invalid-input')
    // null 是合法回答(用户显式取消)
    const cancelled = (await reply(null)) as { ok: boolean }
    expect(cancelled.ok).toBe(true)
  })
