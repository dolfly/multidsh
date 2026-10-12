import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPluginStateStore } from './plugin-state'

const dirs: string[] = []
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plugin-state-'))
  dirs.push(dir)
  return dir
}

/** 空状态（读取失败 / 未写过时的期望值）。 */
const EMPTY = {
  lastCheckedAt: null,
  updates: {},
  published: {},
  bundleIndex: {},
  runtimeVersion: null,
  autoDisabled: []
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('createPluginStateStore', () => {
  it('未写过时返回空状态（lastCheckedAt=null，无更新项）', async () => {
    const store = createPluginStateStore(await tempRoot())
    expect(await store.read('inst-1')).toEqual(EMPTY)
  })

  it('写入后可读回（含插件检查摘要与发布时间快照）', async () => {
    const store = createPluginStateStore(await tempRoot())
    await store.write('inst-1', {
      lastCheckedAt: '2026-09-29T10:00:00.000Z',
      bundleIndex: { 'dsh-better-sidebar': 7 },
      runtimeVersion: null,
      autoDisabled: [],
      updates: {
        'dsh-better-sidebar': {
          current: '0.23.0',
          latest: '0.24.1',
          compatible: true,
          dshPeer: '^0.2.0-rc.1',
          dshVersion: '0.2.0-rc.1'
        }
      },
      published: { 'dsh-better-sidebar': { version: '0.24.1', at: '2026-09-28T15:37:38.360Z' } }
    })
    const state = await store.read('inst-1')
    expect(state.lastCheckedAt).toBe('2026-09-29T10:00:00.000Z')
    expect(state.updates['dsh-better-sidebar']?.current).toBe('0.23.0')
    expect(state.updates['dsh-better-sidebar']?.latest).toBe('0.24.1')
    expect(state.updates['dsh-better-sidebar']?.compatible).toBe(true)
    expect(state.bundleIndex['dsh-better-sidebar']).toBe(7)
    expect(state.published['dsh-better-sidebar']).toEqual({
      version: '0.24.1',
      at: '2026-09-28T15:37:38.360Z'
    })
  })

  it('不同实例互不影响', async () => {
    const store = createPluginStateStore(await tempRoot())
    await store.write('inst-1', {
      lastCheckedAt: 'a',
      updates: {},
      published: {},
      bundleIndex: {},
      runtimeVersion: null,
      autoDisabled: []
    })
    expect(await store.read('inst-2')).toEqual(EMPTY)
  })

  it('文件损坏或字段类型不对时按空状态处理，不抛错', async () => {
    const root = await tempRoot()
    const store = createPluginStateStore(root)
    // 非法 JSON
    await store.write('broken', {
      lastCheckedAt: null,
      updates: {},
      published: {},
      bundleIndex: {},
      runtimeVersion: null,
      autoDisabled: []
    })
    await writeFile(join(root, 'plugin-state', 'broken.json'), '{not json', 'utf8')
    expect(await store.read('broken')).toEqual(EMPTY)

    // 脏字段：缺 latest / 缺「检查时的已装版本」的更新项、缺 version/at 的发布时间快照被丢弃，其余保留
    await writeFile(
      join(root, 'plugin-state', 'dirty.json'),
      JSON.stringify({
        lastCheckedAt: 42,
        updates: {
          ok: { current: '0.9.0', latest: '1.0.0' },
          bad: { compatible: true },
          noCurrent: { latest: '1.0.0' }
        },
        published: {
          ok: { version: '1.0.0', at: '2026-09-28T15:37:38.360Z' },
          noVersion: { at: '2026-09-28T15:37:38.360Z' },
          noAt: { version: '1.0.0' },
          emptyAt: { version: '1.0.0', at: '' },
          wrongType: 'x'
        }
      }),
      'utf8'
    )
    const dirty = await store.read('dirty')
    expect(dirty.lastCheckedAt).toBeNull()
    expect(Object.keys(dirty.updates)).toEqual(['ok'])
    expect(dirty.updates.ok?.compatible).toBe(true)
    expect(dirty.published).toEqual({
      ok: { version: '1.0.0', at: '2026-09-28T15:37:38.360Z' }
    })
  })
})
