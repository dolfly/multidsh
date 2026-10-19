import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_VERSION_PROGRESS_EVENT, INSTANCE_STATUS_EVENT } from '@shared/contracts'
import type {
  InstanceRuntimeStatus,
  InstanceStatusEvent,
  RuntimeConfirmRequest
} from '@shared/contracts'
import { pluginRegistryFromUrl, sanitizeEnvRegistry, type Settings } from '@shared/settings'
import { mapRuntimeTransition } from './audit/audit-mapping'
import type { AuditEntry } from './audit/audit-log'
import { startAutoStartInstances } from './local-runtime/auto-start'
import { createLocalRuntime } from './local-runtime/local-runtime'
import type { LocalRuntimeManager } from './local-runtime/local-runtime'
import { createRuntimeInstaller } from './local-runtime/runtime-installer'
import type { BundledNpm, RuntimeInstaller } from './local-runtime/runtime-installer'
import { createPluginManager } from './local-runtime/plugin-manager'
import type { PluginManager } from './local-runtime/plugin-manager'
import { createPathProbe } from './local-runtime/runtime-source'
import type { PathProbe } from './local-runtime/runtime-source'
import { materializePnpmLauncher } from './shell/bundled-pnpm'
import type { InstanceStore } from './registry/instance-store'
import { isEmptyPatch, runtimeWritebackPatch } from './registry/runtime-writeback'
import { createPromptBroker } from './ssh/prompt-broker'
import type { PromptBroker } from './ssh/prompt-broker'
import { createHttpEndpoints } from './transport/http-endpoint'
import type { HttpEndpointManager } from './transport/http-endpoint'
import { createSshTunnels } from './transport/ssh-tunnel'
import type { SshTunnelManager } from './transport/ssh-tunnel'

export interface RuntimeControllerDeps {
  /** 数据根目录（运行时与 npm 缓存目录） */
  dataRoot: string
  /** 实例注册表（端口/版本回写、自动启动清单） */
  store: InstanceStore
  /** 当前偏好（npm registry 取值） */
  readSettings: () => Settings
  /** 主进程维护的运行时状态表（状态推进的上次值） */
  runtimeStates: Map<string, InstanceRuntimeStatus>
  auditWrite: (entry: AuditEntry) => void
  /** 系统通知（按偏好决定发不发） */
  notify: (event: InstanceStatusEvent, previous: InstanceRuntimeStatus | null) => void
  /** 实例状态变化后刷新托盘状态行 */
  refreshTrayStatus: () => void
  /** 实例停止后回收其工作区视图 */
  closeWorkspace: (instanceId: string) => void
  /** 本机实例状态推进（仅 local）；供休眠阻止按运行中的本机实例决定是否持有电源断言 */
  onLocalStatus?: (event: InstanceStatusEvent) => void
}

export interface RuntimeController {
  runtime: LocalRuntimeManager
  promptBroker: PromptBroker
  tunnels: SshTunnelManager
  httpEndpoints: HttpEndpointManager
  installer: RuntimeInstaller
  pathProbe: PathProbe
  /** dsh 插件管理器（仅本机实例）。 */
  pluginManager: PluginManager
  /** 在状态订阅与窗口就位后拉起勾选了自动启动的本机实例 */
  startAutoStart: () => void
}

/**
 * 定位随包分发的 npm-cli.js（electron-builder 经 extraResources 放在
 * `process.resourcesPath/npm/bin/npm-cli.js`）。开发期 npm 由系统提供，返回 undefined
 * 让安装器走系统探测；文件缺失时同样返回 undefined，退回系统 npm 兜底。
 */
function resolveBundledNpm(): BundledNpm | undefined {
  if (!app.isPackaged) return undefined
  const npmCliJs = join(process.resourcesPath, 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(npmCliJs)) return undefined
  return { npmCliJs }
}

/**
 * 物化随包分发的 pnpm 启动器并返回其目录，供运行时与插件管理器前置到 dsh 子进程 PATH。
 * 打包版 pnpm 在 `process.resourcesPath/pnpm-runtime/pnpm`；开发/E2E 在仓库
 * `build/pnpm-runtime/pnpm`（由 `pnpm bundle:pnpm` 生成）。缺失时返回 undefined，
 * dsh 退回系统 PATH 上的 pnpm（与捆绑前行为一致）。
 */
