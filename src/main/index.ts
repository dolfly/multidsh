import {
  app,
  BrowserWindow,
  protocol,
  session,
  shell,
  nativeTheme,
  powerSaveBlocker
} from 'electron'
import type { Tray } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { registerRendererAssets } from './renderer-assets'
import type { InstanceRuntimeStatus } from '@shared/contracts'
import { AUTH_IPC, WORKSPACE_HOTKEY_EVENT } from '@shared/contracts'
import { registerIpc } from './ipc/register'
import type { AuthProbeController } from './ipc/register'
import type { LocalRuntimeManager } from './local-runtime/local-runtime'
import type { RuntimeInstaller } from './local-runtime/runtime-installer'
import { createExternalDshScanner } from './local-runtime/external-dsh'
import { listLocalSpaces, trashLocalSpaceDir } from './local-runtime/local-spaces'
import type { SshTunnelManager } from './transport/ssh-tunnel'
import type { HttpEndpointManager } from './transport/http-endpoint'
import { buildOpenViewPlan, classifyViewResponse } from './webview/open-view-plan'
import { planPartitionClear } from './webview/partition-clear-plan'
import {
  createOncePerSession,
  openInstanceView as openInstanceViewFlow
} from './webview/instance-view'
import { clearSessionCookie } from './webview/session-cookie'
import type { PromptBroker } from './ssh/prompt-broker'
import type { AuthRegistry } from './auth/auth-registry'
import { createInstanceStore } from './registry/instance-store'
import { REGISTRY_MIGRATIONS } from './registry/migrations'
import { createSettingsStore } from './settings/settings-store'
import { resolveLanguage } from '@shared/settings'
import type { SettingsStore } from './settings/settings-store'
import { createNativeSettingsApplier } from './shell/native-settings'
import { applyNativeThemeSource } from './shell/native-theme'
import type { HubNativePorts } from './shell/native-ports'
import { createStatusNotifier } from './shell/status-notifier'
import { createSleepBlocker } from './shell/sleep-blocker'
import type { SleepBlockerController } from './shell/sleep-blocker'
import { createDataDirOpener } from './shell/open-data-dir'
import { createHomepageOpener } from './shell/open-homepage'
import { openInstanceDir, openInstanceLogDir } from './shell/open-instance-dir'
import { consolidatePluginLogsForInstances } from './shell/prune-plugin-logs'
import { createGracefulQuit } from './shell/graceful-quit'
import { openExternalSafely } from './window-host-policy'
import { focusDebug } from './shell/focus-debug'
import { redactUrl } from '@shared/redact'
import type { Vault } from './vault/vault'
import type { Settings } from '@shared/settings'
import { createWorkspaceHost } from './workspace-host'
import { createWorkspaceTooltipHost } from './workspace-tooltip'
import { systemLocale } from './system-locale'
import { pinStartupLanguage } from './startup-language'
import { createWindowController } from './create-window'
import { createTrayController } from './create-tray'
import { createAuthController } from './create-auth'
import { createRuntimeController } from './create-runtime'
import { createVaultControl } from './create-vault'
import { auditWrite, createAudit } from './create-audit'
import { installTopLevelFailureLoggers } from './shell/top-level-failure'
import { installMainLogging } from './shell/main-log'

installTopLevelFailureLoggers({
  log: (line) => console.error(line),
  exit: (code) => app.exit(code)
})

const isDev = !app.isPackaged
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'] ?? null

/**
 * 生产环境渲染器走自定义 `app://hub` 协议而不是 file://：
 * 1. file:// 下 CSP 的 `'self'` 语义不可用，script 会被误杀；
 * 2. app:// 提供稳定的 origin，未来 HttpOnly cookie 注入与存储作用域都有明确宿主。
 */
const RENDERER_ORIGIN = 'app://hub'

