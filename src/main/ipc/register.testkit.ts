import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import { ipcMain } from 'electron'
import type { InstanceStatusEvent } from '@shared/contracts'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import type { SshTunnelManager } from '../transport/ssh-tunnel'
import type { HttpEndpointManager } from '../transport/http-endpoint'
import { createInstanceStore } from '../registry/instance-store'
import { emptyEnvironmentDiff } from '../local-runtime/env-diff'
import { registerIpc } from './register'

/**
 * `register.test.ts` 的分片共用装配：一套 IPC 依赖替身 + 临时注册表目录 + 通道触发器。
 *
 * 用法（每个 test 文件）：
 *
 * ```ts
 * vi.mock('electron', () => ({ ... }))      // mock 是文件级的，必须在各 test 文件里重复声明
 * let currentStatus: InstanceStatusEvent | null = null
 * let harness: RegisterHarness
 * beforeEach(async () => {
 *   harness = await setupRegister({ status: () => currentStatus })
 * })
 * afterEach(async () => teardownRegister(harness))
 * ```
 *
 * `status` 传 getter：测试体直接给文件内的 `currentStatus` 赋值，替身读到的就是最新值，
 * 因此测试体无需改写。
 */

export type Listener = (...args: unknown[]) => unknown

/** 临时注册表目录根：建在仓库内被忽略的 hub-data 下，避免触碰真实 userData。 */
export const TEST_BASE = join(process.cwd(), 'hub-data', 'test-tmp')

type MockFn = ReturnType<typeof vi.fn>

export interface RuntimeFake {
  onStatus: MockFn
  onUpgradeProgress: MockFn
  statusOf: MockFn
  urlOf: MockFn
  runningIds: MockFn
  start: MockFn
  stop: MockFn
  stopAll: MockFn
  refreshEnv: MockFn
  adopt: MockFn
  upgradeInstance: MockFn
}

export interface TunnelsFake {
  onStatus: MockFn
  statusOf: MockFn
  runningIds: MockFn
  start: MockFn
  stop: MockFn
  stopAll: MockFn
  forgetHostKey: MockFn
}

export interface HttpFake {
  onStatus: MockFn
  statusOf: MockFn
  runningIds: MockFn
  start: MockFn
  stop: MockFn
  stopAll: MockFn
}

export interface AuthFake {
  probe: MockFn
  login: MockFn
  logout: MockFn
  stateOf: MockFn
  forget: MockFn
  beginLogout: MockFn
  endLogout: MockFn
  isLoggingOut: MockFn
  client: MockFn
  sessionCookie: MockFn
  clientIds: MockFn
}

export interface PromptBrokerFake {
  requestHostKey: MockFn
  requestAskpass: MockFn
  replyHostKey: MockFn
  replyAskpass: MockFn
  replyConfirm: MockFn
  listConfirms: MockFn
  cancelAll: MockFn
}

export interface InstallerFake {
  listAvailableVersions: MockFn
  resolveDefaultVersion: MockFn
  resolveLatestVersion: MockFn
  listInstalled: MockFn
  isInstalled: MockFn
  install: MockFn
  ensureInstalled: MockFn
  resolveEntry: MockFn
  hasIncompleteInstall: MockFn
  resolveGlobalPrefix: MockFn
  installGlobal: MockFn
  dispose: MockFn
}

export interface PluginManagerFake {
  list: MockFn
  check: MockFn
  checkState: MockFn
  install: MockFn
  resolveInstall: MockFn
  packageInfo: MockFn
  upgrade: MockFn
  remove: MockFn
  setEnabled: MockFn
}

export interface RegisterHarness {
  /** 本用例的临时注册表目录（各用例独立，afterEach 删除） */
  dir: string
  /** 已注册通道 → 监听器；`invoke` 与注册面断言都读它 */
  handlers: Map<string, Listener>
  /** 触发通道：模拟渲染层调用，返回处理函数结果 */
  invoke(channel: string, ...args: unknown[]): unknown
  runtimeFake: RuntimeFake
  tunnelsFake: TunnelsFake
  httpFake: HttpFake
  authFake: AuthFake
  vaultFake: Record<string, MockFn>
  settingsFake: Record<string, MockFn>
  installerFake: InstallerFake
  pluginManagerFake: PluginManagerFake
  promptBrokerFake: PromptBrokerFake
  externalDshScannerFake: { scan: MockFn }
  verifyExternalAccess: MockFn
  listLocalSpaces: MockFn
  trashLocalSpace: MockFn
  instanceViewUrlFake: MockFn
  openInstanceView: MockFn
  openExternalUrl: MockFn
  onSettingsChanged: MockFn
  auditSpy: (entry: { instanceId?: string | null; event: string; result?: string }) => void
  clearPartitionSession: MockFn
  closeInstanceView: MockFn
  reloadInstanceView: MockFn
  showInstanceTooltip: MockFn
  hideInstanceTooltip: MockFn
  /** 传给 registerIpc 的依赖集合（用例可 `{...ipcDeps, X: undefined}` 重新注册） */
  ipcDeps: Parameters<typeof registerIpc>[1]
}

/**
 * 建依赖替身、临时注册表目录并完成一次 `registerIpc`。
 *
 * @param status 运行时状态的读取口；由 test 文件传入自己的 `currentStatus` 变量，
 *   使 `runtimeFake.statusOf/urlOf` 与用例对 `currentStatus` 的赋值保持联动。
 */
