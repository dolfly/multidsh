import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPluginManager, profileHasHmr } from './plugin-manager'
import type { PluginManagerOptions } from './plugin-manager'
import { InstanceStoreError } from '../registry/instance-store'
import type { LocalInstance } from '@shared/contracts'
import type { CommandResult } from './exec-file'
import type { PluginCheckState, PluginStateStore } from './plugin-state'
import type { ProfileBundleStore, ProfileBundles } from './profile-bundles'
import type { PackageInfoFetchers } from './plugin-package-info'

/** 路径分隔符归一化，使断言在 win32（反斜杠）与 POSIX 上一致。 */
const toPosix = (path: string): string => path.replace(/\\/g, '/')

const now = new Date().toISOString()

function localInstance(overrides: Partial<LocalInstance> = {}): LocalInstance {
  return {
    id: 'inst-1',
    name: 'local',
    transport: 'local',
    authMode: 'auto',
    notes: null,
    createdAt: now,
    updatedAt: now,
    dshVersion: '0.1.7-rc.2',
    port: 3080,
    profile: null,
    launcher: null,
    useDefaultSpace: false,
    runCommand: null,
    autoStart: false,
    ...overrides
  } as LocalInstance
}

/** 假安装器：只需给出一个已装 entry 供 resolveDshEntry 命中。 */
function fakeInstaller(): PluginManagerOptions['installer'] {
  return {
    listInstalled: async () => [
      {
        version: '0.1.7-rc.2',
        dir: '/runtimes/dsh-0.1.7-rc.2',
        entry: '/runtimes/dsh-0.1.7-rc.2/bin.js',
        installedAt: now
      }
    ],
    listAvailableVersions: async () => [],
    resolveDefaultVersion: async () => '0.1.7-rc.2',
    isInstalled: async () => true,
    install: async () => ({ version: '0.1.7-rc.2', dir: '', entry: '', installedAt: now }),
    ensureInstalled: async () => ({ version: '0.1.7-rc.2', dir: '', entry: '', installedAt: now }),
    resolveEntry: () => '/runtimes/dsh-0.1.7-rc.2/bin.js',
    hasIncompleteInstall: async () => false,
    resolveLatestVersion: async () => '0.1.7-rc.2',
    resolveGlobalPrefix: async () => null,
    installGlobal: async () => undefined,
    dispose: () => undefined
  }
}

/** 内存版 profile 清单：验证启用/禁用只改 bundles、保留 dependencies。 */
function fakeBundles(initial: { bundles: string[]; dependencies: string[] }): {
  store: ProfileBundleStore
  calls: Array<{ name: string; enabled: boolean; insertAt?: number }>
  current: ProfileBundles
} {
  const state = { current: { ...initial } }
  const calls: Array<{ name: string; enabled: boolean; insertAt?: number }> = []
  const store: ProfileBundleStore = {
    read: async () => ({ ...state.current }),
    setEnabled: async (_dir, name, enabled, insertAt) => {
      calls.push({ name, enabled, ...(insertAt === undefined ? {} : { insertAt }) })
      const without = state.current.bundles.filter((item) => item !== name)
      if (!enabled) state.current.bundles = without
      else if (!state.current.bundles.includes(name)) {
        const at =
          insertAt !== undefined && insertAt >= 0 && insertAt <= without.length
            ? insertAt
            : without.length
        state.current.bundles = [...without.slice(0, at), name, ...without.slice(at)]
      }
      return state.current.bundles
    }
  }
  return { store, calls, current: state.current as ProfileBundles }
}

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 完整的检查状态字面量（缺省为空状态），避免每处重复列全部字段。 */
function stateWith(patch: Partial<PluginCheckState> = {}): PluginCheckState {
  return {
    lastCheckedAt: null,
    updates: {},
    published: {},
    bundleIndex: {},
    runtimeVersion: null,
    autoDisabled: [],
    ...patch
  }
}

/** 内存版状态存储：验证检查结果落盘与读回。 */
function memoryStore(): PluginStateStore {
  const files = new Map<string, PluginCheckState>()
  return {
    read: async (instanceId) => files.get(instanceId) ?? stateWith(),
    write: async (instanceId, state) => {
      files.set(instanceId, state)
    }
  }
}

const LIST_JSON = JSON.stringify([
  {
    name: 'dsh-profile-web',
    dependencies: {
      '@xbzbing/dsh-git-panel': {
        from: '@xbzbing/dsh-git-panel',
        version: '1.1.0',
        resolved: 'https://registry.npmjs.org/@xbzbing/dsh-git-panel/-/dsh-git-panel-1.1.0.tgz',
        path: '/node_modules/@xbzbing/dsh-git-panel'
      },
      'dsh-free-search': {
        from: 'dsh-free-search',
        version: '0.4.39',
        resolved: 'https://registry.npmjs.org/dsh-free-search/-/dsh-free-search-0.4.39.tgz',
        path: '/node_modules/dsh-free-search'
      }
    }
  }
])

const GIT_PANEL_MANIFEST = {
  name: '@xbzbing/dsh-git-panel',
  version: '1.1.0',
  description: 'Git panel',
  license: 'MIT',
  author: 'xbzbing',
  repository: { type: 'git', url: 'git+https://github.com/xbzbing/dsh-git-panel.git' },
  icon: './icon.svg',
  dependencies: {},
  peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
  engines: { node: '^22.19.0 || >=24.0.0' },
  dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } }
}

const FREE_SEARCH_MANIFEST = {
  name: 'dsh-free-search',
  version: '0.4.39',
  description: 'Search',
  license: 'MIT',
  dependencies: { 'some-dep': '^1.0.0' },
  peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.7-rc.1' },
  engines: { node: '>=20' },
  dsh: { bundle: { patch: 'cordis.patch.yml' }, client: true }
}

function manifestFor(dir: string): Record<string, unknown> | null {
  if (dir.includes('git-panel')) return GIT_PANEL_MANIFEST
  if (dir.includes('free-search')) return FREE_SEARCH_MANIFEST
  return null
}

function baseOptions(run: PluginManagerOptions['run']): PluginManagerOptions {
  return {
    installer: fakeInstaller(),
    dataRoot: '/data',
    run,
    readManifest: manifestFor,
    readIcon: () => 'PHN2Zz48L3N2Zz4=',
    resolveNode: () => '/runtimes/dsh-0.1.7-rc.2/node',
    // 注入桩避免真实起登录 shell（默认 resolveShellEnvOnce 会 spawn shell，拖慢并引入环境依赖）。
    inheritShellEnv: () => false,
    shellEnv: async () => null,
    loginPath: async () => null,
    // 默认内存状态存储：避免测试写真实磁盘（dataRoot 是虚构路径）。
    stateStore: memoryStore()
  }
}

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
})