/**
 * 判定 URL 是否属于本应用渲染器 origin。
 * 不能用 `url.origin === RENDERER_ORIGIN`：Node 的 WHATWG URL 不认识 `app:` 注册为
 * standard scheme（那是 Electron 侧注册的），对非 standard scheme `origin` 恒为 `'null'`。
 */
function isRendererOrigin(url: URL): boolean {
  return url.protocol === 'app:' && url.hostname === 'hub'
}

/**
 * 仅当不使用 Vite dev server 时注入（dev 由 HMR 自行管理资源，注入会打断热更新）。
 * 不依赖 isPackaged：E2E 以未打包形态启动但无 dev server，同样会走到注入路径，让 CSP 可被冒烟覆盖。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

/**
 * 数据目录可被 `DSH_HUB_DATA_DIR` 覆盖（须在 ready 前生效）。
 * 也便于在受限环境下把 userData 指到可写位置（如 CI 沙箱）。
 */
const userDataOverride = process.env['DSH_HUB_DATA_DIR']?.trim()
if (userDataOverride) app.setPath('userData', userDataOverride)

/**
 * 主进程日志落盘：console.* 输出经脱敏后追加到 `<userData>/logs/main.log`
 * （轮转/保留/脱敏见 main-log.ts）。须在 `DSH_HUB_DATA_DIR` 覆盖之后安装，
 * 日志目录才落在最终 userData 下；打包版 GUI 启动（stderr 无终端）也能留痕。
 */
const mainLog = installMainLogging({ dir: join(app.getPath('userData'), 'logs') })
// 启动时清理过期归档（不阻塞启动）
void mainLog
  .prune()
  .catch((error: unknown) => console.error('[main] 主进程日志归档清理失败：', error))

/**
 * E2E 隐藏窗口模式（`DSH_HUB_E2E_HIDDEN=1`）：测试仍启动真实应用，但窗口不显示、
 * 应用不进 Dock，避免打断本机正在进行的其他工作；渲染进程关闭后台节流，计时器、
 * 扫描与截图行为与可见窗口一致。CI 的 Linux E2E 走 xvfb 虚拟屏，无需此开关。
 */
const e2eHidden = process.env.DSH_HUB_E2E_HIDDEN === '1'
if (e2eHidden && process.platform === 'darwin') app.dock?.hide()

const windowController = createWindowController({
  isDev,
  rendererDevUrl,
  rendererOrigin: RENDERER_ORIGIN,
  isRendererOrigin,
  e2eHidden,
  readSettings: () => settingsRef?.read() ?? null,
  trayExists: () => nativePorts?.trayExists() === true,
  isQuitting: () => quitting,
  getWorkspaceHost: () => workspaceHost,
  getWorkspaceTooltipHost: () => workspaceTooltipHost
})
const workspaceHost = createWorkspaceHost(
  () => windowController.getHubWindow(),
  () => resolveLanguage(settingsRef?.read().language, systemLocale()),
  // 工作区视图持焦期间,白名单快捷键输入转发给 hub 渲染层还原为窗口事件。
  (event) => {
    const hubWindow = windowController.getHubWindow()
    if (hubWindow && !hubWindow.isDestroyed())
      hubWindow.webContents.send(WORKSPACE_HOTKEY_EVENT, event)
  }
)
const workspaceTooltipHost = createWorkspaceTooltipHost(
  () => windowController.getHubWindow(),
  undefined,
  { e2eHidden }
)

let vault: Vault | null = null

/**
 * 装配前创建的消费者（窗口控制器、工作区语言）只能经此延迟读取设置；
 * 窗口关闭（「关闭时最小化到托盘」）可能早于或独立于设置仓装配发生。
 */
let settingsRef: SettingsStore | null = null

let nativePorts: HubNativePorts<Tray> | null = null

/** 从托盘退出：`before-quit` 先标记退出，再放行窗口关闭。 */
function quitApp(): void {
  app.quit()
}

const lastRuntimeState = new Map<string, InstanceRuntimeStatus>()

