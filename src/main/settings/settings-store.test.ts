import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { createSettingsStore } from './settings-store'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-settings-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('settings-store（偏好落盘）', () => {
  it('首次读取返回默认值(不写盘)', async () => {
    const store = createSettingsStore({ dir })
    expect(store.read()).toEqual(DEFAULT_SETTINGS)
  })

  it('update 合并补丁并落盘;重新打开能读回', async () => {
    const store = createSettingsStore({ dir })
    const next = await store.update({ language: 'en', theme: 'dark' })
    expect(next).toEqual({ ...DEFAULT_SETTINGS, language: 'en', theme: 'dark' })

    const reopened = createSettingsStore({ dir })
    expect(reopened.read()).toEqual(next)
  })

  it('落盘内容可读且不包含未定义的字段', async () => {
    const store = createSettingsStore({ dir })
    await store.update({ tray: true })
    const raw = JSON.parse(await readFile(store.filePath(), 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(
      [
        'autoStart',
        'inheritShellEnv',
        'language',
        'notifications',
        'npmRegistry',
        'preventSleepWhenRunning',
        'theme',
        'tray',
        'workspaceCacheSize'
      ].sort()
    )
    expect(raw['tray']).toBe(true)
  })

  it('文件损坏 → 回落默认值并上报,不抛(启动不被偏好文件拦住)', async () => {
    const errors: unknown[] = []
    await writeFile(join(dir, 'settings.json'), 'not json')
    const store = createSettingsStore({ dir, onError: (error) => errors.push(error) })
    expect(store.read()).toEqual(DEFAULT_SETTINGS)
    expect(errors).toHaveLength(1)
  })

  it('文件里的坏字段被逐字段收敛(好字段保留)', async () => {
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({ language: 'en', theme: 'rainbow', tray: 'yes' })
    )
    const store = createSettingsStore({ dir, onError: () => undefined })
    expect(store.read()).toEqual({ ...DEFAULT_SETTINGS, language: 'en' })
  })

  it('update 拒绝非法补丁值并回落默认(不写坏值进文件)', async () => {
    const store = createSettingsStore({ dir })
    await store.update({ theme: 'rainbow' } as never)
    const raw = JSON.parse(await readFile(store.filePath(), 'utf8')) as { theme: string }
    expect(raw.theme).toBe('system')
  })

  it('多次 update 累加(缓存与文件一致)', async () => {
    const store = createSettingsStore({ dir })
    await store.update({ language: 'en' })
    await store.update({ notifications: false })
    const raw = JSON.parse(await readFile(store.filePath(), 'utf8')) as typeof DEFAULT_SETTINGS
    expect(raw).toEqual({ ...DEFAULT_SETTINGS, language: 'en', notifications: false })
    expect(store.read()).toEqual(raw)
  })

  it('并发 update 不得丢失改动', async () => {
    const store = createSettingsStore({ dir })
    // 并发发起多笔互不相同的改动;串行化后每一笔都必须留下
    await Promise.all([
      store.update({ language: 'en' }),
      store.update({ theme: 'dark' }),
      store.update({ tray: true }),
      store.update({ notifications: false })
    ])
    const persisted = JSON.parse(
      await readFile(store.filePath(), 'utf8')
    ) as typeof DEFAULT_SETTINGS
    expect(persisted).toEqual({
      language: 'en',
      theme: 'dark',
      tray: true,
      autoStart: false,
      notifications: false,
      preventSleepWhenRunning: false,
      workspaceCacheSize: 3,
      inheritShellEnv: true,
      npmRegistry: ''
    })
    // 内存缓存也必须与落盘一致
    expect(store.read()).toEqual(persisted)
  })

  it('并发 update 全部 resolve 成功(不得出现「返回 ok 但改动丢失」)', async () => {
    const store = createSettingsStore({ dir })
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) => store.update({ theme: index % 2 ? 'dark' : 'light' }))
    )
    expect(results).toHaveLength(5)
    for (const result of results) expect(result).toBeDefined()
    const persisted = JSON.parse(await readFile(store.filePath(), 'utf8')) as { theme: string }
    expect(['dark', 'light']).toContain(persisted.theme)
  })
})