describe('createPluginManager.check', () => {
  /** 假 registry 应答：latest 1.2.0，time 是「版本 → 发布时刻」映射。 */
  const VIEW_JSON = JSON.stringify({
    version: '1.2.0',
    peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
    time: {
      created: '2026-08-13T14:26:11.670Z',
      '1.1.0': '2026-09-20T02:30:00.000Z',
      '1.2.0': '2026-09-28T11:16:59.586Z',
      modified: '2026-09-28T11:16:59.586Z'
    }
  })

  it('兼容判定：latest peer 满足实例 dsh 版本', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: VIEW_JSON, stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    const check = await manager.check(localInstance(), '@xbzbing/dsh-git-panel')
    expect(check.current).toBe('1.1.0')
    expect(check.latest).toBe('1.2.0')
    expect(check.hasUpdate).toBe(true)
    expect(check.compatible).toBe(true)
    // 发布时间取「已装版本」那一项，不是 latest 的。
    expect(check.publishedAt).toBe('2026-09-20T02:30:00.000Z')
  })

  it('命令拼装：view 取 version / peerDependencies / time（版本发布时间映射），固定默认安装源', async () => {
    const calls: string[][] = []
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      calls.push(args)
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: VIEW_JSON, stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    await manager.check(localInstance({ profile: 'tui' }), '@xbzbing/dsh-git-panel')
    expect(calls[1]).toEqual([
      '/runtimes/dsh-0.1.7-rc.2/bin.js',
      'plugin',
      '--profile',
      'tui',
      'view',
      '@xbzbing/dsh-git-panel',
      'version',
      'peerDependencies',
      'time',
      '--json',
      '--registry',
      'https://registry.npmmirror.com'
    ])
  })

  it('registry 未收录已装版本：publishedAt=null，不覆盖已有快照', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      // 已装 1.1.0 不在 time 里（本地 file: 安装 / 版本已下架）。
      return {
        code: 0,
        stdout: JSON.stringify({ version: '1.2.0', time: { '1.2.0': 'x' } }),
        stderr: ''
      }
    })
    const stateStore = memoryStore()
    await stateStore.write(
      'inst-1',
      stateWith({
        published: {
          '@xbzbing/dsh-git-panel': { version: '1.1.0', at: '2026-09-20T02:30:00.000Z' }
        }
      })
    )
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    const check = await manager.check(localInstance(), '@xbzbing/dsh-git-panel')
    expect(check.publishedAt).toBeNull()
    expect((await stateStore.read('inst-1')).published['@xbzbing/dsh-git-panel']).toEqual({
      version: '1.1.0',
      at: '2026-09-20T02:30:00.000Z'
    })
  })

  it('插件未发布到 npm（404）：抛出明确文案，非裸 pnpm stderr', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      // pnpm view 对未发布包返回 exit 1，stderr 含 404 标记。
      return {
        code: 1,
        stdout: '',
        stderr:
          'Command failed with exit code 1: pnpm view dsh-opencode-zen-provider version peerDependencies time --json\nERR_PNPM_FETCH_404 GET https://registry.npmjs.org/dsh-opencode-zen-provider: Not Found - 404'
      }
    })
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.check(localInstance(), '@xbzbing/dsh-git-panel')).rejects.toThrow(
      /未发布到 npm registry/
    )
  })

  it('不兼容：latest peer 要求高于实例 dsh 版本', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return {
        code: 0,
        stdout: JSON.stringify({
          version: '2.0.0',
          peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' }
        }),
        stderr: ''
      }
    })
    const manager = createPluginManager(baseOptions(run))
    const check = await manager.check(
      localInstance({ dshVersion: '0.1.7-rc.2' }),
      '@xbzbing/dsh-git-panel'
    )
    expect(check.compatible).toBe(false)
    expect(check.dshPeer).toBe('>=0.2.0')
  })

  it('不兼容：主包满足但 dsh 子包锁 ^0.2.0-rc.1（better-sidebar 0.24.1 真实场景）', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return {
        code: 0,
        stdout: JSON.stringify({
          version: '0.24.1',
          peerDependencies: {
            react: '^18.2.0',
            '@deepseek-ai/dsh-llm': '^0.2.0-rc.1',
            '@deepseek-ai/dsh-session': '^0.2.0-rc.1'
          }
        }),
        stderr: ''
      }
    })
    const manager = createPluginManager(baseOptions(run))
    const check = await manager.check(
      localInstance({ dshVersion: '0.1.7-rc.2' }),
      '@xbzbing/dsh-git-panel'
    )
    // 主包 peer 未声明，但子包锁 0.2 → 整体不兼容，不给升级；
    // 展示范围回落到（锁步一致的）子包范围，不再显示成空「dsh —」。
    expect(check.compatible).toBe(false)
    expect(check.dshPeer).toBe('^0.2.0-rc.1')
  })

  it('检查到有新版：结果落盘，checkState 可读回（切走再回来仍有标记）', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return {
        code: 0,
        stdout: JSON.stringify({
          version: '2.0.0',
          peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
          time: { '1.1.0': '2026-09-20T02:30:00.000Z', '2.0.0': '2026-09-28T11:16:59.586Z' }
        }),
        stderr: ''
      }
    })
    const stateStore = memoryStore()
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    await manager.check(localInstance(), '@xbzbing/dsh-git-panel')

    const snapshot = await manager.checkState(localInstance())
    expect(snapshot.updates['@xbzbing/dsh-git-panel']).toEqual({
      current: '1.1.0',
      latest: '2.0.0',
      compatible: true,
      dshPeer: '>=0.1.7-rc.2',
      dshVersion: '0.1.7-rc.2'
    })
    expect(snapshot.lastCheckedAt).not.toBeNull()
    expect(snapshot.checking).toEqual([])
    // 发布时间随列表回填到 PluginInfo（渲染层直接用，无需再落一份到检查标记里）。
    const plugins = await manager.list(localInstance())
    expect(plugins.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')?.publishedAt).toBe(
      '2026-09-20T02:30:00.000Z'
    )
  })

  it('已装版本高于 registry latest（手动装了更新版）→ 不算有更新，也不落盘标记', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      // 已装 1.1.0，registry latest 1.0.9（更旧）→ 不应报「有更新」。
      return {
        code: 0,
        stdout: JSON.stringify({
          version: '1.0.9',
          peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' }
        }),
        stderr: ''
      }
    })
    const stateStore = memoryStore()
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    const check = await manager.check(localInstance(), '@xbzbing/dsh-git-panel')
    expect(check.hasUpdate).toBe(false)
    expect((await stateStore.read('inst-1')).updates).toEqual({})
  })

  it('已是最新：清掉可升级标记，但发布时间快照留下（同一版本发布时间恒定）', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      // 已装 1.1.0，registry latest 也是 1.1.0 → 无更新
      return {
        code: 0,
        stdout: JSON.stringify({
          version: '1.1.0',
          peerDependencies: {},
          time: { '1.1.0': '2026-09-20T02:30:00.000Z' }
        }),
        stderr: ''
      }
    })
    const stateStore = memoryStore()
    await stateStore.write(
      'inst-1',
      stateWith({
        updates: {
          '@xbzbing/dsh-git-panel': {
            current: '1.0.0',
            latest: '1.0.9',
            compatible: true,
            dshPeer: null,
            dshVersion: null
          }
        }
      })
    )
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    await manager.check(localInstance(), '@xbzbing/dsh-git-panel')
    expect((await manager.checkState(localInstance())).updates).toEqual({})
    expect((await stateStore.read('inst-1')).published['@xbzbing/dsh-git-panel']).toEqual({
      version: '1.1.0',
      at: '2026-09-20T02:30:00.000Z'
    })
    // 列表里该字段仍在（切走再回来 / 重启后都能显示）。
    const plugins = await manager.list(localInstance())
    expect(plugins.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')?.publishedAt).toBe(
      '2026-09-20T02:30:00.000Z'
    )
  })

  it('快照版本与已装版本不一致：不回填发布时间（升级后等下次检查）', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({
      code: 0,
      stdout: LIST_JSON,
      stderr: ''
    }))
    const stateStore = memoryStore()
    await stateStore.write(
      'inst-1',
      stateWith({
        published: {
          // 快照是升级前的 1.0.9，已装版本已是 1.1.0。
          '@xbzbing/dsh-git-panel': { version: '1.0.9', at: '2026-09-01T00:00:00.000Z' },
          'dsh-free-search': { version: '0.4.39', at: '2026-09-10T00:00:00.000Z' }
        }
      })
    )
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    const plugins = await manager.list(localInstance())
    expect(
      plugins.find((plugin) => plugin.name === '@xbzbing/dsh-git-panel')?.publishedAt
    ).toBeNull()
    // 版本一致的插件照常显示。
    expect(plugins.find((plugin) => plugin.name === 'dsh-free-search')?.publishedAt).toBe(
      '2026-09-10T00:00:00.000Z'
    )
  })

  it('升级后清掉可升级标记，并同步写入新版本的发布时间快照（无需再次检查）', async () => {
    const listV2 = JSON.stringify([
      {
        name: 'dsh-profile-web',
        dependencies: {
          '@xbzbing/dsh-git-panel': {
            from: '@xbzbing/dsh-git-panel',
            version: '2.0.0',
            resolved: 'https://registry.npmjs.org/@xbzbing/dsh-git-panel/-/dsh-git-panel-2.0.0.tgz',
            path: '/node_modules/@xbzbing/dsh-git-panel'
          }
        }
      }
    ])
    let upgraded = false
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      // add 之后已装版本切到 2.0.0：list 随之反映新版本。
      if (args.includes('add')) {
        upgraded = true
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args.includes('list')) {
        return { code: 0, stdout: upgraded ? listV2 : LIST_JSON, stderr: '' }
      }
      if (args.includes('view')) {
        // 仅查 time 字段时 dsh 输出裸的「版本 → 发布时刻」映射（不嵌套在 time 键下）。
        return {
          code: 0,
          stdout: JSON.stringify({
            '1.1.0': '2026-09-20T02:30:00.000Z',
            '2.0.0': '2026-10-05T08:00:00.000Z',
            created: '2026-09-01T00:00:00.000Z'
          }),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const stateStore = memoryStore()
    await stateStore.write(
      'inst-1',
      stateWith({
        lastCheckedAt: '2026-09-29T00:00:00.000Z',
        updates: {
          '@xbzbing/dsh-git-panel': {
            current: '1.1.0',
            latest: '2.0.0',
            compatible: true,
            dshPeer: null,
            dshVersion: null
          }
        },
        published: {
          '@xbzbing/dsh-git-panel': { version: '1.1.0', at: '2026-09-20T02:30:00.000Z' }
        }
      })
    )
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '2.0.0')
    expect((await manager.checkState(localInstance())).updates).toEqual({})
    // 快照换成新版本的发布时间：发布时间同步可见，不需用户再次检查。
    expect((await stateStore.read('inst-1')).published).toEqual({
      '@xbzbing/dsh-git-panel': { version: '2.0.0', at: '2026-10-05T08:00:00.000Z' }
    })
  })

  it('升级后 view 返回嵌套 time 映射：同样能同步新版本发布时间', async () => {
    const listV2 = JSON.stringify([
      {
        name: 'dsh-profile-web',
        dependencies: {
          '@xbzbing/dsh-git-panel': { from: '@xbzbing/dsh-git-panel', version: '2.0.0' }
        }
      }
    ])
    let upgraded = false
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('add')) {
        upgraded = true
        return { code: 0, stdout: '', stderr: '' }
      }
      if (args.includes('list'))
        return { code: 0, stdout: upgraded ? listV2 : LIST_JSON, stderr: '' }
      if (args.includes('view')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            time: { '1.1.0': '2026-09-20T02:30:00.000Z', '2.0.0': '2026-10-05T08:00:00.000Z' }
          }),
          stderr: ''
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const stateStore = memoryStore()
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '2.0.0')
    expect((await stateStore.read('inst-1')).published).toEqual({
      '@xbzbing/dsh-git-panel': { version: '2.0.0', at: '2026-10-05T08:00:00.000Z' }
    })
  })

  it('升级后取不到新版本发布时间（如离线）：清掉旧版本的陈旧快照', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      // view 无输出（取不到发布时间）。
      return { code: 0, stdout: '', stderr: '' }
    })
    const stateStore = memoryStore()
    await stateStore.write(
      'inst-1',
      stateWith({
        lastCheckedAt: '2026-09-29T00:00:00.000Z',
        updates: {
          '@xbzbing/dsh-git-panel': {
            current: '1.1.0',
            latest: '2.0.0',
            compatible: true,
            dshPeer: null,
            dshVersion: null
          }
        },
        published: {
          '@xbzbing/dsh-git-panel': { version: '1.1.0', at: '2026-09-20T02:30:00.000Z' }
        }
      })
    )
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '2.0.0')
    expect((await manager.checkState(localInstance())).updates).toEqual({})
    expect((await stateStore.read('inst-1')).published).toEqual({})
  })

  it('卸载后清掉该插件的发布时间快照', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const stateStore = memoryStore()
    await stateStore.write(
      'inst-1',
      stateWith({
        published: {
          '@xbzbing/dsh-git-panel': { version: '1.1.0', at: '2026-09-20T02:30:00.000Z' },
          'dsh-free-search': { version: '0.4.39', at: '2026-09-10T00:00:00.000Z' }
        }
      })
    )
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    await manager.remove(localInstance(), '@xbzbing/dsh-git-panel')
    // 只清被卸载的那一项。
    expect((await stateStore.read('inst-1')).published).toEqual({
      'dsh-free-search': { version: '0.4.39', at: '2026-09-10T00:00:00.000Z' }
    })
  })

  it('检查进行中：checkState 报告在飞插件名（切走再回来显示检查中）', async () => {
    let release = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      await gate
      return {
        code: 0,
        stdout: JSON.stringify({ version: '2.0.0', peerDependencies: {} }),
        stderr: ''
      }
    })
    const manager = createPluginManager({ ...baseOptions(run), stateStore: memoryStore() })
    const pending = manager.check(localInstance(), '@xbzbing/dsh-git-panel')
    for (let i = 0; i < 50; i += 1) {
      if ((await manager.checkState(localInstance())).checking.length > 0) break
      await new Promise((r) => setTimeout(r, 0))
    }
    expect((await manager.checkState(localInstance())).checking).toEqual(['@xbzbing/dsh-git-panel'])
    release()
    await pending
    expect((await manager.checkState(localInstance())).checking).toEqual([])
  })

  it('setEnabled(禁用)：只从 bundles 移除，dependencies 不动，并记下原索引', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base', '@xbzbing/dsh-git-panel', 'dsh-free-search'],
      dependencies: ['@xbzbing/dsh-git-panel', 'dsh-free-search']
    })
    const stateStore = memoryStore()
    const manager = createPluginManager({
      ...baseOptions(run),
      stateStore,
      bundleStore: bundles.store
    })

    const result = await manager.setEnabled(localInstance(), '@xbzbing/dsh-git-panel', false)
    // profile 'web' 有 HMR → 启用/禁用走 dsh 默认规则，热生效
    expect(result).toEqual({
      name: '@xbzbing/dsh-git-panel',
      enabled: false,
      application: 'applied',
      exemptionGranted: null
    })
    expect(bundles.current.bundles).toEqual(['@deepseek-ai/dsh-base', 'dsh-free-search'])
    expect(bundles.current.dependencies).toEqual(['@xbzbing/dsh-git-panel', 'dsh-free-search'])
    // 记下原索引（1），供重新启用时插回原位
    expect((await stateStore.read('inst-1')).bundleIndex['@xbzbing/dsh-git-panel']).toBe(1)
  })

  it('setEnabled(启用)：按记录的原索引插回', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base', 'dsh-free-search'],
      dependencies: ['@xbzbing/dsh-git-panel', 'dsh-free-search']
    })
    const stateStore = memoryStore()
    await stateStore.write('inst-1', stateWith({ bundleIndex: { '@xbzbing/dsh-git-panel': 1 } }))
    const manager = createPluginManager({
      ...baseOptions(run),
      stateStore,
      bundleStore: bundles.store
    })

    await manager.setEnabled(localInstance(), '@xbzbing/dsh-git-panel', true)
    expect(bundles.calls[0]).toEqual({ name: '@xbzbing/dsh-git-panel', enabled: true, insertAt: 1 })
    expect(bundles.current.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@xbzbing/dsh-git-panel',
      'dsh-free-search'
    ])
  })

  it('setEnabled(启用)：不兼容插件的启用先授予 allow-version --accept-risk 豁免，再放进清单', async () => {
    const calls: Array<{ args: string[] }> = []
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      calls.push({ args })
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base', 'dsh-free-search'],
      dependencies: ['@xbzbing/dsh-git-panel', 'dsh-free-search']
    })
    const manager = createPluginManager({
      ...baseOptions(run),
      stateStore: memoryStore(),
      bundleStore: bundles.store,
      // profile 顶层 node_modules 里的插件声明与当前 dsh 不兼容（>=0.2.0，运行 0.1.7-rc.2）。
      readManifest: (dir) => {
        if (toPosix(dir).includes('@xbzbing/dsh-git-panel')) {
          return { ...GIT_PANEL_MANIFEST, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } }
        }
        return null
      }
    })

    const result = await manager.setEnabled(localInstance(), '@xbzbing/dsh-git-panel', true)
    // 先执行 allow-version（精确插件@版本 + --dsh-version + --accept-risk），再启用。
    const allowVersion = calls.find((call) => call.args.includes('allow-version'))
    expect(allowVersion).toBeDefined()
    expect(allowVersion!.args.slice(-5)).toEqual([
      'allow-version',
      '@xbzbing/dsh-git-panel@1.1.0',
      '--dsh-version',
      '0.1.7-rc.2',
      '--accept-risk'
    ])
    expect(bundles.calls[0]).toEqual({ name: '@xbzbing/dsh-git-panel', enabled: true })
    expect(result).toEqual({
      name: '@xbzbing/dsh-git-panel',
      enabled: true,
      application: 'applied',
      exemptionGranted: { pluginVersion: '1.1.0', dshVersion: '0.1.7-rc.2' }
    })
  })

  it('setEnabled(启用)：豁免键取 manifest 版本（列表版本可能与加载判据不一致）', async () => {
    const calls: Array<{ args: string[] }> = []
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      calls.push({ args })
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: ['@xbzbing/dsh-git-panel']
    })
    const manager = createPluginManager({
      ...baseOptions(run),
      stateStore: memoryStore(),
      bundleStore: bundles.store,
      // 列表说 1.1.0，manifest 说 1.1.1：dsh 加载时按 manifest 身份匹配豁免，须用后者。
      readManifest: (dir) => {
        if (toPosix(dir).includes('@xbzbing/dsh-git-panel')) {
          return {
            ...GIT_PANEL_MANIFEST,
            version: '1.1.1',
            peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' }
          }
        }
        return null
      }
    })

    const result = await manager.setEnabled(localInstance(), '@xbzbing/dsh-git-panel', true)
    const allowVersion = calls.find((call) => call.args.includes('allow-version'))
    expect(allowVersion!.args).toContain('@xbzbing/dsh-git-panel@1.1.1')
    expect(result.exemptionGranted).toEqual({ pluginVersion: '1.1.1', dshVersion: '0.1.7-rc.2' })
  })

  it('setEnabled(启用)：兼容插件不授予豁免，不执行 allow-version', async () => {
    const calls: Array<{ args: string[] }> = []
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      calls.push({ args })
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base', 'dsh-free-search'],
      dependencies: ['@xbzbing/dsh-git-panel', 'dsh-free-search']
    })
    const manager = createPluginManager({ ...baseOptions(run), bundleStore: bundles.store })

    const result = await manager.setEnabled(localInstance(), '@xbzbing/dsh-git-panel', true)
    expect(calls.some((call) => call.args.includes('allow-version'))).toBe(false)
    expect(result.exemptionGranted).toBeNull()
    expect(bundles.current.bundles).toContain('@xbzbing/dsh-git-panel')
  })

  it('setEnabled(启用)：豁免授予失败 → 报错且不加进加载清单', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      if (args.includes('allow-version')) {
        return {
          code: 1,
          stdout: '',
          stderr:
            'dsh: usage: dsh plugin allow-version <package@version> --dsh-version <exact> --accept-risk'
        }
      }
      return { code: 0, stdout: '', stderr: '' }
    })
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: ['@xbzbing/dsh-git-panel']
    })
    const manager = createPluginManager({
      ...baseOptions(run),
      stateStore: memoryStore(),
      bundleStore: bundles.store,
      readManifest: (dir) => {
        if (toPosix(dir).includes('@xbzbing/dsh-git-panel')) {
          return { ...GIT_PANEL_MANIFEST, peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } }
        }
        return null
      }
    })

    await expect(
      manager.setEnabled(localInstance(), '@xbzbing/dsh-git-panel', true)
    ).rejects.toThrow(/allow-version.*失败（exit 1）/)
    expect(bundles.calls).toEqual([])
    expect(bundles.current.bundles).toEqual(['@deepseek-ai/dsh-base'])
  })

  it('setEnabled(启用)：清除该插件的 autoDisabled 标记（提示条不再残留）', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: ['@xbzbing/dsh-git-panel']
    })
    const stateStore = memoryStore()
    await stateStore.write(
      'inst-1',
      stateWith({
        bundleIndex: { '@xbzbing/dsh-git-panel': 1 },
        runtimeVersion: '0.1.7-rc.2',
        autoDisabled: [
          { name: '@xbzbing/dsh-git-panel', version: '1.1.0', dshVersion: '0.1.7-rc.2' }
        ]
      })
    )
    const manager = createPluginManager({
      ...baseOptions(run),
      stateStore,
      bundleStore: bundles.store
    })

    await manager.setEnabled(localInstance(), '@xbzbing/dsh-git-panel', true)
    expect((await stateStore.read('inst-1')).autoDisabled).toEqual([])
    expect(bundles.current.bundles).toContain('@xbzbing/dsh-git-panel')
  })

  it('setEnabled：列表里已装但非本 profile 依赖的插件被拒', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const bundles = fakeBundles({ bundles: [], dependencies: ['other-plugin'] })
    const manager = createPluginManager({
      ...baseOptions(run),
      stateStore: memoryStore(),
      bundleStore: bundles.store
    })
    await expect(
      manager.setEnabled(localInstance(), '@xbzbing/dsh-git-panel', false)
    ).rejects.toThrow(/未安装/)
  })

  it('list：按 bundles 给出 enabled（无 host 半的插件为 null）', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
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

  it('reconcileRuntime：版本未变 → 无操作', async () => {
    const stateStore = memoryStore()
    await stateStore.write('inst-1', stateWith({ runtimeVersion: '0.2.0-rc.1' }))
    const bundles = fakeBundles({ bundles: ['a'], dependencies: ['a'] })
    const manager = createPluginManager({
      ...baseOptions(vi.fn()),
      stateStore,
      bundleStore: bundles.store
    })
    expect(await manager.reconcileRuntime(localInstance(), '0.2.0-rc.1')).toEqual({
      checked: false,
      disabled: []
    })
    expect(bundles.calls).toEqual([])
  })

  it('reconcileRuntime：版本变更 → 禁用与新版不兼容的 host 半插件并记录', async () => {
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base', 'bad-plugin', 'good-plugin'],
      dependencies: ['bad-plugin', 'good-plugin']
    })
    const stateStore = memoryStore()
    // bad-plugin 要求 ^0.2.0-rc.1；good-plugin 无 dsh peer 约束
    const manager = createPluginManager({
      ...baseOptions(vi.fn()),
      stateStore,
      bundleStore: bundles.store,
      readManifest: (dir) => {
        if (dir.includes('bad-plugin')) {
          return {
            name: 'bad-plugin',
            version: '1.0.0',
            dsh: { bundle: { patch: './cordis.patch.yml' } },
            peerDependencies: { '@deepseek-ai/dsh-llm': '^0.2.0-rc.1' }
          }
        }
        if (dir.includes('good-plugin')) {
          return {
            name: 'good-plugin',
            version: '2.0.0',
            dsh: { bundle: { patch: './cordis.patch.yml' } },
            peerDependencies: { '@deepseek-ai/dsh-llm': '^0.1.0' }
          }
        }
        return null
      }
    })

    const result = await manager.reconcileRuntime(localInstance(), '0.1.7-rc.2')
    expect(result.checked).toBe(true)
    expect(result.disabled).toEqual([
      { name: 'bad-plugin', version: '1.0.0', dshVersion: '0.1.7-rc.2' }
    ])
    // 只移除了不兼容的那个，且记下原索引
    expect(bundles.current.bundles).toEqual(['@deepseek-ai/dsh-base', 'good-plugin'])
    const state = await stateStore.read('inst-1')
    expect(state.runtimeVersion).toBe('0.1.7-rc.2')
    expect(state.autoDisabled).toEqual([
      { name: 'bad-plugin', version: '1.0.0', dshVersion: '0.1.7-rc.2' }
    ])
    expect(state.bundleIndex['bad-plugin']).toBe(1)
    // checkState 会把提示明细带给渲染层
    expect((await manager.checkState(localInstance())).autoDisabled).toHaveLength(1)
  })

  it('reconcileRuntime：纯 client 插件（无 host 半）不参与判定', async () => {
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base'],
      dependencies: ['client-only']
    })
    const manager = createPluginManager({
      ...baseOptions(vi.fn()),
      stateStore: memoryStore(),
      bundleStore: bundles.store,
      readManifest: () => ({
        name: 'client-only',
        version: '1.0.0',
        dsh: { client: { platform: 'web' } },
        peerDependencies: { '@deepseek-ai/dsh-llm': '^9.0.0' }
      })
    })
    expect(await manager.reconcileRuntime(localInstance(), '0.1.7-rc.2')).toEqual({
      checked: true,
      disabled: []
    })
  })

  it('reconcileRuntime：profile 尚未初始化 → 只记版本，不判定', async () => {
    const store: ProfileBundleStore = {
      read: async () => null,
      setEnabled: async () => []
    }
    const stateStore = memoryStore()
    const manager = createPluginManager({ ...baseOptions(vi.fn()), stateStore, bundleStore: store })
    expect(await manager.reconcileRuntime(localInstance(), '0.1.7-rc.2')).toEqual({
      checked: false,
      disabled: []
    })
    expect((await stateStore.read('inst-1')).runtimeVersion).toBe('0.1.7-rc.2')
  })

  it('未安装的插件 → 抛错', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({
      code: 0,
      stdout: LIST_JSON,
      stderr: ''
    }))
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.check(localInstance(), 'nope')).rejects.toThrow(/未安装/)
  })

  it('兼容判定按实际执行命令的 dsh 版本（注册表固定版本未装、回落到 hub 副本时不再误报兼容）', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return {
        code: 0,
        stdout: JSON.stringify({
          version: '0.24.1',
          peerDependencies: { '@deepseek-ai/dsh-llm': '^0.2.0-rc.1' }
        }),
        stderr: ''
      }
    })
    const manager = createPluginManager(baseOptions(run))
    // 注册表固定 0.2.0-rc.1（hub 未装、PATH 未探到）→ 命令实际由 hub 的 0.1.7-rc.2 执行，
    // 判定必须按 0.1.7-rc.2：0.24.1 的 ^0.2.0-rc.1 不满足 → 不给升级按钮。
    const check = await manager.check(
      localInstance({ dshVersion: '0.2.0-rc.1' }),
      '@xbzbing/dsh-git-panel'
    )
    expect(check.dshVersion).toBe('0.1.7-rc.2')
    expect(check.compatible).toBe(false)
  })

  it('公共空间 + 自定义启动器：按系统 dsh 版本判兼容（0.2.0-rc.1 满足 ^0.2.0-rc.1）', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return {
        code: 0,
        stdout: JSON.stringify({
          version: '0.24.1',
          peerDependencies: { '@deepseek-ai/dsh-llm': '^0.2.0-rc.1' }
        }),
        stderr: ''
      }
    })
    const manager = createPluginManager({
      ...baseOptions(run),
      pathProbe: {
        probe: async () => ({ command: '/usr/local/bin/dsh', version: '0.2.0-rc.1' })
      }
    })
    const check = await manager.check(
      localInstance({ useDefaultSpace: true, launcher: 'duush', dshVersion: '0.1.7-rc.2' }),
      '@xbzbing/dsh-git-panel'
    )
    expect(check.dshVersion).toBe('0.2.0-rc.1')
    expect(check.compatible).toBe(true)
  })
})

