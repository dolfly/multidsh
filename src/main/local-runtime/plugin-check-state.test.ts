import { describe, expect, it, vi } from 'vitest'
import { createCheckStateWriter } from './plugin-check-state'
import type { PluginCheckState, PluginStateStore } from './plugin-state'

/**
 * 插件检查状态的持久化合并。
 *
 * 重点守卫三条线：
 * - **已是最新就删掉该项**：「直到用户再次检查或升级才变」由此保证；
 * - **发布时间按已装版本存快照**：registry 未收录该版本时（published 为 null）保留原快照；
 * - **落盘失败不影响本次结果**：只是重启后看不到标记，不能把整个检查搞失败。
 */

/** 空状态（各用例的起点）。 */
const EMPTY: PluginCheckState = {
  lastCheckedAt: null,
  updates: {},
  published: {},
  bundleIndex: {},
  runtimeVersion: null,
  autoDisabled: []
}

/** 内存版状态存储：可预设初值，也可让写入失败。 */
function fakeStore(initial: PluginCheckState = EMPTY): {
  store: PluginStateStore
  written: PluginCheckState[]
} {
  const written: PluginCheckState[] = []
  let current = initial
  const store: PluginStateStore = {
    read: async () => current,
    write: async (_instanceId, state) => {
      written.push(state)
      current = state
    }
  }
  return { store, written }
}

describe('createCheckStateWriter.persistCheck', () => {
  it('有新版时记下候选信息并刷新「上次检查」时刻', async () => {
    const { store, written } = fakeStore()
    const writer = createCheckStateWriter(store)
    const record = {
      current: '1.0.0',
      latest: '1.1.0',
      compatible: true,
      dshPeer: '>=0.1.7-rc.2',
      dshVersion: '0.1.7-rc.2'
    }
    await writer.persistCheck('inst-1', 'demo-plugin', record, null)
    expect(written).toHaveLength(1)
    expect(written[0]?.updates['demo-plugin']).toEqual(record)
    expect(written[0]?.lastCheckedAt).not.toBeNull()
  })

  it('已是最新（record 为 null）时删掉该项', async () => {
    const { store, written } = fakeStore({
      ...EMPTY,
      updates: {
        'demo-plugin': {
          current: '1.0.0',
          latest: '1.1.0',
          compatible: true,
          dshPeer: null,
          dshVersion: null
        }
      }
    })
    const writer = createCheckStateWriter(store)
    await writer.persistCheck('inst-1', 'demo-plugin', null, null)
    expect(written[0]?.updates['demo-plugin']).toBeUndefined()
  })

  it('published 为 null 时保留原有发布时间快照', async () => {
    const { store, written } = fakeStore({
      ...EMPTY,
      published: { 'demo-plugin': { version: '1.0.0', at: '2026-09-20T02:30:00.000Z' } }
    })
    const writer = createCheckStateWriter(store)
    await writer.persistCheck('inst-1', 'demo-plugin', null, null)
    expect(written[0]?.published['demo-plugin']).toEqual({
      version: '1.0.0',
      at: '2026-09-20T02:30:00.000Z'
    })
  })

  it('有 published 时落成快照', async () => {
    const { store, written } = fakeStore()
    const writer = createCheckStateWriter(store)
    await writer.persistCheck('inst-1', 'demo-plugin', null, {
      version: '1.0.0',
      at: '2026-09-20T02:30:00.000Z'
    })
    expect(written[0]?.published['demo-plugin']).toEqual({
      version: '1.0.0',
      at: '2026-09-20T02:30:00.000Z'
    })
  })

  it('不动其它插件的记录', async () => {
    const { store, written } = fakeStore({
      ...EMPTY,
      updates: {
        other: {
          current: '1.0.0',
          latest: '1.1.0',
          compatible: true,
          dshPeer: null,
          dshVersion: null
        }
      }
    })
    const writer = createCheckStateWriter(store)
    await writer.persistCheck('inst-1', 'demo-plugin', null, null)
    expect(written[0]?.updates['other']).toBeDefined()
  })
})

describe('createCheckStateWriter.dropCheck', () => {
  it('可升级标记与发布时间快照一并丢弃', async () => {
    const { store, written } = fakeStore({
      ...EMPTY,
      updates: {
        'demo-plugin': {
          current: '1.0.0',
          latest: '1.1.0',
          compatible: true,
          dshPeer: null,
          dshVersion: null
        }
      },
      published: { 'demo-plugin': { version: '1.0.0', at: '2026-09-20T02:30:00.000Z' } }
    })
    const writer = createCheckStateWriter(store)
    await writer.dropCheck('inst-1', 'demo-plugin')
    expect(written[0]?.updates['demo-plugin']).toBeUndefined()
    expect(written[0]?.published['demo-plugin']).toBeUndefined()
  })

  it('不刷新「上次检查」时刻（检查痕迹随卸载失效）', async () => {
    const { store, written } = fakeStore({ ...EMPTY, lastCheckedAt: '2026-09-29T10:00:00.000Z' })
    const writer = createCheckStateWriter(store)
    await writer.dropCheck('inst-1', 'demo-plugin')
    expect(written[0]?.lastCheckedAt).toBe('2026-09-29T10:00:00.000Z')
  })
})

describe('createCheckStateWriter.syncCheckAfterUpgrade', () => {
  it('清掉可升级标记并落成新版本的发布时间快照', async () => {
    const { store, written } = fakeStore({
      ...EMPTY,
      updates: {
        'demo-plugin': {
          current: '1.0.0',
          latest: '1.1.0',
          compatible: true,
          dshPeer: null,
          dshVersion: null
        }
      },
      published: { 'demo-plugin': { version: '1.0.0', at: '2026-09-20T02:30:00.000Z' } }
    })
    const writer = createCheckStateWriter(store)
    await writer.syncCheckAfterUpgrade('inst-1', 'demo-plugin', {
      version: '1.1.0',
      at: '2026-09-28T11:16:59.586Z'
    })
    expect(written[0]?.updates['demo-plugin']).toBeUndefined()
    expect(written[0]?.published['demo-plugin']).toEqual({
      version: '1.1.0',
      at: '2026-09-28T11:16:59.586Z'
    })
  })

  it('取不到发布时间时清掉旧版本的陈旧快照（由下次检查补齐）', async () => {
    const { store, written } = fakeStore({
      ...EMPTY,
      published: { 'demo-plugin': { version: '1.0.0', at: '2026-09-20T02:30:00.000Z' } }
    })
    const writer = createCheckStateWriter(store)
    await writer.syncCheckAfterUpgrade('inst-1', 'demo-plugin', null)
    expect(written[0]?.published['demo-plugin']).toBeUndefined()
  })
})

describe('落盘失败不影响本次结果', () => {
  it('写入失败时静默吞掉（只是重启后看不到标记）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store: PluginStateStore = {
      read: async () => EMPTY,
      write: async () => {
        throw new Error('磁盘满')
      }
    }
    const writer = createCheckStateWriter(store)
    // 不抛错：本次检查/升级结果照样返回给调用方。
    await expect(writer.persistCheck('inst-1', 'demo-plugin', null, null)).resolves.toBeUndefined()
    await expect(writer.dropCheck('inst-1', 'demo-plugin')).resolves.toBeUndefined()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
