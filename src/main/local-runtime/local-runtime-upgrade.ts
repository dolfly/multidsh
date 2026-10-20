/**
 * 本机实例的 dsh 版本升级编排。
 *
 * 升级对象经 dsh-source-policy 判定，与版本检查、启动路径共用同一判据：
 * 结论为「系统默认 dsh」时升级全局 npm 安装，所有共用该 dsh 的实例与终端都会跟随，
 * 因此必须先二次确认。拒绝时直接返回，不产生任何进度事件、不改任何状态；
 * 探测与安装布局判定在确认之前完成，注定失败的升级不先打扰用户。
 * 其余情况（隔离空间，或公共空间实际跑 hub 副本）都升级 hub 自己的运行时。
 */
import type { DshVersionProgressEvent, LocalInstance } from '@shared/contracts'
import type { InstallProgress } from './runtime-installer'
import type { RuntimeInstaller } from './runtime-installer'
import { isExternalRuntime, resolveSystemDshUsage } from './dsh-source-policy'
import { InstanceStoreError, type InstanceStore } from '../registry/instance-store'
import type { PathProbe } from './runtime-source'
import type { LocalRuntimeManager } from './local-runtime'

export interface UpgradeOrchestratorDeps {
  installer: RuntimeInstaller
  pathProbe?: PathProbe
  /** 升级编排完成后回写 dshVersion。 */
  store: Pick<InstanceStore, 'update'>
  /** 系统默认 dsh 的二次确认；缺省视为拒绝。 */
  confirmSystemUpgrade?: (latest: string, current: string) => Promise<boolean>
  /** 升级进度发布。 */
  emitUpgrade(event: DshVersionProgressEvent): void
  /** 单飞守卫：同一实例的升级进行中重复触发直接忽略。 */
  upgradingIds: Set<string>
  now: () => number
  /**
   * 生命周期访问：升级过程中要停旧进程、装完原样重启、查当前状态。
   * 由管理器构造完成后注入（升级只在被调用时才用到），避免与工厂自引用。
   */
  lifecycle: () => Pick<LocalRuntimeManager, 'statusOf' | 'stop' | 'start'>
}

export function createUpgradeOrchestrator(deps: UpgradeOrchestratorDeps) {
  const { installer, pathProbe, store, confirmSystemUpgrade, emitUpgrade, upgradingIds, now } = deps

  return async function upgradeInstance(instance: LocalInstance): Promise<void> {
    const id = instance.id
    // 单飞守卫：同一实例的升级进行中重复触发直接忽略，避免并发写同一隔离目录。
    if (upgradingIds.has(id)) return
    upgradingIds.add(id)
    const at = (): string => new Date(now()).toISOString()
    /**
     * 升级主序列：运行中先停 → 下载安装 → 回写版本 → 原样重启，末尾 done=100。
     * 两条升级路径共用；`checking` 由各分支自行发出 —— 系统升级要等二次确认之后
     * 才有进度，隔离升级则要在解析版本之前就给出反馈。
     */
    const runUpgrade = async (
      version: string,
      install: (onProgress: (progress: InstallProgress) => void) => Promise<unknown>
    ): Promise<void> => {
      const lifecycle = deps.lifecycle()
      const wasRunning = lifecycle.statusOf(id)?.status === 'running'
      if (wasRunning) await lifecycle.stop(id)
      emitUpgrade({ instanceId: id, phase: 'downloading', version, at: at() })
      await install((progress) => {
        emitUpgrade({
          instanceId: id,
          phase: 'installing',
          version,
          detail: progress.detail,
          at: at()
        })
      })
      await store.update(id, { dshVersion: version })
      if (wasRunning) await lifecycle.start({ ...instance, dshVersion: version })
      emitUpgrade({ instanceId: id, phase: 'done', version, at: at() })
    }
    try {
      const runtimeSource = deps.lifecycle().statusOf(id)?.runtimeSource
      if (isExternalRuntime(runtimeSource)) {
        throw new InstanceStoreError(
          'invalid-state',
          '外部接管的 dsh 进程归用户所有，hub 不能代管升级'
        )
      }
      const decision = await resolveSystemDshUsage({
        transport: instance.transport,
        useDefaultSpace: instance.useDefaultSpace,
        launcher: instance.launcher,
        runtimeSource,
        desiredVersion: instance.dshVersion,
        listInstalledVersions: async () => {
          try {
            return (await installer.listInstalled()).map((item) => item.version)
          } catch {
            return [] as string[]
          }
        },
        probePath: async () => (await pathProbe?.probe().catch(() => null)) ?? null
      })
      if (decision.usesSystemDsh) {
        const newest = await installer.resolveLatestVersion()
        const system = decision.pathRuntime
        if (system === null) {
          throw new Error('未找到系统默认 dsh（PATH 上没有可用的 dsh），无法升级')
        }
        const prefix = await installer.resolveGlobalPrefix(system.command)
        if (prefix === null) {
          throw new Error(`系统 dsh 不是 npm 全局安装（${system.command}），hub 无法代管升级`)
        }
        const confirmed = await confirmSystemUpgrade?.(newest, system.version)
        if (confirmed !== true) return
        emitUpgrade({ instanceId: id, phase: 'checking', at: at() })
        await runUpgrade(newest, (onProgress) =>
          installer.installGlobal(prefix, newest, onProgress)
        )
        return
      }
      emitUpgrade({ instanceId: id, phase: 'checking', at: at() })
      const latest = await installer.resolveLatestVersion()
      await runUpgrade(latest, (onProgress) => installer.ensureInstalled(latest, onProgress))
    } catch (error) {
      emitUpgrade({
        instanceId: id,
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
        at: at()
      })
    } finally {
      upgradingIds.delete(id)
    }
  }
}