describe('createPluginManager mutations', () => {
  it('upgrade：显式版本 add name@version，返回 host 半', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    const result = await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')
    expect(result.hasHostSide).toBe(true)
    const addCall = run.mock.calls.find(([, args]) => args.includes('add'))!
    expect(addCall[1]).toContain('@xbzbing/dsh-git-panel@1.2.0')
  })

  it('remove：卸载前判 host 半', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    const result = await manager.remove(localInstance(), '@xbzbing/dsh-git-panel')
    expect(result.hasHostSide).toBe(true)
    const removeCall = run.mock.calls.find(([, args]) => args.includes('remove'))!
    expect(removeCall[1]).toContain('remove')
    expect(removeCall[1]).toContain('@xbzbing/dsh-git-panel')
  })

  it('profileHasHmr：web profile 与含 web-app bundle 的 profile 有 HMR，其余保守为无', () => {
    expect(profileHasHmr('web', null)).toBe(true)
    expect(profileHasHmr('my-web', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])).toBe(
      true
    )
    expect(profileHasHmr('headless', ['@deepseek-ai/dsh-base'])).toBe(false)
    expect(profileHasHmr('custom', null)).toBe(false)
  })

  it('install（web/HMR）→ applied；替换已装包同样热生效（与 dsh 同口径，无重启特例）', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    // 全新包名：before 里没有 new-plugin
    const fresh = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    expect((await fresh.install(localInstance(), 'new-plugin')).application).toBe('applied')

    // 已装包名（重装/替换）：dsh-hmr 按磁盘身份热重载新模块代 → 同样 applied，不要求重启。
    const replace = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    expect(
      (await replace.install(localInstance(), '@xbzbing/dsh-git-panel@1.2.0')).application
    ).toBe('applied')
  })

  it('install：无 HMR 的 profile → 即使全新包名也需重启', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const manager = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    const instance = localInstance({ profile: 'headless' })
    expect((await manager.install(instance, 'new-plugin')).application).toBe('restart-required')
  })

  it('upgrade → 走默认规则：web/HMR 下 applied（替换已装包同样热生效），无 HMR 下 restart-required', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    // web profile（默认）：dsh-hmr 热重载新模块代 → applied，不因换版本要求重启。
    const web = createPluginManager({ ...baseOptions(run) })
    const webResult = await web.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')
    expect(webResult.application).toBe('applied')

    // 无 HMR 的 profile：包已装但宿主无法热重载 → 需重启。
    const headless = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    const headlessResult = await headless.upgrade(
      localInstance({ profile: 'headless' }),
      '@xbzbing/dsh-git-panel',
      '1.2.0'
    )
    expect(headlessResult.application).toBe('restart-required')
  })

  it('remove → 走默认规则：web/HMR 下 applied，无 HMR 下 restart-required', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const web = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    expect((await web.remove(localInstance(), '@xbzbing/dsh-git-panel')).application).toBe(
      'applied'
    )

    const headless = createPluginManager({
      ...baseOptions(run),
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    expect(
      (await headless.remove(localInstance({ profile: 'headless' }), '@xbzbing/dsh-git-panel'))
        .application
    ).toBe('restart-required')
  })

  it('install：profile 层 patch 显式关闭 HMR → 全新安装也要重启（保守覆盖启发式）', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'plugin-manager-hmr-'))
    tempRoots.push(dataRoot)
    // profile 'web' 本会被启发式判为有 HMR，但用户层 patch 显式关掉了它。
    const profileDir = join(dataRoot, 'homes', 'inst-1', 'profiles', 'web')
    await mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'cordis.patch.yml'), '- id: hmr\n  disabled: true\n', 'utf8')

    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const manager = createPluginManager({
      ...baseOptions(run),
      dataRoot,
      bundleStore: fakeBundles({
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
        dependencies: ['@xbzbing/dsh-git-panel']
      }).store
    })
    expect((await manager.install(localInstance(), 'new-plugin')).application).toBe(
      'restart-required'
    )
  })

  it('install：spec 原样透传给 add', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    await manager.install(localInstance(), 'github:owner/repo')
    const addCall = run.mock.calls.find(([, args]) => args.includes('add'))!
    expect(addCall[1]).toContain('github:owner/repo')
  })
})

