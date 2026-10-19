/**
 * npm spec 的安装目标规划：查 registry 得到目标版本、peer 范围与发布时间。
 *
 * 用户写死精确版本时只查该版本；裸名与 dist-tag 走一次多字段查询，按「dist-tag latest
 * 与最大稳定版的较大者」取目标——dist-tag 滞后时不能装到旧版。目标版本与查询返回的版本
 * 不一致时补查一次，保证 peer 与发布时间都是目标版本的口径。
 *
 * 运行时入口、已装列表、命令执行与 registry 元数据读取由调用方注入，本模块不感知
 * 实例目录布局与状态存储。
 */
import type {
  LocalInstance,
  PluginInfo,
  PluginInstallPlan,
  PluginRegistryOption
} from '@shared/contracts'
import { InstanceStoreError } from '../registry/instance-store'
import { dshPeerRange, peersCompatible } from './peer-compatibility'
import type { DshCommandEntry } from './plugin-dsh-entry'
import {
  installedVersionOf,
  isVersionLiteral,
  pickTargetVersion,
  splitNpmSpec
} from './plugin-spec'
import {
  isRegistryNotFound,
  parseViewMeta,
  peerMapOf,
  publishedAtOf,
  publishedTimeMap,
  recordOf,
  stringArrayOf
} from './plugin-view-meta'
import type { CommandResult } from './exec-file'

export interface InstallPlanDeps {
  /** 解析插件命令要用的 dsh 入口及其版本（与启动路径同一判据，见 plugin-dsh-entry）。 */
  resolveDshEntry(instance: LocalInstance): Promise<DshCommandEntry>
  /** 已装插件列表（用于给出「将替换」提示）；locale 固定 zh，此处只读版本与名字。 */
  listPlugins(
    instance: LocalInstance,
    locale: 'zh',
    resolved: DshCommandEntry
  ): Promise<PluginInfo[]>
  /** 在实例的 dsh 环境里运行 plugin 子命令。 */
  runPlugin(
    instance: LocalInstance,
    args: string[],
    resolved: DshCommandEntry,
    registry?: PluginRegistryOption
  ): Promise<CommandResult>
  /** 查某个精确版本的 peer 范围与发布时间。 */
  viewVersionMeta(
    instance: LocalInstance,
    name: string,
    version: string,
    resolved: DshCommandEntry,
    registry: PluginRegistryOption
  ): Promise<{ peers: Record<string, string>; publishedAt: string | null }>
}

export function createInstallPlanResolver(deps: InstallPlanDeps) {
  return async function planNpmInstall(
    instance: LocalInstance,
    input: string,
    registry: PluginRegistryOption
  ): Promise<PluginInstallPlan> {
    const resolved = await deps.resolveDshEntry(instance)
    const { name, requested } = splitNpmSpec(input)
    const installedVersion = installedVersionOf(
      await deps.listPlugins(instance, 'zh', resolved),
      name
    )

    // 用户显式指定了精确版本：只查该版本的 peer 与发布时间（同时校验它确实存在）。
    if (requested !== null && isVersionLiteral(requested)) {
      const { peers, publishedAt } = await deps.viewVersionMeta(
        instance,
        name,
        requested,
        resolved,
        registry
      )
      return {
        installSpec: `${name}@${requested}`,
        input,
        kind: 'npm',
        packageName: name,
        targetVersion: requested,
        latestVersion: null,
        versionSource: 'requested',
        publishedAt,
        dshPeer: dshPeerRange(peers),
        dshVersion: resolved.version,
        compatible: peersCompatible(peers, resolved.version),
        installedVersion
      }
    }

    // 裸名或 dist-tag：一次查询拿版本集合、dist-tags、peer 与发布时间（多字段时 time 嵌套在
    // `time` 键下，publishedTimeMap 兼容两种形状）。
    let result: CommandResult
    try {
      result = await deps.runPlugin(
        instance,
        ['view', name, 'version', 'versions', 'dist-tags', 'peerDependencies', 'time', '--json'],
        resolved,
        registry
      )
    } catch (error) {
      if (isRegistryNotFound(error)) {
        throw new InstanceStoreError(
          'not-found',
          `无法解析版本：插件 ${name} 未发布到 npm registry`
        )
      }
      throw error
    }
    const meta = parseViewMeta(result.stdout)
    const distTags = recordOf(meta['dist-tags'])
    const latestVersion =
      typeof distTags.latest === 'string' && distTags.latest !== '' ? distTags.latest : null
    const viewed = typeof meta.version === 'string' && meta.version !== '' ? meta.version : null

    let target: string
    let versionSource: PluginInstallPlan['versionSource']
    if (requested !== null && requested !== 'latest') {
      // 具名 dist-tag（next / beta…）：装该标签指向的版本，用户要的就是这个渠道。
      const tagged = distTags[requested]
      if (typeof tagged !== 'string' || tagged === '') {
        throw new InstanceStoreError('not-found', `registry 没有标签 ${requested}：${name}`)
      }
      target = tagged
      versionSource = 'requested'
    } else {
      // 未指定版本，或写的就是 `latest`：`latest` 只是「最新」的惯用写法，与裸名同口径
      // 取「dist-tag latest 与最大稳定版的较大者」——dist-tag 滞后时不能装到旧版。
      const picked = pickTargetVersion(stringArrayOf(meta.versions), latestVersion, viewed)
      if (picked === null) throw new InstanceStoreError('internal', '无法解析插件版本信息输出')
      target = picked
      versionSource = requested === null ? 'resolved-latest' : 'requested'
    }

    // peer 与发布时间必须是目标版本的口径：与本次查询返回的版本不一致时补一次查询。
    let peers = peerMapOf(meta)
    let publishedAt = publishedAtOf(publishedTimeMap(result.stdout), target)
    if (target !== viewed) {
      const detail = await deps.viewVersionMeta(instance, name, target, resolved, registry)
      peers = detail.peers
      publishedAt = detail.publishedAt
    }

    return {
      installSpec: `${name}@${target}`,
      input,
      kind: 'npm',
      packageName: name,
      targetVersion: target,
      latestVersion,
      versionSource,
      publishedAt,
      dshPeer: dshPeerRange(peers),
      dshVersion: resolved.version,
      compatible: peersCompatible(peers, resolved.version),
      installedVersion
    }
  }
}
