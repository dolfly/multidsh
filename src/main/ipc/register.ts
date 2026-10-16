/**
 * 注册 IPC 白名单通道（preload 再暴露一层）。
 * 非法入参返回 `IpcResult` 错误信封而非抛异常。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '@shared/bridge'
import type { InstanceRecord, IpcResult, WorkspaceViewBounds } from '@shared/contracts'
import type { Settings } from '@shared/settings'
import { HomepageOpenError } from '../shell/open-homepage'
import type { InstanceStore } from '../registry/instance-store'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import type { ExternalDshScanner } from '../local-runtime/external-dsh'
import type { PathProbe } from '../local-runtime/runtime-source'
import type { RuntimeInstaller } from '../local-runtime/runtime-installer'
import type { PluginManager } from '../local-runtime/plugin-manager'
import type { SshTunnelManager } from '../transport/ssh-tunnel'
import type { HttpEndpointManager } from '../transport/http-endpoint'
import type { PromptBroker } from '../ssh/prompt-broker'
import type { AuthRegistry } from '../auth/auth-registry'
import type { Vault } from '../vault/vault'
import type { SettingsStore } from '../settings/settings-store'
import type { AuditEntry } from '../audit/audit-log'
import { registerAppHandlers } from './app-handlers'
import { registerHttpHandlers } from './http-handlers'
import { registerSettingsHandlers } from './settings-handlers'
import { registerInstanceHandlers } from './instance-handlers'
import { registerRuntimeHandlers } from './runtime-handlers'
import { registerAuthHandlers, type AuthProbeController } from './auth-handlers'
import { registerVaultHandlers } from './vault-handlers'
import { registerVersionHandlers } from './version-handlers'
import { registerPluginHandlers } from './plugin-handlers'
import { wrap, type ExternalAccessUrls } from './ipc-utils'

export type { AuthProbeController }

/** 运行时与传输通道（启停/重启/扫描/接管）依赖。 */
export interface RuntimeDeps {
  runtime: LocalRuntimeManager
  tunnels: SshTunnelManager
  http: HttpEndpointManager
  /**
   * 缺省不装配(单测)→ scan 返回空列表、adopt 一律 invalid-state。
   */
  externalDshScanner?: ExternalDshScanner
  /** 只读探测本机可执行 dsh，供创建向导选择是否使用。 */
  pathProbe?: PathProbe
  /** 用户显式提供的外部本机 dsh token 必须通过本机端点验收后才持久化。 */
  verifyExternalAccess?: (url: string) => Promise<boolean>
}

/** 打开与隐藏实例工作区的视图通道依赖。 */
export interface InstanceViewDeps {
  /**
   * 打开实例视图窗口（electron 侧实现，便于 register 单测注入假实现）。
   * 调用方必须 await —— 否则 IPC 会在视图真正就绪前返回。
   */
  openInstanceView: (instance: InstanceRecord, url: string) => Promise<void>
  /** 刷新指定实例已缓存的内嵌工作区：注入最新会话 Cookie 并导航回工作区 URL；未缓存时为空操作。 */
  reloadInstanceView?: (instanceId: string) => Promise<void>
  /** 在系统默认浏览器中打开 URL；地址由主进程解析并按协议白名单校验，渲染层只触发动作。 */
  openExternalUrl?: (url: string) => Promise<void>
  /** 隐藏当前内嵌工作区，不向渲染层暴露访客 WebContents。 */
  hideInstanceView?: () => void
  /** 销毁指定实例的内嵌工作区，不停止运行时或清除认证状态。 */
  closeInstanceView?: (instanceId: string) => void
  /** 主进程应用经校验的内容区边界。 */
  setInstanceViewBounds?: (bounds: WorkspaceViewBounds) => void
  /** 工作区原生视图之上的只读提示；文本与坐标由 schema 限制。 */
  showInstanceTooltip?: (tooltip: { text: string; x: number; y: number }) => Promise<void>
  hideInstanceTooltip?: () => void
  /**
   * 已缓存实例视图当前停在哪（只读）。缺省视为「无缓存视图」。
   * 用于判断本次打开是否真的会导航，从而决定认证探测要不要进入等待路径。
   */
  instanceViewUrl?: (instanceId: string) => string | null
}

/** 认证通道依赖。 */
export interface AuthDeps {
  auth: AuthRegistry
  clearPartitionSession?: (instanceId: string) => Promise<void>
}

/** 保险库通道依赖。 */
export interface VaultDeps {
  vault: Vault
}

/** 设置与数据目录通道依赖。 */
export interface SettingsDeps {
  settings: SettingsStore
  /**
   * 缺省不执行(单测);落盘由本模块负责,副作用交给装配层。
   */
  onSettingsChanged?: (settings: Settings, changedKeys: readonly (keyof Settings)[]) => void
  /**
   *
   * **签名上没有路径参数**——目录由装配层自行解析(`DSH_HUB_DATA_DIR` /
   * `app.getPath('userData')`),渲染层无从指定,故不可能成为任意文件打开原语。
   * 缺省时该通道返回 internal 错误信封(单测不装配)。
   */
  openDataDir?: () => Promise<void>
}