/**
 * 302/401 拦截「每分区会话只装一次」守卫 —— 详见 `webview/instance-view.ts`
 * (`onHeadersReceived` 为追加语义,重复 openView 会叠加监听器)。
 */
const shouldInstallIntercept = createOncePerSession<Electron.Session>()

/**
 * 会话失效「静默重探」在飞守卫:一个会话失效的页面会因多个子资源产生多条信号,
 * 无守卫时会对同一实例并发重探多次(徒增网关压力)。渲染层侧另有同义守卫。
 */
const reprobeInFlight = new Set<string>()
let authProbeController: AuthProbeController | null = null

function registerRendererProtocol(): void {
  registerRendererAssets({
    rendererRoot: join(__dirname, '../renderer'),
    rendererDevUrl,
    isRendererOrigin
  })
}

/** 运行中的本地实例 / SSH 隧道管理器（退出前需回收进程树，故提到模块级） */
let runtime: LocalRuntimeManager | null = null
let tunnels: SshTunnelManager | null = null
let httpEndpoints: HttpEndpointManager | null = null
let promptBroker: PromptBroker | null = null
let auth: AuthRegistry | null = null
/** dsh 运行时安装器（退出前需中止在飞的 npm 安装，故提到模块级）。 */
let installerRef: RuntimeInstaller | null = null
/** 休眠阻止控制器（退出前需释放电源断言，故提到模块级）。 */
let sleepBlocker: SleepBlockerController | null = null
let quitting = false