describe('createPluginManager.resolveInstall', () => {
  /** view 命令的目标（args: [entry, plugin, --profile, <profile>, view, <spec>, …]）。 */
  function viewed(args: string[]): string {
    return args[args.indexOf('view') + 1] ?? ''
  }

  /** 假 dsh：list 返回已装清单；view 按目标 spec 给出应答（裸名与 `name@版本` 形状不同）。 */
  function stubRun(view: (spec: string) => unknown) {
    return vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: JSON.stringify(view(viewed(args)) ?? {}), stderr: '' }
    })
  }

  /** 假 registry：dist-tags.latest 滞后（1.0.0），versions 不按版本序且含更新的 1.1.0。 */
  const NAME_META = {
    version: '1.0.0',
    'dist-tags': { latest: '1.0.0', beta: '2.0.0-beta.1' },
    versions: ['0.1.10', '0.1.2', '0.1.20', '1.0.0', '1.1.0'],
    peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' },
    time: {
      created: '2026-01-01T00:00:00.000Z',
      '1.0.0': '2026-09-01T00:00:00.000Z',
      '1.1.0': '2026-09-20T00:00:00.000Z'
    }
  }

  /** 目标版本单独的 view 应答：peer 与发布时间是 1.1.0 口径（与 NAME_META 故意不同）。 */
  const TARGET_META = {
    peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
    time: { '1.1.0': '2026-09-20T00:00:00.000Z' }
  }

  it('裸名：dist-tags.latest 滞后时取最大稳定版，并按目标版本补查 peer 与发布时间', async () => {
    const run = stubRun((spec) => (spec === 'demo-plugin' ? NAME_META : TARGET_META))
    const manager = createPluginManager(baseOptions(run))
    const plan = await manager.resolveInstall(localInstance(), 'demo-plugin')

    expect(plan).toEqual({
      installSpec: 'demo-plugin@1.1.0',
      input: 'demo-plugin',
      kind: 'npm',
      packageName: 'demo-plugin',
      targetVersion: '1.1.0',
      latestVersion: '1.0.0',
      versionSource: 'resolved-latest',
      publishedAt: '2026-09-20T00:00:00.000Z',
      dshPeer: '>=0.1.7-rc.2',
      dshVersion: '0.1.7-rc.2',
      compatible: true,
      installedVersion: null
    })

    const views = run.mock.calls.filter(([, args]) => args.includes('view'))
    expect(views).toHaveLength(2)
    // 第一次按裸名查全量字段，第二次按解析出的版本查 peer 与发布时间。
    expect(viewed(views[0]![1])).toBe('demo-plugin')
    expect(views[0]![1]).toEqual(
      expect.arrayContaining([
        'version',
        'versions',
        'dist-tags',
        'peerDependencies',
        'time',
        '--json'
      ])
    )
    expect(viewed(views[1]![1])).toBe('demo-plugin@1.1.0')
  })

  it('裸名：全是预发布时取最大预发布（数字感知，beta.10 > beta.2）', async () => {
    const preMeta = {
      version: '2.0.0-beta.1',
      'dist-tags': { latest: '2.0.0-beta.1' },
      versions: ['2.0.0-beta.2', '2.0.0-beta.10', '2.0.0-beta.1'],
      peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
      time: { '2.0.0-beta.10': '2026-09-25T00:00:00.000Z' }
    }
    const run = stubRun(() => preMeta)
    const manager = createPluginManager(baseOptions(run))
    const plan = await manager.resolveInstall(localInstance(), 'demo-plugin')

    expect(plan.targetVersion).toBe('2.0.0-beta.10')
    expect(plan.installSpec).toBe('demo-plugin@2.0.0-beta.10')
    expect(plan.latestVersion).toBe('2.0.0-beta.1')
    expect(plan.publishedAt).toBe('2026-09-25T00:00:00.000Z')
    const views = run.mock.calls.filter(([, args]) => args.includes('view'))
    expect(views).toHaveLength(2)
    expect(viewed(views[1]![1])).toBe('demo-plugin@2.0.0-beta.10')
  })

  it('显式版本：targetVersion 是用户请求的版本（不被 registry latest 覆盖），peer 与发布时间取该版本视图', async () => {
    const installedList = JSON.stringify([
      {
        name: 'dsh-profile-web',
        dependencies: {
          'demo-plugin': {
            from: 'demo-plugin',
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.0.0.tgz',
            path: '/node_modules/demo-plugin'
          }
        }
      }
    ])
    // 假 registry：dist-tag latest 已是 1.1.0，但用户显式要 1.0.0。
    const versionMeta = {
      version: '1.1.0',
      peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
      time: { '1.0.0': '2026-08-01T00:00:00.000Z', '1.1.0': '2026-09-20T00:00:00.000Z' }
    }
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: installedList, stderr: '' }
      return { code: 0, stdout: JSON.stringify(versionMeta), stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    const plan = await manager.resolveInstall(localInstance(), 'demo-plugin@1.0.0')

    expect(plan).toMatchObject({
      installSpec: 'demo-plugin@1.0.0',
      targetVersion: '1.0.0',
      versionSource: 'requested',
      latestVersion: null,
      publishedAt: '2026-08-01T00:00:00.000Z',
      dshPeer: '>=0.1.7-rc.2',
      compatible: true,
      installedVersion: '1.0.0'
    })
    const views = run.mock.calls.filter(([, args]) => args.includes('view'))
    expect(views).toHaveLength(1)
    expect(viewed(views[0]![1])).toBe('demo-plugin@1.0.0')
    expect(views[0]![1]).toContain('peerDependencies')
  })

  it('scoped 包名的 @ 属于包名：name@版本 拆出正确包名与版本', async () => {
    const run = stubRun(() => TARGET_META)
    const manager = createPluginManager(baseOptions(run))
    const plan = await manager.resolveInstall(localInstance(), '@xbzbing/dsh-git-panel@1.2.0')

    expect(plan.packageName).toBe('@xbzbing/dsh-git-panel')
    expect(plan.installSpec).toBe('@xbzbing/dsh-git-panel@1.2.0')
    const viewCall = run.mock.calls.find(([, args]) => args.includes('view'))!
    expect(viewed(viewCall[1])).toBe('@xbzbing/dsh-git-panel@1.2.0')
  })

  it('已装同名插件：给出 installedVersion（渲染层显示「将替换」）', async () => {
    const run = stubRun((spec) => (spec === '@xbzbing/dsh-git-panel' ? NAME_META : TARGET_META))
    const manager = createPluginManager(baseOptions(run))
    const plan = await manager.resolveInstall(localInstance(), '@xbzbing/dsh-git-panel')

    expect(plan.packageName).toBe('@xbzbing/dsh-git-panel')
    expect(plan.targetVersion).toBe('1.1.0')
    expect(plan.installedVersion).toBe('1.1.0')
  })

  it('dist-tag：name@latest 与裸名同口径，dist-tag 滞后时取最大稳定版', async () => {
    const run = stubRun((spec) => (spec === 'demo-plugin' ? NAME_META : TARGET_META))
    const manager = createPluginManager(baseOptions(run))
    const plan = await manager.resolveInstall(localInstance(), 'demo-plugin@latest')

    // `latest` 只是「最新」的惯用写法：不能因为 dist-tag 滞后就装到旧版。
    expect(plan.targetVersion).toBe('1.1.0')
    expect(plan.installSpec).toBe('demo-plugin@1.1.0')
    expect(plan.versionSource).toBe('requested')
    expect(plan.latestVersion).toBe('1.0.0')
    const views = run.mock.calls.filter(([, args]) => args.includes('view'))
    expect(views).toHaveLength(2)
    expect(viewed(views[1]![1])).toBe('demo-plugin@1.1.0')
  })

  it('dist-tag：非 latest 渠道按标签取版本，并补查该版本的 peer 与发布时间', async () => {
    const run = stubRun((spec) => (spec === 'demo-plugin' ? NAME_META : TARGET_META))
    const manager = createPluginManager(baseOptions(run))
    const plan = await manager.resolveInstall(localInstance(), 'demo-plugin@beta')

    expect(plan.targetVersion).toBe('2.0.0-beta.1')
    expect(plan.installSpec).toBe('demo-plugin@2.0.0-beta.1')
    const views = run.mock.calls.filter(([, args]) => args.includes('view'))
    expect(views).toHaveLength(2)
    expect(viewed(views[1]![1])).toBe('demo-plugin@2.0.0-beta.1')
  })

  it('dist-tag 不存在 → not-found', async () => {
    const run = stubRun((spec) => (spec === 'demo-plugin' ? NAME_META : TARGET_META))
    const manager = createPluginManager(baseOptions(run))
    await expect(
      manager.resolveInstall(localInstance(), 'demo-plugin@canary')
    ).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('没有标签 canary')
    })
  })

  it('github/file：不执行任何命令，只规范化展示来源', async () => {
    const run = vi.fn(async (): Promise<CommandResult> => ({ code: 0, stdout: '', stderr: '' }))
    const manager = createPluginManager(baseOptions(run))

    await expect(
      manager.resolveInstall(localInstance(), 'github:owner/repo#v1.0.0')
    ).resolves.toEqual({
      installSpec: 'github:owner/repo#v1.0.0',
      input: 'github:owner/repo#v1.0.0',
      kind: 'github',
      packageName: null,
      targetVersion: null,
      latestVersion: null,
      versionSource: 'none',
      publishedAt: null,
      dshPeer: null,
      dshVersion: null,
      compatible: null,
      installedVersion: null
    })
    const file = await manager.resolveInstall(localInstance(), 'file:/tmp/demo-plugin')
    expect(file).toMatchObject({
      kind: 'file',
      installSpec: 'file:/tmp/demo-plugin',
      compatible: null
    })
    const git = await manager.resolveInstall(
      localInstance(),
      'git+https://github.com/owner/repo.git'
    )
    expect(git.kind).toBe('github')
    expect(run).not.toHaveBeenCalled()
  })

  it('插件未发布到 npm（404）→ not-found，文案说明未发布', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return {
        code: 1,
        stdout: '',
        stderr: 'ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/demo-plugin: Not Found - 404'
      }
    })
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.resolveInstall(localInstance(), 'demo-plugin')).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('未发布到 npm registry')
    })
  })

  it('显式版本不存在（404）→ not-found，文案点名该版本', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return {
        code: 1,
        stdout: '',
        stderr:
          'Command failed: pnpm view demo-plugin@9.9.9 peerDependencies time --json\nNot Found - 404'
      }
    })
    const manager = createPluginManager(baseOptions(run))
    await expect(
      manager.resolveInstall(localInstance(), 'demo-plugin@9.9.9')
    ).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('版本不存在：demo-plugin@9.9.9')
    })
  })

  it('输出不可解析 → internal（拿不到版本就不给计划）', async () => {
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: 'not json', stderr: '' }
    })
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.resolveInstall(localInstance(), 'demo-plugin')).rejects.toMatchObject({
      code: 'internal'
    })
  })
})