/** 本地隔离空间通道依赖。 */
export interface SpaceDeps {
  /** 只列出 Hub 自己管理的隔离空间；调用方不能提供路径。 */
  listLocalSpaces?: () => Promise<Array<{ id: string; sizeBytes: number; modifiedAt: string }>>
  /** 将已验证的隔离空间移至系统废纸篓；调用方不能提供路径。 */
  trashLocalSpace?: (instanceId: string) => Promise<void>
  /** 本机实例的数据目录（展示用，主进程按平台分隔符拼装）；缺省时 summary 不带 localHome。 */
  localHomePath?: (record: InstanceRecord) => string
  /** 在系统文件管理器中打开本机实例的数据目录；调用方不能提供路径。 */
  openInstanceDir?: (record: InstanceRecord) => Promise<void>
  /** 在系统文件管理器中打开本机实例的日志目录；调用方不能提供路径。 */
  openInstanceLogDir?: (record: InstanceRecord) => Promise<void>
}

/** dsh 版本通道依赖。 */
export interface VersionDeps {
  /** dsh 版本安装器；缺省时 check/list 返回 internal 错误信封。 */
  installer?: RuntimeInstaller
}

/** dsh 插件管理通道依赖。 */
export interface PluginDeps {
  /** 插件管理器；缺省时插件通道返回 internal 错误信封。 */
  pluginManager?: PluginManager
}

/** 交互式提示通道（SSH 主机指纹/口令、升级确认）依赖。 */
export interface PromptDeps {
  promptBroker: PromptBroker
}

/** 审计写入依赖。 */
export interface AuditDeps {
  /**
   * 审计写入本身异步且失败隔离,不阻塞业务。
   */
  audit?: (entry: AuditEntry) => void
}

export interface IpcDeps
  extends RuntimeDeps,
    InstanceViewDeps,
    AuthDeps,
    VaultDeps,
    SettingsDeps,
    SpaceDeps,
    VersionDeps,
    PluginDeps,
    PromptDeps,
    AuditDeps {
  /**
   * 打开项目主页。
   *
   * **签名上没有 URL 参数**——地址由装配层固定为 `HOMEPAGE_URL`,渲染层只能触发
   * 「打开」动作本身,故不可能成为任意站点 / 任意协议打开原语。
   * 缺省时该通道返回 internal 错误信封(单测不装配)。
   */
  openHomepage?: () => Promise<void>
  /**
   * 打开应用内「关于」叠加窗口；无参数，窗口由装配层（WindowController）构造。
   * 缺省时该通道返回 internal 错误信封（单测不装配）。
   */
  openAbout?: () => void
}

export function registerIpc(store: InstanceStore, deps: IpcDeps): AuthProbeController {
  /** 外部 dsh 的 token URL 仅驻留在主进程会话内，绝不进入状态流或注册表。 */
  const externalAccessUrls: ExternalAccessUrls = new Map()
  const processVersions = process.versions as NodeJS.ProcessVersions & { electron?: string }
  registerAppHandlers(processVersions, wrap)

  // 关于 → 项目主页:空元组 schema 拒绝任何入参,URL 由主进程固定
  ipcMain.handle(
    IPC.openHomepage,
    (_event, ...args: unknown[]): Promise<IpcResult<null>> =>
      wrap(async () => {
        z.tuple([]).parse(args)
        if (!deps.openHomepage) throw new HomepageOpenError('internal', '打开项目主页不可用')
        await deps.openHomepage()
        return null
      })
  )

  // 关于面板：空元组 schema 拒绝任何入参，窗口由主进程构造
  ipcMain.handle(
    IPC.openAbout,
    (_event, ...args: unknown[]): Promise<IpcResult<null>> =>
      wrap(() => {
        z.tuple([]).parse(args)
        if (!deps.openAbout) throw new HomepageOpenError('internal', '打开关于面板不可用')
        deps.openAbout()
        return null
      })
  )

  const authProbe = registerAuthHandlers(deps, wrap)
  registerInstanceHandlers(store, deps, externalAccessUrls, wrap)
  registerRuntimeHandlers(store, deps, { externalAccessUrls, probe: authProbe.probe }, wrap)
  registerVersionHandlers(store, deps, wrap)
  registerPluginHandlers(store, { pluginManager: deps.pluginManager, openExternalUrl: deps.openExternalUrl }, wrap)
  registerVaultHandlers(deps, externalAccessUrls, wrap)

  registerSettingsHandlers(
    {
      settings: deps.settings,
      onSettingsChanged: deps.onSettingsChanged,
      openDataDir: deps.openDataDir,
      // 失效登录环境缓存并重解析：回传刷新前后的差异，以及正在运行、可由 hub
      // 重启的本机实例（外部接管的除外），供渲染层报告变化并提示重启生效。
      refreshEnvironment: async () => {
        const diff = await deps.runtime.refreshEnv()
        return {
          instances: deps.runtime
            .runningIds()
            .filter((id) => deps.runtime.statusOf(id)?.runtimeSource !== 'external'),
          diff
        }
      }
    },
    wrap
  )

  registerHttpHandlers(wrap)

  return authProbe
}