export async function setupRegister(
  status: () => InstanceStatusEvent | null = () => null
): Promise<RegisterHarness> {
  await mkdir(TEST_BASE, { recursive: true })
  const dir = await mkdtemp(join(TEST_BASE, 'ipc-'))
  const handlers = new Map<string, Listener>()
  vi.mocked(ipcMain.handle).mockImplementation((channel, listener) => {
    handlers.set(channel as string, listener as Listener)
    return undefined as never
  })

  const verifyExternalAccess = vi.fn(async () => true)
  const listLocalSpaces = vi.fn(async () => [])
  const trashLocalSpace = vi.fn(async () => undefined)

  const installerFake: InstallerFake = {
    listAvailableVersions: vi.fn(async () => ['0.1.4', '0.1.5']),
    resolveDefaultVersion: vi.fn(async () => '0.1.5'),
    resolveLatestVersion: vi.fn(async () => '0.1.5'),
    listInstalled: vi.fn(async () => []),
    isInstalled: vi.fn(async () => false),
    install: vi.fn(async () => ({
      version: '0.1.5',
      dir: '/tmp/d',
      entry: '/tmp/e',
      installedAt: ''
    })),
    ensureInstalled: vi.fn(async () => ({
      version: '0.1.5',
      dir: '/tmp/d',
      entry: '/tmp/e',
      installedAt: ''
    })),
    resolveEntry: vi.fn((v: string) => `/tmp/${v}`),
    hasIncompleteInstall: vi.fn(async () => false),
    resolveGlobalPrefix: vi.fn(async () => '/usr/local'),
    installGlobal: vi.fn(async () => undefined),
    dispose: vi.fn(() => undefined)
  }

  const runtimeFake: RuntimeFake = {
    onStatus: vi.fn(() => () => undefined),
    onUpgradeProgress: vi.fn(() => () => undefined),
    statusOf: vi.fn(() => status()),
    urlOf: vi.fn(() => status()?.url ?? null),
    runningIds: vi.fn(() => []),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    refreshEnv: vi.fn(async () => emptyEnvironmentDiff()),
    adopt: vi.fn(async () => undefined),
    upgradeInstance: vi.fn(async () => undefined)
  }

  const tunnelsFake: TunnelsFake = {
    onStatus: vi.fn(() => () => undefined),
    statusOf: vi.fn(() => null),
    runningIds: vi.fn(() => []),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    forgetHostKey: vi.fn(async () => undefined)
  }

  const httpFake: HttpFake = {
    onStatus: vi.fn(() => () => undefined),
    statusOf: vi.fn(() => null),
    runningIds: vi.fn(() => []),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined)
  }

  const authFake: AuthFake = {
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

  const clearPartitionSession = vi.fn(async () => undefined)
  const closeInstanceView = vi.fn()
  const reloadInstanceView = vi.fn(async () => undefined)
  const showInstanceTooltip = vi.fn(async () => undefined)
  const hideInstanceTooltip = vi.fn()

  const vaultFake: Record<string, MockFn> = {
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

  const auditSpy = vi.fn() as unknown as RegisterHarness['auditSpy']
  const onSettingsChanged = vi.fn()
  const settingsFake: Record<string, MockFn> = {
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

  const openInstanceView = vi.fn()
  const openExternalUrl = vi.fn(async () => undefined)
  const pluginManagerFake: PluginManagerFake = {
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
    resolveInstall: vi.fn(async () => ({
      installSpec: 'demo-plugin@1.1.0',
      input: 'demo-plugin',
      kind: 'npm',
      packageName: 'demo-plugin',
      targetVersion: '1.1.0',
      latestVersion: '1.1.0',
      versionSource: 'resolved-latest',
      publishedAt: null,
      dshPeer: null,
      dshVersion: null,
      compatible: true,
      installedVersion: null
    })),
    packageInfo: vi.fn(async () => ({
      downloads: null,
      releaseNotes: { text: null, source: 'none', pageUrl: null, truncated: false }
    })),
    upgrade: vi.fn(async () => ({ hasHostSide: false })),
    remove: vi.fn(async () => ({ hasHostSide: false })),
    setEnabled: vi.fn(async (_instance, name, enabled) => ({ name, enabled }))
  }
  const instanceViewUrlFake = vi.fn(() => null)
  const externalDshScannerFake = { scan: vi.fn(async () => []) }
  const promptBrokerFake: PromptBrokerFake = {
    requestHostKey: vi.fn(async () => 'trust'),
    requestAskpass: vi.fn(async () => null),
    replyHostKey: vi.fn(() => true),
    replyAskpass: vi.fn(() => true),
    replyConfirm: vi.fn(() => true),
    listConfirms: vi.fn(() => []),
    cancelAll: vi.fn()
  }

  const ipcDeps: Parameters<typeof registerIpc>[1] = {
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

  const invoke = (channel: string, ...args: unknown[]): unknown => {
    const listener = handlers.get(channel)
    if (!listener) throw new Error(`通道未注册：${channel}`)
    return listener({} as never, ...args)
  }

  return {
    dir,
    handlers,
    invoke,
    runtimeFake,
    tunnelsFake,
    httpFake,
    authFake,
    vaultFake,
    settingsFake,
    installerFake,
    pluginManagerFake,
    promptBrokerFake,
    externalDshScannerFake,
    verifyExternalAccess,
    listLocalSpaces,
    trashLocalSpace,
    instanceViewUrlFake,
    openInstanceView,
    openExternalUrl,
    onSettingsChanged,
    auditSpy,
    clearPartitionSession,
    closeInstanceView,
    reloadInstanceView,
    showInstanceTooltip,
    hideInstanceTooltip,
    ipcDeps
  }
}

/** 删除本用例的临时注册表目录。 */
export async function teardownRegister(harness: RegisterHarness): Promise<void> {
  await rm(harness.dir, { recursive: true, force: true })
}

/** 是否注册了某通道（注册面断言用）。 */
export function hasChannel(harness: RegisterHarness, channel: string): boolean {
  return harness.handlers.has(channel)
}