describe('createPluginManager registry 口径', () => {
  const VIEW_META = {
    version: '1.2.0',
    'dist-tags': { latest: '1.2.0' },
    versions: ['1.1.0', '1.2.0'],
    peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
    time: { '1.1.0': '2026-09-20T02:30:00.000Z', '1.2.0': '2026-09-28T11:16:59.586Z' }
  }

  /** 假 dsh：list / view 都按固定应答返回；add 等改动命令返回空输出。 */
  function registryRun() {
    return vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      if (args.includes('view')) return { code: 0, stdout: JSON.stringify(VIEW_META), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
  }

  it('resolveInstall：view 带所选 --registry（缺省 npmmirror，可切 npmjs）', async () => {
    const byDefault = registryRun()
    await createPluginManager(baseOptions(byDefault)).resolveInstall(localInstance(), 'demo-plugin')
    const defaultView = byDefault.mock.calls.find(([, args]) => args.includes('view'))!
    expect(defaultView[1].slice(-2)).toEqual(['--registry', 'https://registry.npmmirror.com'])

    const byNpmjs = registryRun()
    await createPluginManager(baseOptions(byNpmjs)).resolveInstall(localInstance(), 'demo-plugin', {
      registry: 'npmjs'
    })
    const npmjsView = byNpmjs.mock.calls.find(([, args]) => args.includes('view'))!
    expect(npmjsView[1].slice(-2)).toEqual(['--registry', 'https://registry.npmjs.org'])
  })

  it('install：add 带所选 --registry，与解析同源', async () => {
    const byDefault = registryRun()
    await createPluginManager({
      ...baseOptions(byDefault),
      bundleStore: fakeBundles({ bundles: ['@deepseek-ai/dsh-base'], dependencies: [] }).store
    }).install(localInstance(), 'demo-plugin@1.2.0')
    const defaultAdd = byDefault.mock.calls.find(([, args]) => args.includes('add'))!
    expect(defaultAdd[1]).toContain('demo-plugin@1.2.0')
    expect(defaultAdd[1].slice(-2)).toEqual(['--registry', 'https://registry.npmmirror.com'])

    const byNpmjs = registryRun()
    await createPluginManager({
      ...baseOptions(byNpmjs),
      bundleStore: fakeBundles({ bundles: ['@deepseek-ai/dsh-base'], dependencies: [] }).store
    }).install(localInstance(), 'demo-plugin@1.2.0', { registry: 'npmjs' })
    const npmjsAdd = byNpmjs.mock.calls.find(([, args]) => args.includes('add'))!
    expect(npmjsAdd[1].slice(-2)).toEqual(['--registry', 'https://registry.npmjs.org'])
  })

  it('check 与 upgrade 未注入镜像设置时按缺省源（npmmirror）追加 --registry', async () => {
    const run = registryRun()
    const manager = createPluginManager(baseOptions(run))
    await manager.check(localInstance(), '@xbzbing/dsh-git-panel')
    await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')

    const views = run.mock.calls.filter(([, args]) => args.includes('view'))
    expect(views.length).toBeGreaterThan(0)
    for (const [, args] of views) {
      expect(args.slice(-2)).toEqual(['--registry', 'https://registry.npmmirror.com'])
    }
    const addCall = run.mock.calls.find(([, args]) => args.includes('add'))!
    expect(addCall[1].slice(-2)).toEqual(['--registry', 'https://registry.npmmirror.com'])
  })

  it('defaultRegistry 注入（镜像设为 npmjs）：check/resolve/upgrade 的缺省都跟随，显式档位优先', async () => {
    const run = registryRun()
    const manager = createPluginManager({
      ...baseOptions(run),
      defaultRegistry: () => 'npmjs'
    })
    await manager.check(localInstance(), '@xbzbing/dsh-git-panel')
    await manager.resolveInstall(localInstance(), 'demo-plugin')
    await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0')

    for (const [, args] of run.mock.calls.filter(([, callArgs]) => callArgs.includes('view'))) {
      expect(args.slice(-2)).toEqual(['--registry', 'https://registry.npmjs.org'])
    }
    const addCall = run.mock.calls.find(([, args]) => args.includes('add'))!
    expect(addCall[1].slice(-2)).toEqual(['--registry', 'https://registry.npmjs.org'])

    // 显式档位压过注入的默认档：本次操作用户改选了 npmmirror 就按 npmmirror。
    const explicit = registryRun()
    await createPluginManager({
      ...baseOptions(explicit),
      defaultRegistry: () => 'npmjs'
    }).upgrade(localInstance(), '@xbzbing/dsh-git-panel', '1.2.0', { registry: 'npmmirror' })
    const explicitAdd = explicit.mock.calls.find(([, args]) => args.includes('add'))!
    expect(explicitAdd[1].slice(-2)).toEqual(['--registry', 'https://registry.npmmirror.com'])
  })

  it('upgrade：可改选安装源（npmjs 走 npmjs，npmmirror 与缺省同参）', async () => {
    const byNpmjs = registryRun()
    await createPluginManager(baseOptions(byNpmjs)).upgrade(
      localInstance(),
      '@xbzbing/dsh-git-panel',
      '1.2.0',
      { registry: 'npmjs' }
    )
    const npmjsAdd = byNpmjs.mock.calls.find(([, args]) => args.includes('add'))!
    expect(npmjsAdd[1]).toContain('@xbzbing/dsh-git-panel@1.2.0')
    expect(npmjsAdd[1].slice(-2)).toEqual(['--registry', 'https://registry.npmjs.org'])

    // 显式 npmmirror 与缺省升级发同一条命令（缺省即默认档，无隐式差异）。
    const explicit = registryRun()
    await createPluginManager(baseOptions(explicit)).upgrade(
      localInstance(),
      '@xbzbing/dsh-git-panel',
      '1.2.0',
      { registry: 'npmmirror' }
    )
    const omitted = registryRun()
    await createPluginManager(baseOptions(omitted)).upgrade(
      localInstance(),
      '@xbzbing/dsh-git-panel',
      '1.2.0'
    )
    const explicitAdd = explicit.mock.calls.find(([, args]) => args.includes('add'))!
    const omittedAdd = omitted.mock.calls.find(([, args]) => args.includes('add'))!
    expect(explicitAdd[1].slice(-2)).toEqual(['--registry', 'https://registry.npmmirror.com'])
    expect(omittedAdd[1]).toEqual(explicitAdd[1])
  })
})

describe('createPluginManager install：安装后启用', () => {
  const GIT_PANEL = '@xbzbing/dsh-git-panel'

  it('install(enable:false)：add 之后把真实包名移出加载清单；缺省不触碰清单', async () => {
    const order: string[] = []
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      if (args.includes('add')) order.push('add')
      return { code: 0, stdout: '', stderr: '' }
    })
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base', GIT_PANEL],
      dependencies: [GIT_PANEL]
    })
    const store: ProfileBundleStore = {
      read: bundles.store.read,
      setEnabled: async (dir, name, enabled, insertAt) => {
        order.push('setEnabled')
        return bundles.store.setEnabled(dir, name, enabled, insertAt)
      }
    }
    const manager = createPluginManager({ ...baseOptions(run), bundleStore: store })
    await manager.install(localInstance(), `${GIT_PANEL}@1.2.0`, { enable: false })

    expect(order).toEqual(['add', 'setEnabled'])
    expect(bundles.calls).toEqual([{ name: GIT_PANEL, enabled: false }])
    // 落到「已禁用」：移出 bundles，保留 dependency。
    expect(bundles.current.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(bundles.current.dependencies).toEqual([GIT_PANEL])

    // enable 缺省：不额外改动加载清单（保持 dsh add 的默认启用行为）。
    const untouched = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base', GIT_PANEL],
      dependencies: [GIT_PANEL]
    })
    const defaultManager = createPluginManager({
      ...baseOptions(run),
      bundleStore: untouched.store
    })
    await defaultManager.install(localInstance(), `${GIT_PANEL}@1.2.0`)
    expect(untouched.calls).toEqual([])
    expect(untouched.current.bundles).toEqual(['@deepseek-ai/dsh-base', GIT_PANEL])
  })

  it('install(enable:false)：纯 client 插件或列表里找不到包名 → 跳过禁用，不报错', async () => {
    const clientOnlyList = JSON.stringify([
      {
        name: 'dsh-profile-web',
        dependencies: {
          'client-only': {
            from: 'client-only',
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/client-only/-/client-only-1.0.0.tgz',
            path: '/node_modules/client-only'
          }
        }
      }
    ])
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: clientOnlyList, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    })
    const bundles = fakeBundles({ bundles: [], dependencies: ['client-only'] })
    const manager = createPluginManager({ ...baseOptions(run), bundleStore: bundles.store })

    const result = await manager.install(localInstance(), 'client-only', { enable: false })
    expect(result.hasHostSide).toBe(false)
    expect(bundles.calls).toEqual([])

    await manager.install(localInstance(), 'brand-new-plugin', { enable: false })
    expect(bundles.calls).toEqual([])
  })
})

