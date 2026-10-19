/**
 * registry 元数据读取：把「查某个插件版本的 peer 范围、发布时间与仓库地址」从插件管理器
 * 的工厂闭包里独立出来。
 *
 * 命令执行与默认安装源由调用方注入，本模块不感知实例目录布局与状态存储。
 */
import type { LocalInstance } from '@shared/contracts'
import type { PluginRegistryOption } from '@shared/settings'
import { InstanceStoreError } from '../registry/instance-store'
import type { CommandResult } from './exec-file'
import {
  parseViewMeta,
  peerMapOf,
  publishedAtOf,
  publishedTimeMap,
  recordOf
} from './plugin-view-meta'
import { githubUrlFrom } from './peer-compatibility'

export interface RegistryMetadataDeps {
  /** 在实例的 dsh 环境里运行 plugin 子命令。 */
  runPlugin(
    instance: LocalInstance,
    args: string[],
    resolved: { entry: string; version: string },
    registry?: PluginRegistryOption
  ): Promise<CommandResult>
  /** 未显式指定安装源时的默认档位。 */
  defaultRegistry(): PluginRegistryOption
  /** registry 查无此包时抛出的错误判别。 */
  isRegistryNotFound(error: unknown): boolean
}

export interface RegistryMetadataReader {
  /** 查某个精确版本的 peer 范围与发布时间；版本不存在时抛 not-found。 */
  viewVersionMeta(
    instance: LocalInstance,
    name: string,
    version: string,
    resolved: { entry: string; version: string },
    registry: PluginRegistryOption
  ): Promise<{ peers: Record<string, string>; publishedAt: string | null }>
  /** 从 registry 元数据推导插件仓库地址；查不到按「没有仓库」处理。 */
  resolveRepositoryUrl(
    instance: LocalInstance,
    name: string,
    version: string,
    resolved: { entry: string; version: string }
  ): Promise<string | null>
}

export function createRegistryMetadataReader(deps: RegistryMetadataDeps): RegistryMetadataReader {
  return {
    async viewVersionMeta(instance, name, version, resolved, registry) {
      let result: CommandResult
      try {
        result = await deps.runPlugin(
          instance,
          ['view', `${name}@${version}`, 'peerDependencies', 'time', '--json'],
          resolved,
          registry
        )
      } catch (error) {
        if (deps.isRegistryNotFound(error))
          throw new InstanceStoreError('not-found', `版本不存在：${name}@${version}`)
        throw error
      }
      return {
        peers: peerMapOf(parseViewMeta(result.stdout)),
        publishedAt: publishedAtOf(publishedTimeMap(result.stdout), version)
      }
    },

    /** 命令失败与解析失败都按「没有仓库」处理：确认区只需降级到 npm 包页，不需要错误。 */
    async resolveRepositoryUrl(instance, name, version, resolved) {
      try {
        const result = await deps.runPlugin(
          instance,
          ['view', `${name}@${version}`, 'repository', 'homepage', '--json'],
          resolved,
          deps.defaultRegistry()
        )
        const parsed: unknown = JSON.parse(result.stdout || '{}')
        const meta = recordOf(parsed)
        return githubUrlFrom(meta.repository ?? meta.homepage ?? null)
      } catch {
        return null
      }
    }
  }
}
