import { describe, expect, it } from 'vitest'
import type { LocalInstance } from '@shared/contracts'
import { createDshEntryResolver } from './plugin-dsh-entry'
import type { InstalledRuntime, RuntimeInstaller } from './runtime-installer'
import type { PathRuntime } from './runtime-source'

/**
 * 插件命令要用的 dsh 可执行入口解析。
 *
 * 重点守卫两条线：
 * - **版本必须与真正执行命令的副本一致**：检查阶段用注册表版本、执行阶段落到另一个副本，
 *   就会出现「检查说可升级、安装被 dsh 拒绝」；
 * - **判定不出时宁可拦下不误放行**：PATH 上与 hub 隔离目录都没有 dsh 时报错，不猜。
 */

/** 本机实例（隔离空间 + 默认启动器）。 */
const LOCAL: LocalInstance = {
  id: 'inst-1',
  name: '本机实例',
  transport: 'local',
  authMode: 'none',
  useDefaultSpace: false,
  launcher: null,
  dshVersion: null
} as LocalInstance

/** 公共空间 + 自定义启动器：固定跟随系统 dsh。 */
const SYSTEM_DSH: LocalInstance = {
  ...LOCAL,
  useDefaultSpace: true,
  launcher: 'dush'
} as LocalInstance

/** hub 已装副本。 */
function installed(version: string): InstalledRuntime {
  return {
    version,
    dir: `/runtimes/dsh-${version}`,
    entry: `/runtimes/dsh-${version}/bin.js`,
    installedAt: '2026-09-01T00:00:00.000Z'
  }
}

/** PATH 上的 dsh。 */
const PATH_DSH: PathRuntime = { command: '/usr/local/bin/dsh', version: '0.3.0' }

/** 装配解析器：已装副本与 PATH 探测都可预设。 */
function resolver(options: {
  installed?: InstalledRuntime[]
  path?: PathRuntime | null
  listFails?: boolean
  probeFails?: boolean
}) {
  const installer = {
    listInstalled: async (): Promise<InstalledRuntime[]> => {
      if (options.listFails === true) throw new Error('读取失败')
      return options.installed ?? []
    }
  } as unknown as RuntimeInstaller
  const pathProbe = {
    probe: async (): Promise<PathRuntime | null> => {
      if (options.probeFails === true) throw new Error('探测失败')
      return options.path === undefined ? null : options.path
    }
  }
  return createDshEntryResolver({ installer, pathProbe })
}

describe('createDshEntryResolver', () => {
  it('固定版本已装 → 用 hub 隔离目录里的那份', async () => {
    const resolve = resolver({ installed: [installed('0.2.0'), installed('0.3.0')] })
    const entry = await resolve({ ...LOCAL, dshVersion: '0.2.0' })
    expect(entry).toEqual({ entry: '/runtimes/dsh-0.2.0/bin.js', version: '0.2.0' })
  })

  it('未固定版本时按 PATH 实测优先', async () => {
    const resolve = resolver({ installed: [installed('0.2.0')], path: PATH_DSH })
    const entry = await resolve(LOCAL)
    expect(entry).toEqual({ entry: '/usr/local/bin/dsh', version: '0.3.0' })
  })

  it('PATH 上没有时回落 hub 已装的最新副本（数字感知）', async () => {
    const resolve = resolver({ installed: [installed('0.2.0'), installed('0.10.0')] })
    const entry = await resolve(LOCAL)
    // 0.10.0 > 0.2.0（数字感知，不是字典序）。
    expect(entry).toEqual({ entry: '/runtimes/dsh-0.10.0/bin.js', version: '0.10.0' })
  })

  it('固定版本没装但 PATH 上有同版本 → 用 PATH 上那份', async () => {
    const resolve = resolver({ installed: [], path: { command: '/usr/bin/dsh', version: '0.2.0' } })
    const entry = await resolve({ ...LOCAL, dshVersion: '0.2.0' })
    expect(entry).toEqual({ entry: '/usr/bin/dsh', version: '0.2.0' })
  })

  it('公共空间 + 自定义启动器：固定跟随系统 dsh，不装 hub 副本', async () => {
    // hub 里明明有副本，但跟随系统时它不参与决策。
    const resolve = resolver({ installed: [installed('0.2.0')], path: PATH_DSH })
    const entry = await resolve(SYSTEM_DSH)
    expect(entry).toEqual({ entry: '/usr/local/bin/dsh', version: '0.3.0' })
  })

  it('跟随系统 dsh 但 PATH 上没有 → 报错（不回落 hub 副本）', async () => {
    const resolve = resolver({ installed: [installed('0.2.0')], path: null })
    await expect(resolve(SYSTEM_DSH)).rejects.toThrow()
  })

  it('两处都没有 dsh → invalid-state（不猜）', async () => {
    const resolve = resolver({ installed: [], path: null })
    await expect(resolve(LOCAL)).rejects.toMatchObject({ code: 'invalid-state' })
  })

  it('读已装列表失败时按「没有已装副本」处理，不整个失败', async () => {
    const resolve = resolver({ listFails: true, path: PATH_DSH })
    const entry = await resolve(LOCAL)
    expect(entry).toEqual({ entry: '/usr/local/bin/dsh', version: '0.3.0' })
  })

  it('PATH 探测失败时按「PATH 上没有」处理', async () => {
    const resolve = resolver({ probeFails: true, installed: [installed('0.2.0')] })
    const entry = await resolve(LOCAL)
    expect(entry).toEqual({ entry: '/runtimes/dsh-0.2.0/bin.js', version: '0.2.0' })
  })
})