describe('createPluginManager.packageInfo', () => {
  const DOWNLOADS = { count: 4310, start: '2026-09-13', end: '2026-10-12' }
  const NOTES = {
    text: '修了几个 bug',
    source: 'github-release' as const,
    pageUrl: 'https://github.com/demo/demo-plugin/releases/tag/v1.1.0',
    truncated: false
  }

  /** 取数桩：记录调用，返回固定下载量与更新内容（真实网络行为在 plugin-package-info.test.ts 覆盖）。 */
  function stubPackageInfo(): {
    fetchers: PackageInfoFetchers
    downloads: string[]
    notes: unknown[]
  } {
    const downloads: string[] = []
    const notes: unknown[] = []
    return {
      downloads,
      notes,
      fetchers: {
        fetchDownloads: async (name) => {
          downloads.push(name)
          return DOWNLOADS
        },
        fetchReleaseNotes: async (input) => {
          notes.push(input)
          return NOTES
        }
      }
    }
  }

  /** 假 dsh：list 返回已装清单；view 返回 registry 元数据（repository/homepage）。 */
  function stubRun(viewMeta: unknown) {
    return vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: JSON.stringify(viewMeta), stderr: '' }
    })
  }

  it('有 github 仓库：仓库地址由 view 推导后交给取数器（渲染层不传 URL）', async () => {
    const stub = stubPackageInfo()
    const run = stubRun({
      repository: { type: 'git', url: 'git+https://github.com/demo/demo-plugin.git' }
    })
    const manager = createPluginManager({ ...baseOptions(run), packageInfoFetchers: stub.fetchers })
    const info = await manager.packageInfo(localInstance(), 'demo-plugin', '1.1.0')

    expect(info).toEqual({ downloads: DOWNLOADS, releaseNotes: NOTES })
    expect(stub.downloads).toEqual(['demo-plugin'])
    expect(stub.notes).toEqual([
      {
        repoUrl: 'https://github.com/demo/demo-plugin',
        version: '1.1.0',
        fallbackPageUrl: 'https://www.npmjs.com/package/demo-plugin'
      }
    ])
    const viewCall = run.mock.calls.find(([, args]) => args.includes('view'))!
    expect(viewCall[1]).toContain('repository')
    expect(viewCall[1].slice(-2)).toEqual(['--registry', 'https://registry.npmmirror.com'])
  })

  it('没有 github 仓库：不取 Release 内容，回落 npm 包页', async () => {
    const stub = stubPackageInfo()
    const run = stubRun({ homepage: 'https://example.com/demo' })
    const manager = createPluginManager({ ...baseOptions(run), packageInfoFetchers: stub.fetchers })
    const info = await manager.packageInfo(localInstance(), 'demo-plugin', '1.1.0')

    expect(info).toEqual({
      downloads: DOWNLOADS,
      releaseNotes: {
        text: null,
        source: 'none',
        pageUrl: 'https://www.npmjs.com/package/demo-plugin',
        truncated: false
      }
    })
    expect(stub.notes).toEqual([])
  })

  it('view 失败（离线 / 未发布）不是错误：下载量照常返回，更新内容降级为 none', async () => {
    const stub = stubPackageInfo()
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 1, stdout: '', stderr: 'ERR_PNPM_FETCH_404 Not Found - 404' }
    })
    const manager = createPluginManager({ ...baseOptions(run), packageInfoFetchers: stub.fetchers })
    const info = await manager.packageInfo(localInstance(), 'demo-plugin', '1.1.0')

    expect(info.downloads).toEqual(DOWNLOADS)
    expect(info.releaseNotes.source).toBe('none')
    expect(info.releaseNotes.pageUrl).toBe('https://www.npmjs.com/package/demo-plugin')
  })
})
