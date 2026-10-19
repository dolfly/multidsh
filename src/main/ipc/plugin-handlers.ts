/**
 * dsh 插件管理通道（仅本机实例）：列表、检查升级、安装前版本解析、安装、包增强信息、升级、卸载，
 * 以及打开插件外链。
 *
 * profile 与 DSH_HOME 由 PluginManager 按实例推导，渲染层只提供实例 id 与受校验的包名/spec；
 * 安装源只接受档位枚举（URL 由主进程映射），外链打开只接受 https 且域名在白名单
 * （npmjs.com / github.com），交系统默认浏览器。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  DSH_VERSION_PATTERN,
  PLUGIN_INSTALL_OPTIONS_SCHEMA,
  PLUGIN_IPC,
  PLUGIN_NAME_SCHEMA,
  PLUGIN_REGISTRY_OPTIONS_SCHEMA,
  PLUGIN_SPEC_SCHEMA,
  type IpcResult,
  type LocalInstance,
  type PluginCheckSnapshot,
  type PluginEnableResult,
  type PluginInfo,
  type PluginInstallPlan,
  type PluginMutationResult,
  type PluginPackageInfo,
  type PluginUpdateCheck
} from '@shared/contracts'
import { InstanceStoreError, requireInstance, type InstanceStore } from '../registry/instance-store'
import type { PluginManager } from '../local-runtime/plugin-manager'
import { parseId, type IpcWrap } from './ipc-utils'
import { isAllowedPluginLink } from './plugin-link-policy'

/** 升级目标版本：与 dsh 版本号同字符集，长度封顶。 */
const PLUGIN_VERSION_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(DSH_VERSION_PATTERN, '版本号含非法字符')

/** 插件元信息本地化语言；非法值回落 zh。 */
const PLUGIN_LOCALE_SCHEMA = z.enum(['zh', 'en']).catch('zh')

export interface PluginHandlerDeps {
  /** 缺省不装配（单测）→ 全部通道返回 internal 错误信封。 */
  pluginManager?: PluginManager
  /** 打开外链（生产用 shell.openExternal）；缺省时 openExternal 返回 internal。 */
  openExternalUrl?: (url: string) => Promise<void>
}