function resolveBundledPnpmBinDir(dataRoot: string): string | undefined {
  const pnpmCliJs = app.isPackaged
    ? join(process.resourcesPath, 'pnpm-runtime', 'pnpm', 'bin', 'pnpm.cjs')
    : join(app.getAppPath(), 'build', 'pnpm-runtime', 'pnpm', 'bin', 'pnpm.cjs')
  if (!existsSync(pnpmCliJs)) return undefined
  try {
    return materializePnpmLauncher({ binDir: join(dataRoot, 'pnpm-bin'), pnpmCliJs })
  } catch {
    // 物化失败（只读目录等）不致命：退回系统 pnpm。
    return undefined
  }
}

/**
 * 本地运行时、SSH 隧道、HTTP 端点与提示代理的初始化，以及状态事件接线。
 */
export function createRuntimeController(deps: RuntimeControllerDeps): RuntimeController {
  /** 运行时确认的应答代理；装配完成前收到确认一律按「取消」处理 */
  let promptBroker: PromptBroker | null = null

  // npm registry 可经环境变量覆盖：默认跟随系统 npm 配置；
  // 内网/海外网络慢时可指到镜像，如 DSH_HUB_NPM_REGISTRY=https://registry.npmmirror.com。
  // registry 是整条下载链的信任根（自证完整性且执行生命周期脚本），环境变量与设置项走
  // 同一 https-only 校验：非法值丢弃并告警，绝不让明文 http 镜像重开 MITM → 任意代码路径。
  const rawEnvNpmRegistry = process.env['DSH_HUB_NPM_REGISTRY']
  const envNpmRegistry = sanitizeEnvRegistry(rawEnvNpmRegistry)
  if (rawEnvNpmRegistry?.trim() && envNpmRegistry === undefined) {
    console.warn('[main] DSH_HUB_NPM_REGISTRY 不是合法的 https 镜像地址，已忽略')
  }
  /** 生效镜像地址：设置优先，其次环境变量；空串 = 跟随系统 npm 配置。 */
  const effectiveRegistry = (): string => deps.readSettings().npmRegistry || envNpmRegistry || ''
  const installer = createRuntimeInstaller({
    runtimesDir: join(deps.dataRoot, 'runtimes'),
    cacheDir: join(deps.dataRoot, 'npm-cache'),
    getRegistry: () => effectiveRegistry() || undefined,
    // 随包分发 npm-cli.js（electron-builder extraResources），经应用自带 Node
    // （ELECTRON_RUN_AS_NODE）运行：打包产物不再依赖目标机装有 Node/npm，Windows
    // 「PATH 与常见安装位置均未找到 npm」自此不再阻断本机实例的运行时安装。
    bundledNpm: resolveBundledNpm()
  })
  // 运行时确认走 hub 风格的渲染层对话框（prompt broker 推送 + 渲染层挂载时快照补拉）。
  // 无窗口可应答、broker 未装配或用户拒绝/超时，一律按「取消」处理——绝不静默下载、
  // 也不静默改写全局安装；无头 E2E 设 DSH_HUB_E2E_DECLINE_DOWNLOAD=1 同样直接取消，
  // 让本地实例启动快速到达确定的 stopped 终态。
  const confirmViaRenderer = (payload: RuntimeConfirmRequest): Promise<boolean> => {
    if (process.env['DSH_HUB_E2E_DECLINE_DOWNLOAD'] === '1') return Promise.resolve(false)
    if (promptBroker === null || BrowserWindow.getAllWindows().length === 0)
      return Promise.resolve(false)
    return promptBroker.requestConfirm(payload)
  }
  const pathProbe = createPathProbe()
  // 随包分发的 pnpm 启动器目录：令 dsh 的插件管理用自带 pnpm，不依赖系统 pnpm。
  const pnpmBinDir = resolveBundledPnpmBinDir(deps.dataRoot)
  const pluginManager = createPluginManager({
    installer,
    dataRoot: deps.dataRoot,
    pathProbe,
    pnpmBinDir,
    // 与本机实例启动同源的环境继承：打包后 GUI 从 Finder/Dock 启动只继承 launchd 最小 PATH，
    // 缺 pnpm/node 目录会让 dsh plugin 转发 pnpm 失败；运行中改设置即时生效。
    inheritShellEnv: () => deps.readSettings().inheritShellEnv,
    // 插件命令的默认安装源跟随生效镜像（设置优先、环境变量次之）；运行中改设置即时生效。
    defaultRegistry: () => pluginRegistryFromUrl(effectiveRegistry())
  })
  const runtime = createLocalRuntime({
    installer,
    dataRoot: deps.dataRoot,
    store: deps.store,
    pathProbe,
    pnpmBinDir,
    // 登录 shell 完整环境继承开关：运行中改设置即时生效（下次启动实例时读取）。
    inheritShellEnv: () => deps.readSettings().inheritShellEnv,
    confirmDownload: (version) =>
      confirmViaRenderer({ kind: 'dsh-download', version, registry: effectiveRegistry() }),
    // 公共空间实例的升级改写的是系统默认 dsh（对所有使用者全局生效），必须二次确认；
    // 拒绝时本次升级不产生任何进度、不改任何状态。
    confirmSystemUpgrade: (latest, current) =>
      confirmViaRenderer({ kind: 'system-dsh-upgrade', latest, current }),
    // dsh 运行时版本变更后的首次启动：核对已启用插件的 peer，自动禁用与新版不兼容的插件。
    beforeSpawn: async (instance, version) => {
      const result = await pluginManager.reconcileRuntime(instance, version)
      if (result.disabled.length > 0) {
        console.warn(
          '[main] 已自动禁用与 dsh %s 不兼容的插件：%s',
          version,
          result.disabled.map((item) => `${item.name}@${item.version}`).join('、')
        )
      }
    }
  })

  promptBroker = createPromptBroker({
    send: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(channel, payload)
      }
    }
  })
  const tunnels = createSshTunnels({
    dataRoot: deps.dataRoot,
    confirmHostKey: (request) => promptBroker?.requestHostKey(request) ?? Promise.resolve('reject'),
    askpass: (request) => promptBroker?.requestAskpass(request) ?? Promise.resolve(null)
  })
  const httpEndpoints = createHttpEndpoints()

  // 状态推进（local + ssh 共用同一通道）→ 广播到所有窗口；把实际端口/版本回写注册表
  // （transport 感知：ssh 的「端口」是隧道本地口 localPort，local 的才是监听 port）；
  // 回收已停止实例的窗口
  const handleStatusEvent = (event: InstanceStatusEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(INSTANCE_STATUS_EVENT, event)
    }
    const previousStatus = deps.runtimeStates.get(event.id) ?? null
    for (const entry of mapRuntimeTransition(
      event.id,
      previousStatus === null ? null : { status: previousStatus },
      { status: event.status }
    )) {
      deps.auditWrite(entry)
    }
    // 写在不可测的闭包里,删掉后三关全绿);失败已在内部收敛为日志,绝不打断状态流。
    deps.notify(event, previousStatus)
    deps.runtimeStates.set(event.id, event.status)
    deps.refreshTrayStatus()
    if (event.status === 'running' && (event.port !== undefined || event.version !== undefined)) {
      void deps.store
        .get(event.id)
        .then((record) => {
          // 回写策略集中在纯函数里(可穷举测试):只有 hub 来源回写版本;
          // 而 store 拒绝空补丁(`补丁不能为空`)→ 必须在此跳过,否则每次接管都报错。
          const patch = runtimeWritebackPatch(event, record?.transport)
          if (isEmptyPatch(patch)) return null
          return deps.store.update(event.id, patch)
        })
        .catch((error: unknown) => console.error('[main] 回写实例运行信息失败：', error))
    }
    if (event.status === 'stopped') deps.closeWorkspace(event.id)
  }
  runtime.onStatus(handleStatusEvent)
  // 休眠阻止只认本机实例：local runtime 的事件仅覆盖 local 传输，ssh/http 不触发。
  if (deps.onLocalStatus) runtime.onStatus(deps.onLocalStatus)
  tunnels.onStatus(handleStatusEvent)
  httpEndpoints.onStatus(handleStatusEvent)
  // dsh 升级进度 → 广播到所有窗口（独立通道，不占用实例状态事件）。
  runtime.onUpgradeProgress((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(DSH_VERSION_PROGRESS_EVENT, event)
    }
  })

  const startAutoStart = (): void => {
    // 勾选「应用启动时自动拉起」的本机实例:在状态订阅与窗口就位后统一拉起。
    // 不 await:启动可能耗时数十秒(下载/安装运行时),失败经状态事件回推,不阻塞启动流程。
    const autoStartRuntime = runtime
    void startAutoStartInstances({
      list: () => deps.store.list(),
      start: (instance) => autoStartRuntime.start(instance),
      onError: (error) => console.error('[main] 启动时自动拉起实例失败：', error)
    })
  }

  return {
    runtime,
    promptBroker,
    tunnels,
    httpEndpoints,
    installer,
    pathProbe,
    pluginManager,
    startAutoStart
  }
}
