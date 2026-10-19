/**
 * 插件命令要用的 dsh 可执行入口解析。
 *
 * 判据与启动路径共用 dsh-source-policy：公共空间 + 自定义启动器（dush/duush）固定跟随
 * 系统 dsh（PATH 实测），其余走 planRuntimeSource。
 *
 * 版本必须与真正执行命令的副本一致：dsh 的插件安装闸按自身版本判定 peer，若检查阶段用注册表
 * 版本、执行阶段却落到另一个 hub 副本，就会出现「检查说可升级、安装被 dsh 拒绝」。
 */
import type { LocalInstance } from '@shared/contracts'
import { InstanceStoreError } from '../registry/instance-store'
import { followsSystemDsh } from './dsh-source-policy'
import { compareDshVersions } from './version-compare'
import { planRuntimeSource, type PathProbe } from './runtime-source'
import type { InstalledRuntime, RuntimeInstaller } from './runtime-installer'

/** dsh 可执行入口与其版本；版本用于 peer 兼容判定与 `--dsh-version` 豁免。 */
export interface DshCommandEntry {
  entry: string
  version: string
}

export interface DshEntryDeps {
  installer: RuntimeInstaller
  pathProbe?: PathProbe
}

/**
 * 解析插件命令要用的 dsh 入口及其版本。
 *
 * 插件命令不触发运行时下载：固定版本未装、或系统 dsh 未探到时回落 hub 已装的最新副本
 * （与实例的 hub 归属一致，判定宁可拦下不误放行），再回落 PATH 实测。
 */
export function createDshEntryResolver(deps: DshEntryDeps) {
  return async function resolveDshEntry(instance: LocalInstance): Promise<DshCommandEntry> {
    const followSystemDsh = followsSystemDsh(instance.useDefaultSpace, instance.launcher)
    const [installed, pathRuntime] = await Promise.all([
      // 跟随系统 dsh 时 hub 副本不参与决策（与启动路径一致：不装副本、不理会固定版本）。
      followSystemDsh
        ? Promise.resolve([] as InstalledRuntime[])
        : deps.installer.listInstalled().catch(() => [] as InstalledRuntime[]),
      deps.pathProbe ? deps.pathProbe.probe().catch(() => null) : Promise.resolve(null)
    ])
    const plan = followSystemDsh
      ? pathRuntime === null
        ? null
        : { kind: 'path' as const, command: pathRuntime.command, version: pathRuntime.version }
      : planRuntimeSource({
          desiredVersion: instance.dshVersion,
          hubInstalled: installed.map((item) => item.version),
          pathRuntime
        })
    if (plan?.kind === 'path') return { entry: plan.command, version: plan.version }
    if (plan?.kind === 'hub') {
      const hit = installed.find((item) => item.version === plan.version)
      if (hit) return { entry: hit.entry, version: hit.version }
    }
    const newest = [...installed].sort((a, b) => compareDshVersions(a.version, b.version)).at(-1)
    if (newest !== undefined) return { entry: newest.entry, version: newest.version }
    if (pathRuntime !== null) return { entry: pathRuntime.command, version: pathRuntime.version }
    throw new InstanceStoreError(
      'invalid-state',
      '未找到可用的 dsh：hub 隔离目录与 PATH 上都没有已安装的运行时'
    )
  }
}
