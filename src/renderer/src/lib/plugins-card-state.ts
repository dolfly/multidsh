/**
 * 插件卡片的纯展示派生（保持无副作用，便于测试）：升级按钮是否可见、检查结果文案分支、
 * 改动生效方式与安装来源的文案选择。UI 组件只消费这里的判定结果，不内联条件逻辑。
 */
import type { PluginCheckSnapshot, PluginInfo, PluginUpdateCheck } from '@shared/contracts'
import type { MessageKey } from '@shared/i18n/messages'

/** 单个插件行的检查态：未检查 / 检查中 / 已出结果 / 检查失败。 */
export interface PluginCheckState {
  status: 'idle' | 'checking' | 'done' | 'error'
  result: PluginUpdateCheck | null
  error: string | null
}

export const initialCheckState: PluginCheckState = { status: 'idle', result: null, error: null }

/**
 * 按最新插件名集合剪除检查结果映射：安装/升级/卸载后刷新列表时保留仍在册插件的检查状态，
 * 只丢弃已卸载插件的项。纯函数便于测试。
 */
export function pruneChecks(
  checks: Record<string, PluginCheckState>,
  presentNames: Iterable<string>
): Record<string, PluginCheckState> {
  const present = new Set(presentNames)
  const next: Record<string, PluginCheckState> = {}
  for (const [name, state] of Object.entries(checks)) {
    if (present.has(name)) next[name] = state
  }
  return next
}

/**
 * 由持久化快照与当前插件列表重建检查态（挂载时恢复标记）：
 * - 快照里有记录的插件：latest 与当前已装版本不同才算「有更新」（升级过就不再显示标记）；
 * - 快照里正在检查的插件：显示「检查中…」（后台仍在跑）；
 * - 其余插件：保持未检查。
 * 纯函数便于测试。
 */
export function restoreChecks(
  plugins: readonly PluginInfo[],
  snapshot: PluginCheckSnapshot | null
): Record<string, PluginCheckState> {
  const next: Record<string, PluginCheckState> = {}
  if (snapshot === null) return next
  const checking = new Set(snapshot.checking)
  for (const plugin of plugins) {
    if (checking.has(plugin.name)) {
      next[plugin.name] = { status: 'checking', result: null, error: null }
      continue
    }
    const record = snapshot.updates[plugin.name]
    // 记录只对「检查时的已装版本」有效：版本变了（hub 升级、手动安装/降级）旧结果即失效，
    // 否则会拿旧版本的候选信息当成本次结果（如已装 1.1.17 仍提示升级 1.1.15）。
    if (record === undefined || record.current !== plugin.version) continue
    next[plugin.name] = {
      status: 'done',
      result: {
        name: plugin.name,
        current: plugin.version,
        latest: record.latest,
        hasUpdate: true,
        compatible: record.compatible,
        dshPeer: record.dshPeer,
        dshVersion: record.dshVersion,
        // 持久化的可升级标记不带发布时间：该字段由 PluginInfo.publishedAt（主进程按版本回填）提供。
        publishedAt: null
      },
      error: null
    }
  }
  return next
}

/** 是否展示「升级到 x」按钮：检查完成、有新版且兼容。 */
export function canOfferUpgrade(check: PluginCheckState): boolean {
  return (
    check.status === 'done' &&
    check.result !== null &&
    check.result.hasUpdate &&
    check.result.compatible
  )
}

/** 是否展示不兼容警告：检查完成、有新版但不兼容。 */
export function showsIncompatibleWarning(check: PluginCheckState): boolean {
  return (
    check.status === 'done' &&
    check.result !== null &&
    check.result.hasUpdate &&
    !check.result.compatible
  )
}

/**
 * 是否「无法判定」而非「确定不兼容」：不兼容且有新版，但执行检查所用 dsh 版本未知。
 * 主进程对未知版本一律 fail-closed（compatible=false），此处让 UI 区分两义，不谎报结论。
 */
export function showsUnknownCompatibility(check: PluginCheckState): boolean {
  return (
    showsIncompatibleWarning(check) &&
    check.result !== null &&
    check.result.dshVersion === null
  )
}

/** 是否展示「已是最新」：检查完成且无新版。 */
export function showsUpToDate(check: PluginCheckState): boolean {
  return check.status === 'done' && check.result !== null && !check.result.hasUpdate
}

/** 一次检查结果写入底部信息栏时的归类。 */
export type CheckOutcome = 'update' | 'incompatible' | 'none'

/**
 * 把检查结果归入信息栏要记录的三类（纯函数，便于测试）：
 * - `update`：有新版且兼容，可升级；
 * - `incompatible`：有新版但不兼容（含 dsh 版本未知的无法判定），属于异常信息；
 * - `none`：无新版或没有结果，不记录，避免每次检查都刷一行。
 */
export function classifyCheckOutcome(result: PluginUpdateCheck | null): CheckOutcome {
  if (result === null || !result.hasUpdate) return 'none'
  return result.compatible ? 'update' : 'incompatible'
}

/**
 * 插件改动后的提示方案（纯函数，便于测试）。
 *
 * 判据来自 dsh 的 ChangeResult.application（dsh plugin CLI 不返回，由主进程按同一规则推断）：
 * - 实例未运行 → 改动已保存，下次启动生效（没有运行中的 Host 可重启）；
 * - `applied` → 已热生效，无需重启；
 * - `restart-required` → 需重启实例（profile 无 HMR；替换/升级已装包同样热生效，无特例）。
 */
export type PluginApplyNotice = 'saved' | 'applied' | 'restart-required'

export function pluginApplyNotice(input: {
  /** 实例当前是否运行中。 */
  running: boolean
  /** 主进程按 dsh 规则算出的生效结果。 */
  application: 'applied' | 'restart-required'
}): PluginApplyNotice {
  if (!input.running) return 'saved'
  return input.application
}

/** 安装来源的 i18n 键选择。 */
export function pluginSourceKey(source: PluginInfo['installSource']): MessageKey {
  switch (source) {
    case 'npm':
      return 'detail.plugin.source.npm'
    case 'github':
      return 'detail.plugin.source.github'
    case 'file':
      return 'detail.plugin.source.file'
    default:
      return 'detail.plugin.source.unknown'
  }
}
