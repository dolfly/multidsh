import { delimiter } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createPluginManager } from './plugin-manager'
import { InstanceStoreError } from '../registry/instance-store'
import type { CommandResult } from './exec-file'
import {
  LIST_JSON,
  baseOptions,
  fakeBundles,
  fakeInstaller,
  localInstance,
  fakeRun,
  toPosix,
  GIT_PANEL_MANIFEST
} from './plugin-manager.testkit'

describe('createPluginManager.list', () => {
  it('解析列表并装配元数据（图标 data-uri / npm+github url / host 半 / 依赖）', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({
      code: 0,
      stdout: LIST_JSON,
      stderr: ''
    }))
    const manager = createPluginManager(baseOptions(run))
    const plugins = await manager.list(localInstance())

    expect(plugins).toHaveLength(2)
    const gitPanel = plugins.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')!
    expect(gitPanel.version).toBe('1.1.0')
    expect(gitPanel.npmUrl).toBe('https://www.npmjs.com/package/@xbzbing/dsh-git-panel')
    expect(gitPanel.githubUrl).toBe('https://github.com/xbzbing/dsh-git-panel')
    expect(gitPanel.iconDataUri).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
    expect(gitPanel.hasHostSide).toBe(true)
    expect(gitPanel.hasClientSide).toBe(true)
    expect(gitPanel.dshPeer).toBe('>=0.1.7-rc.2')
    expect(gitPanel.installSource).toBe('npm')

    const freeSearch = plugins.find((plugin) => plugin.name === 'dsh-free-search')!
    expect(freeSearch.dependencies).toEqual(['some-dep'])
    // 只声明 dsh 子包（无主包 peer）：兼容范围取子包范围，不显示成空「dsh —」。
    expect(freeSearch.dshPeer).toBe('^0.1.7-rc.1')
  })

  it('hub 副本与 PATH 都没有运行时：以 invalid-state 报「未找到可用的 dsh」，不落成内部错误', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '' }))
    const installer = { ...fakeInstaller(), listInstalled: async () => [] }
    const manager = createPluginManager({ ...baseOptions(run), installer })
    await expect(manager.list(localInstance())).rejects.toMatchObject({
      code: 'invalid-state',
      message: expect.stringContaining('未找到可用的 dsh')
    })
    // 运行时都解析不到，插件命令不应被发起
    expect(run).not.toHaveBeenCalled()
  })

  it('locale：读 locale/<lang>.json 的 meta 本地化 title/description', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({
      code: 0,
      stdout: LIST_JSON,
      stderr: ''
    }))
    const manager = createPluginManager({
      ...baseOptions(run),
      readLocale: (p) => {
        const posix = toPosix(p)
        if (posix.endsWith('/locale/zh.json') && posix.includes('git-panel')) {
          return { meta: { title: 'Git 面板', description: '中文简介' } }
        }
        if (posix.endsWith('/locale/en.json') && posix.includes('git-panel')) {
          return { meta: { title: 'Git Panel', description: 'English desc' } }
        }
        return null
      }
    })
    const zh = await manager.list(localInstance(), 'zh')
    const zhGit = zh.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')!
    expect(zhGit.title).toBe('Git 面板')
    expect(zhGit.description).toBe('中文简介')

    const en = await manager.list(localInstance(), 'en')
    const enGit = en.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')!
    expect(enGit.title).toBe('Git Panel')
    expect(enGit.description).toBe('English desc')

    // 无 locale 的插件：title=null，description 回落 package.json。
    const zhSearch = zh.find((plugin) => plugin.name === 'dsh-free-search')!
    expect(zhSearch.title).toBe(null)
    expect(zhSearch.description).toBe('Search')
  })

  it('scoped 包元数据优先读 profile 顶层 node_modules（.pnpm 虚拟 store 里 scoped 子目录不存在）', async () => {
    const readDirs: string[] = []
    const run = vi.fn(async (): Promise<CommandResult> => ({
      code: 0,
      stdout: LIST_JSON,
      stderr: ''
    }))
    const manager = createPluginManager({
      ...baseOptions(run),
      // 只有顶层 node_modules 路径能读到 manifest；list --json 的 .pnpm path 读不到（返回 null）。
      readManifest: (dir) => {
        const posix = toPosix(dir)
        readDirs.push(posix)
        if (posix.includes('/.pnpm/')) return null
        if (posix.includes('git-panel')) return GIT_PANEL_MANIFEST
        return null
      }
    })
    const plugins = await manager.list(
      localInstance({ id: 'inst-1', useDefaultSpace: false, profile: null })
    )
    const gitPanel = plugins.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')!
    // 顶层路径 = <dataRoot>/homes/<id>/profiles/web/node_modules/@xbzbing/dsh-git-panel
    expect(gitPanel.version).toBe('1.1.0')
    expect(gitPanel.hasHostSide).toBe(true)
    expect(readDirs.some((dir) => dir.endsWith('/node_modules/@xbzbing/dsh-git-panel'))).toBe(true)
  })

  it('命令拼装：plugin --profile <p> list --json，DSH_HOME 为隔离空间路径', async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    const run = vi.fn(
      async (command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        void command
        calls.push({ args, env: opts?.env })
        return { code: 0, stdout: LIST_JSON, stderr: '' }
      }
    )
    const manager = createPluginManager(baseOptions(run))
    await manager.list(localInstance({ id: 'abc', profile: 'tui' }))

    expect(calls[0]!.args).toEqual([
      '/runtimes/dsh-0.1.7-rc.2/bin.js',
      'plugin',
      '--profile',
      'tui',
      'list',
      '--json'
    ])
    // 路径断言归一化分隔符：断言的是目录布局，Windows 上 join 产出反斜杠。
    expect(toPosix(calls[0]!.env?.DSH_HOME ?? '')).toBe('/data/homes/abc')
    // pnpm v12 全局 shim 派发在 nvm+Windows 上会 shim integrity check failed，统一绕过。
    expect(calls[0]!.env?.PNPM_SHIM_BYPASS).toBe('1')
  })

  it('公共空间实例：DSH_HOME 为 <home>/.dsh', async () => {
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = []
    const run = vi.fn(
      async (command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        void command
        void args
        calls.push({ env: opts?.env })
        return { code: 0, stdout: LIST_JSON, stderr: '' }
      }
    )
    const manager = createPluginManager({ ...baseOptions(run), homeDir: () => '/Users/me' })
    await manager.list(localInstance({ useDefaultSpace: true }))
    expect(toPosix(calls[0]!.env?.DSH_HOME ?? '')).toBe('/Users/me/.dsh')
  })

  it('提供 pnpmBinDir 时并入 PATH：Windows 前置、其余平台后置兜底', async () => {
    const calls: Array<{ env?: NodeJS.ProcessEnv }> = []
    const run = vi.fn(
      async (command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        void command
        void args
        calls.push({ env: opts?.env })
        return { code: 0, stdout: LIST_JSON, stderr: '' }
      }
    )
    const manager = createPluginManager({ ...baseOptions(run), pnpmBinDir: '/opt/app/pnpm-bin' })
    await manager.list(localInstance())
    const segments = (calls[0]!.env?.PATH ?? '').split(delimiter)
    if (process.platform === 'win32') expect(segments[0]).toBe('/opt/app/pnpm-bin')
    else expect(segments[segments.length - 1]).toBe('/opt/app/pnpm-bin')
  })

  it('非零退出：抛脱敏后的错误', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({ code: 1, stdout: '', stderr: 'boom' }))
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.list(localInstance())).rejects.toThrow(/失败（exit 1）：boom/)
  })

  it('命令失败以 invalid-state 透出 dsh 的拒绝说明（不再收敛成内部错误）', async () => {
    const rejection =
      'dsh: installation rejected: Plugin dsh-better-sidebar@0.24.1 is incompatible with dsh 0.1.7-rc.2'
    const run = vi.fn(async (): Promise<CommandResult> => ({
      code: 1,
      stdout: '',
      stderr: rejection
    }))
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.list(localInstance())).rejects.toBeInstanceOf(InstanceStoreError)
    await expect(manager.list(localInstance())).rejects.toMatchObject({
      code: 'invalid-state',
      message: expect.stringContaining('installation rejected')
    })
  })

  it('公共空间 + 自定义启动器（duush）跟随系统 dsh：用 PATH 实测入口，不用 hub 副本', async () => {
    const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = []
    const run = vi.fn(
      async (command: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        void command
        calls.push({ args, env: opts?.env })
        return { code: 0, stdout: LIST_JSON, stderr: '' }
      }
    )
    const manager = createPluginManager({
      ...baseOptions(run),
      homeDir: () => '/Users/me',
      pathProbe: {
        probe: async () => ({ command: '/usr/local/bin/dsh', version: '0.2.0-rc.1' })
      }
    })
    await manager.list(
      localInstance({ useDefaultSpace: true, launcher: 'duush', dshVersion: '0.1.7-rc.2' })
    )
    // 入口取 PATH 上的系统 dsh，而不是 hub 已装的 0.1.7-rc.2 副本。
    expect(calls[0]!.args[0]).toBe('/usr/local/bin/dsh')
    expect(toPosix(calls[0]!.env?.DSH_HOME ?? '')).toBe('/Users/me/.dsh')
  })

  it('list：按 bundles 给出 enabled（无 host 半的插件为 null）', async () => {
    const run = fakeRun()
    const bundles = fakeBundles({
      bundles: ['@xbzbing/dsh-git-panel'],
      dependencies: ['@xbzbing/dsh-git-panel', 'dsh-free-search']
    })
    const manager = createPluginManager({ ...baseOptions(run), bundleStore: bundles.store })
    const plugins = await manager.list(localInstance())
    // git-panel 在清单里 → 启用；free-search 不在 → 已禁用
    expect(plugins.find((p) => p.name === '@xbzbing/dsh-git-panel')?.enabled).toBe(true)
    expect(plugins.find((p) => p.name === 'dsh-free-search')?.enabled).toBe(false)
  })
})
