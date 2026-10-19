/**
 * 插件检查状态的持久化合并。
 *
 * 只负责把「一次检查/升级/卸载的结果」并回 `PluginStateStore`，不发起任何命令：
 * - 有新版记下候选信息，已是最新删掉该项（标记「直到用户再次检查或升级才变」由此保证）；
 * - 发布时间按「已装版本」存快照（发布后不变，之后一直复用，下次检查再刷新）；
 *   registry 未收录该版本时（published 为 null）保留原快照，显示端只在版本号一致时才读它。
 */
import type { PluginCheckRecord } from '@shared/contracts'
import type { PluginCheckState, PluginPublishedSnapshot, PluginStateStore } from './plugin-state'

export interface CheckStateWriter {
  /** 状态落盘失败不影响本次检查/改动结果：只是重启后看不到标记。 */
  writeState(instanceId: string, state: PluginCheckState): Promise<void>
  /** 把一次检查结果并入持久化状态，并刷新「上次检查」时刻。 */
  persistCheck(
    instanceId: string,
    name: string,
    record: PluginCheckRecord | null,
    published: PluginPublishedSnapshot | null
  ): Promise<void>
  /** 该插件的检查痕迹随卸载失效：可升级标记与发布时间快照一并丢弃（不刷新「上次检查」时刻）。 */
  dropCheck(instanceId: string, name: string): Promise<void>
  /**
   * 升级完成后同步该插件的检查痕迹：清掉可升级标记（已装版本已是目标版本），并把 `published`
   * 落成快照。取不到发布时间（如离线）时清掉旧版本的陈旧快照，由下次检查补齐。
   */
  syncCheckAfterUpgrade(
    instanceId: string,
    name: string,
    published: PluginPublishedSnapshot | null
  ): Promise<void>
}

export function createCheckStateWriter(stateStore: PluginStateStore): CheckStateWriter {
  /** 状态落盘失败不影响本次检查/改动结果：只是重启后看不到标记。 */
  async function writeState(instanceId: string, state: PluginCheckState): Promise<void> {
    await stateStore.write(instanceId, state).catch((error: unknown) => {
      console.error('[plugin] 写入插件检查状态失败：', error)
    })
  }

  return {
    writeState,

    async persistCheck(instanceId, name, record, published) {
      const state = await stateStore.read(instanceId)
      const updates = { ...state.updates }
      if (record === null) delete updates[name]
      else updates[name] = record
      const snapshots = { ...state.published }
      if (published !== null) snapshots[name] = published
      await writeState(instanceId, {
        ...state,
        lastCheckedAt: new Date().toISOString(),
        updates,
        published: snapshots
      })
    },

    async dropCheck(instanceId, name) {
      const state = await stateStore.read(instanceId)
      const updates = { ...state.updates }
      delete updates[name]
      const snapshots = { ...state.published }
      delete snapshots[name]
      await writeState(instanceId, { ...state, updates, published: snapshots })
    },

    async syncCheckAfterUpgrade(instanceId, name, published) {
      const state = await stateStore.read(instanceId)
      const updates = { ...state.updates }
      delete updates[name]
      const snapshots = { ...state.published }
      if (published !== null) snapshots[name] = published
      else delete snapshots[name]
      await writeState(instanceId, { ...state, updates, published: snapshots })
    }
  }
}