const gracefulQuit = createGracefulQuit({
  onStart: () => {
    quitting = true
  },
  cleanup: async () => {
    // 先中止在飞的 npm 安装子进程，避免应用退出后仍在后台下载/装包。
    installerRef?.dispose()
    // 释放休眠阻止断言，避免进程退出后仍让系统保持唤醒。
    sleepBlocker?.dispose()
    const recycling: Array<Promise<void>> = []
    if (runtime) {
      recycling.push(
        runtime.stopAll().catch((error: unknown) => console.error('[main] 停止实例失败：', error))
      )
    }
    if (tunnels) {
      recycling.push(
        tunnels.stopAll().catch((error: unknown) => console.error('[main] 停止隧道失败：', error))
      )
    }
    if (httpEndpoints) {
      recycling.push(
        httpEndpoints
          .stopAll()
          .catch((error: unknown) => console.error('[main] 停止 HTTP 实例失败：', error))
      )
    }
    await Promise.all(recycling)
  },
  onError: (error) => console.error('[main] 退出清理失败：', error),
  // app.quit() 会重新进入 before-quit；完成清理后必须直接结束进程，确保一次 ⌘Q 即退出。
  exit: (code) => app.exit(code)
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
else {
  app.on('second-instance', () => {
    // 排查前台抢焦点：再次启动 App 会触发该事件并把窗口顶到前台。
    focusDebug('[index] app.second-instance')
    windowController.showHubWindow()
  })
}

// 无头 E2E 里 Chromium 探测不到桌面环境,safeStorage 会回退 basic_text(非真加密),
// 凭据保险库随之降级。经此开关显式声明后端,让保险库在 Linux CI 上与真实桌面一致;
// 产品默认跟随桌面环境,不设置该环境变量即无影响。
if (process.env.DSH_HUB_E2E_PASSWORD_STORE) {
  app.commandLine.appendSwitch('password-store', process.env.DSH_HUB_E2E_PASSWORD_STORE)
}

// 打包产物缺 app 级 .lproj 时 Chromium 语言回落 en,须在 ready 前钉回系统语言,
// 否则工作区 dsh web 按 navigator 检测出英文(职责与约束见 startup-language.ts)。
pinStartupLanguage()

void app.whenReady().then(() => {
  if (!hasSingleInstanceLock) return
  registerRendererProtocol()

  const dataRoot = app.getPath('userData')
  // 注册表落盘位置：<userData>/registry/instances.json（+ 滚动备份 + 损坏隔离）；
  // 接入 v1→v2 迁移链，历史的方括号主机 / 非法 dshVersion 归一化而非整表隔离。
  const instanceStore = createInstanceStore({
    dir: join(dataRoot, 'registry'),
    migrations: REGISTRY_MIGRATIONS
  })

  // 启动时归并各本机实例 DSH_HOME 下堆积的 dsh 插件操作日志（operation-*）：把已结束的
  // 非空日志并入按天合并文件、删掉原目录，合并文件保留 30 天。不阻塞启动，失败只记日志
  // （见 prune-plugin-logs.ts）。
  void instanceStore
    .list()
    .then((records) =>
      consolidatePluginLogsForInstances({
        dataRoot,
        records,
        options: { onError: (error) => console.error('[main] 归并插件操作日志条目失败：', error) }
      })
    )
    .catch((error: unknown) => console.error('[main] 插件操作日志归并失败：', error))
  const vaultControl = createVaultControl(dataRoot)
  vault = vaultControl.vault
  const settings = createSettingsStore({ dir: dataRoot })
  settingsRef = settings

  // 休眠阻止：有本机实例运行且偏好开启时持有电源断言（只拦空闲休眠，不接管合盖/熄屏）。
  sleepBlocker = createSleepBlocker({
    port: {
      start: (type) => powerSaveBlocker.start(type),
      stop: (id) => powerSaveBlocker.stop(id),
      isStarted: (id) => powerSaveBlocker.isStarted(id)
    },
    onError: (error) => console.error('[main] 休眠阻止断言操作失败：', error)
  })
  sleepBlocker.setEnabled(settings.read().preventSleepWhenRunning)

  const trayController = createTrayController({
    readSettings: () => settings.read(),
    runtimeStates: lastRuntimeState,
    onShow: windowController.showHubWindow,
    onQuit: quitApp
  })
  nativePorts = trayController.ports
  const nativeApplier = createNativeSettingsApplier(nativePorts)

  /**
   * 施加原生设置。单个动作失败只记日志（偏好已落盘，系统层失败不该让设置页报错）。
   * 「该做哪些动作」由纯函数 `planNativeSettings` 决定,「动作有没有真的落到
   * electron」由注入端口的 `createNativeSettingsApplier` 保证 —— 两者都有单测
   */
  const applyNativeSettings = (
    current: Settings,
    changedKeys: readonly (keyof Settings)[]
  ): void => {
    nativeApplier.apply(current, { changedKeys })
    if (changedKeys.includes('workspaceCacheSize')) {
      workspaceHost.setCacheLimit(current.workspaceCacheSize)
    }
    if (changedKeys.includes('language')) {
      workspaceHost.setLocale()
    }
    if (changedKeys.includes('theme')) {
      applyNativeThemeSource(current.theme, nativeTheme)
    }
    if (changedKeys.includes('preventSleepWhenRunning')) {
      sleepBlocker?.setEnabled(current.preventSleepWhenRunning)
    }
  }

  // 这里只注入「偏好/语言」两个取值端口(三审 Finding 2)
  const notifier = createStatusNotifier({
    readSettings: () => settings.read(),
    locale: () => systemLocale(),
    onError: (error) => console.error('[main] 发送系统通知失败：', error)
  })

  // 目录在此解析(`DSH_HUB_DATA_DIR` 覆盖已在文件顶部生效,故 userData 即权威值)。
  const dataDirOpener = createDataDirOpener({
    dataDir: () => app.getPath('userData'),
    openPath: (path) => shell.openPath(path)
  })
  // 目标地址固定为项目主页(通道无 URL 参数),渲染层无法指定其他站点。
  const homepageOpener = createHomepageOpener({
    openExternal: (url) => {
      // 排查「DSH 丢焦点给浏览器」方向：「关于」面板打开项目主页会激活系统浏览器。
      focusDebug(`[index] openExternal source=about-homepage url=${redactUrl(url)}`)
      return shell.openExternal(url)
    }
  })

  workspaceHost.setCacheLimit(settings.read().workspaceCacheSize)
  applyNativeThemeSource(settings.read().theme, nativeTheme)
  nativeApplier.apply(settings.read(), { startup: true })
  createAudit({
    dataRoot,
    safeStorageAvailable: vaultControl.safeStorageAvailable,
    safeStorageBackend: () => vaultControl.safeStorageBackend()
  })

  const runtimeController = createRuntimeController({
    dataRoot,
    store: instanceStore,
    readSettings: () => settings.read(),
    runtimeStates: lastRuntimeState,
    auditWrite,
    notify: (event, previous) => notifier.notify(event, previous),
    refreshTrayStatus: () => trayController.refreshStatus(),
    closeWorkspace: (instanceId) => workspaceHost.close(instanceId),
    onLocalStatus: (event) => sleepBlocker?.onLocalStatus(event)
  })
  runtime = runtimeController.runtime
  tunnels = runtimeController.tunnels
  httpEndpoints = runtimeController.httpEndpoints
  promptBroker = runtimeController.promptBroker
  const installer = runtimeController.installer
  installerRef = installer
  const pathProbe = runtimeController.pathProbe
  const pluginManager = runtimeController.pluginManager

  const authController = createAuthController({
    getVault: () => vault,
    store: instanceStore,
    getTunnels: () => tunnels,
    auditWrite
  })
  auth = authController.auth

  authProbeController = registerIpc(instanceStore, {
    runtime,
    tunnels,
    http: httpEndpoints,
    auth,
    installer,
    pluginManager,
    externalDshScanner: createExternalDshScanner(),
    pathProbe,
    vault: vault as Vault,
    settings,
    audit: auditWrite,
    onSettingsChanged: applyNativeSettings,
    openDataDir: () => dataDirOpener.open(),
    openHomepage: () => homepageOpener.open(),
    openAbout: () => windowController.openAbout(),
    hideInstanceView: () => workspaceHost.hide(),
    // 在系统默认浏览器中打开实例地址：仅放行 http/https/mailto，其余协议拒绝。
    openExternalUrl: async (url) => {
      // 排查「DSH 丢焦点给浏览器」方向：插件/渲染层经此开外链会激活系统浏览器、
      // 把前台让给它。记录脱敏 URL，供与 win.blur 日志对齐判定主动让出还是被抢。
      focusDebug(`[index] openExternal source=plugin-or-renderer url=${redactUrl(url)}`)
      openExternalSafely(url, (target) => shell.openExternal(target))
    },
    closeInstanceView: (instanceId) => workspaceHost.disconnect(instanceId),
    // 重新登录成功后刷新工作区：注入最新会话 Cookie 并导航回工作区 URL，取代会话失效前的旧页面。
    reloadInstanceView: (instanceId) =>
      workspaceHost.reloadSession(instanceId, auth?.sessionCookie(instanceId) ?? null),
    setInstanceViewBounds: (bounds) => workspaceHost.setBounds(bounds),
    showInstanceTooltip: (tooltip) => workspaceTooltipHost.show(tooltip),
    hideInstanceTooltip: () => workspaceTooltipHost.hide(),
    instanceViewUrl: (instanceId) => workspaceHost.loadedUrl(instanceId),
    listLocalSpaces: () => listLocalSpaces(dataRoot),
    trashLocalSpace: (instanceId) =>
      trashLocalSpaceDir(dataRoot, instanceId, (path) => shell.trashItem(path)),
    localHomePath: (record) =>
      record.transport === 'local' && !record.useDefaultSpace
        ? join(dataRoot, 'homes', record.id)
        : join(homedir(), '.dsh'),
    openInstanceDir: (record) =>
      openInstanceDir({ dataRoot, openPath: (path) => shell.openPath(path) }, record),
    openInstanceLogDir: (record) =>
      openInstanceLogDir({ dataRoot, openPath: (path) => shell.openPath(path) }, record),
    clearPartitionSession: async (instanceId) => {
      const record = await instanceStore.get(instanceId)
      // 否则「先停隧道再清 Cookie」会静默 no-op
      const plan = planPartitionClear(record, tunnels?.statusOf(instanceId)?.port)
      if (!plan) return
      const target = session.fromPartition(plan.partition)
      await clearSessionCookie(target.cookies, { origin: plan.origin, basePath: plan.basePath })
    },
    promptBroker: promptBroker as PromptBroker,
    openInstanceView: async (instance, url) => {
      // Write the session Cookie before navigation starts.
      const plan = buildOpenViewPlan(url, auth?.sessionCookie(instance.id) ?? null)
      await openInstanceViewFlow(
        {
          createWindow: () => workspaceHost.prepare(instance.id, url),
          installIntercept: (win) => {
            const targetSession = win.webContents.session
            if (!shouldInstallIntercept(targetSession)) return
            targetSession.webRequest.onHeadersReceived((details, callback) => {
              // 默认 '/' 只能匹配根路径实例,带路径的实例(如 /dsh)永不产生信号
              const signal = classifyViewResponse(plan, {
                statusCode: details.statusCode,
                headers: details.responseHeaders ?? {},
                resourceType: details.resourceType
              })
              if (signal) {
                if (signal === 'session-expired' && auth && !reprobeInFlight.has(instance.id)) {
                  reprobeInFlight.add(instance.id)
                  void authProbeController
                    ?.probe(instance.id)
                    .then((state) => {
                      if (state?.phase === 'connected') workspaceHost.reload()
                    })
                    .catch((error: unknown) => console.error('[main] 静默重探失败：', error))
                    .finally(() => reprobeInFlight.delete(instance.id))
                }
                // 只发给 hub 窗口:实例窗口无 preload,收到也无消费者
                const hubWindow = windowController.getHubWindow()
                if (hubWindow && !hubWindow.isDestroyed()) {
                  hubWindow.webContents.send(AUTH_IPC.signal, {
                    instanceId: instance.id,
                    signal,
                    at: new Date().toISOString()
                  })
                }
              }
              callback({ responseHeaders: details.responseHeaders ?? {} })
            })
          }
        },
        {
          url: plan.url,
          origin: plan.origin,
          basePath: plan.basePath,
          // origin 不可解析时 plan.cookie 已为 null(避免写坏分区 Cookie)
          cookie: plan.cookie
        }
      )
    }
  })

  windowController.createWindow()
  windowController.installApplicationMenu()

  runtimeController.startAutoStart()

  app.on('activate', (_event, hasVisibleWindows) => {
    focusDebug(`[index] app.activate hasVisibleWindows=${String(hasVisibleWindows)}`)
    // 仅当没有可见窗口（最小化到托盘或窗口已销毁）时才召回：此时 showHubWindow 的
    // show()+focus() 是用户期望的「从托盘恢复」。窗口已可见时不再强制 show()+focus()——
    // activate 可能由非用户操作触发（日志实测 hasVisibleWindows=true 反复出现），
    // 强行置顶会把已可见窗口顶到最前、抢走其它应用（如如流）的焦点；
    // 真正的 Dock 点击由 macOS 自行把应用带回前台，无需我们再抢。
    if (!hasVisibleWindows) windowController.showHubWindow()
  })

  app.on('browser-window-created', (_event, win) => {
    win.on('closed', () => {
      if (BrowserWindow.getAllWindows().filter((other) => !other.isDestroyed()).length === 0) {
        promptBroker?.cancelAll()
      }
    })
  })
})

app.on('before-quit', (event) => {
  workspaceTooltipHost.close()
  gracefulQuit.handleBeforeQuit(event)
})

app.on('window-all-closed', () => {
  // 全部窗口关闭:先收敛待答请求(macOS 进程可能驻留,请求不能悬着)
  promptBroker?.cancelAll()
  if (process.platform !== 'darwin') app.quit()
})