export function registerPluginHandlers(
  store: InstanceStore,
  deps: PluginHandlerDeps,
  wrap: IpcWrap
): void {
  /** 取本机实例；非 local 一律拒绝（远程实例 v1 不做插件管理）。 */
  async function requireLocal(id: unknown): Promise<LocalInstance> {
    const record = await requireInstance(store, parseId(id))
    if (record.transport !== 'local') {
      throw new InstanceStoreError('invalid-input', '仅本机实例支持插件管理')
    }
    return record
  }

  ipcMain.handle(
    PLUGIN_IPC.list,
    (_event, id: unknown, locale: unknown): Promise<IpcResult<PluginInfo[]>> =>
      wrap(async () => {
        const instance = await requireLocal(id)
        if (!deps.pluginManager) throw new InstanceStoreError('internal', '插件管理能力不可用')
        return deps.pluginManager.list(instance, PLUGIN_LOCALE_SCHEMA.parse(locale))
      })
  )

  ipcMain.handle(
    PLUGIN_IPC.check,
    (_event, id: unknown, name: unknown): Promise<IpcResult<PluginUpdateCheck>> =>
      wrap(async () => {
        const instance = await requireLocal(id)
        const pluginName = PLUGIN_NAME_SCHEMA.parse(name)
        if (!deps.pluginManager) throw new InstanceStoreError('internal', '插件管理能力不可用')
        return deps.pluginManager.check(instance, pluginName)
      })
  )

  ipcMain.handle(
    PLUGIN_IPC.checkState,
    (_event, id: unknown): Promise<IpcResult<PluginCheckSnapshot>> =>
      wrap(async () => {
        const instance = await requireLocal(id)
        if (!deps.pluginManager) throw new InstanceStoreError('internal', '插件管理能力不可用')
        return deps.pluginManager.checkState(instance)
      })
  )

  ipcMain.handle(
    PLUGIN_IPC.resolveInstall,
    (_event, id: unknown, spec: unknown, options: unknown): Promise<IpcResult<PluginInstallPlan>> =>
      wrap(async () => {
        const instance = await requireLocal(id)
        const pluginSpec = PLUGIN_SPEC_SCHEMA.parse(spec)
        const parsedOptions = PLUGIN_REGISTRY_OPTIONS_SCHEMA.parse(options ?? {})
        if (!deps.pluginManager) throw new InstanceStoreError('internal', '插件管理能力不可用')
        return deps.pluginManager.resolveInstall(instance, pluginSpec, parsedOptions)
      })
  )

  ipcMain.handle(
    PLUGIN_IPC.install,
    (
      _event,
      id: unknown,
      spec: unknown,
      options: unknown
    ): Promise<IpcResult<PluginMutationResult>> =>
      wrap(async () => {
        const instance = await requireLocal(id)
        const pluginSpec = PLUGIN_SPEC_SCHEMA.parse(spec)
        const parsedOptions = PLUGIN_INSTALL_OPTIONS_SCHEMA.parse(options ?? {})
        if (!deps.pluginManager) throw new InstanceStoreError('internal', '插件管理能力不可用')
        return deps.pluginManager.install(instance, pluginSpec, parsedOptions)
      })
  )

  ipcMain.handle(
    PLUGIN_IPC.packageInfo,
    (_event, id: unknown, name: unknown, version: unknown): Promise<IpcResult<PluginPackageInfo>> =>
      wrap(async () => {
        const instance = await requireLocal(id)
        const pluginName = PLUGIN_NAME_SCHEMA.parse(name)
        const targetVersion = PLUGIN_VERSION_SCHEMA.parse(version)
        if (!deps.pluginManager) throw new InstanceStoreError('internal', '插件管理能力不可用')
        return deps.pluginManager.packageInfo(instance, pluginName, targetVersion)
      })
  )

  ipcMain.handle(
    PLUGIN_IPC.upgrade,
    (
      _event,
      id: unknown,
      name: unknown,
      version: unknown,
      options: unknown
    ): Promise<IpcResult<PluginMutationResult>> =>
      wrap(async () => {
        const instance = await requireLocal(id)
        const pluginName = PLUGIN_NAME_SCHEMA.parse(name)
        const targetVersion = PLUGIN_VERSION_SCHEMA.parse(version)
        const parsedOptions = PLUGIN_REGISTRY_OPTIONS_SCHEMA.parse(options ?? {})
        if (!deps.pluginManager) throw new InstanceStoreError('internal', '插件管理能力不可用')
        return deps.pluginManager.upgrade(instance, pluginName, targetVersion, parsedOptions)
      })
  )

  ipcMain.handle(
    PLUGIN_IPC.remove,
    (_event, id: unknown, name: unknown): Promise<IpcResult<PluginMutationResult>> =>
      wrap(async () => {
        const instance = await requireLocal(id)
        const pluginName = PLUGIN_NAME_SCHEMA.parse(name)
        if (!deps.pluginManager) throw new InstanceStoreError('internal', '插件管理能力不可用')
        return deps.pluginManager.remove(instance, pluginName)
      })
  )

  ipcMain.handle(
    PLUGIN_IPC.setEnabled,
    (
      _event,
      id: unknown,
      name: unknown,
      enabled: unknown
    ): Promise<IpcResult<PluginEnableResult>> =>
      wrap(async () => {
        const instance = await requireLocal(id)
        const pluginName = PLUGIN_NAME_SCHEMA.parse(name)
        const wantEnabled = z.boolean().parse(enabled)
        if (!deps.pluginManager) throw new InstanceStoreError('internal', '插件管理能力不可用')
        return deps.pluginManager.setEnabled(instance, pluginName, wantEnabled)
      })
  )

  ipcMain.handle(PLUGIN_IPC.openExternal, (_event, url: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const target = typeof url === 'string' ? url : ''
      if (!isAllowedPluginLink(target)) {
        throw new InstanceStoreError(
          'invalid-input',
          '链接必须是 npmjs.com 或 github.com 的 https 地址'
        )
      }
      if (!deps.openExternalUrl) throw new InstanceStoreError('internal', '打开外链不可用')
      await deps.openExternalUrl(target)
      return null
    })
  )
}
