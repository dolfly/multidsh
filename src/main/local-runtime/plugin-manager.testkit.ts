import { rm } from 'node:fs/promises'
import { afterEach } from 'vitest'
import type { PluginManagerOptions } from './plugin-manager'
import type { LocalInstance } from '@shared/contracts'
import type { PluginCheckState, PluginStateStore } from './plugin-state'
import type { ProfileBundleStore, ProfileBundles } from './profile-bundles'

/** 路径分隔符归一化，使断言在 win32（反斜杠）与 POSIX 上一致。 */
export const toPosix = (path: string): string => path.replace(/\\/g, '/')

export const now = new Date().toISOString()

export function localInstance(overrides: Partial<LocalInstance> = {}): LocalInstance {
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
export function fakeInstaller(): PluginManagerOptions['installer'] {
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
export function fakeBundles(initial: { bundles: string[]; dependencies: string[] }): {
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

export const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** 完整的检查状态字面量（缺省为空状态），避免每处重复列全部字段。 */
export function stateWith(patch: Partial<PluginCheckState> = {}): PluginCheckState {
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
export function memoryStore(): PluginStateStore {
  const files = new Map<string, PluginCheckState>()
  return {
    read: async (instanceId) => files.get(instanceId) ?? stateWith(),
    write: async (instanceId, state) => {
      files.set(instanceId, state)
    }
  }
}

export const LIST_JSON = JSON.stringify([
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

export const GIT_PANEL_MANIFEST = {
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

export const FREE_SEARCH_MANIFEST = {
  name: 'dsh-free-search',
  version: '0.4.39',
  description: 'Search',
  license: 'MIT',
  dependencies: { 'some-dep': '^1.0.0' },
  peerDependencies: { '@deepseek-ai/dsh-tools': '^0.1.7-rc.1' },
  engines: { node: '>=20' },
  dsh: { bundle: { patch: 'cordis.patch.yml' }, client: true }
}

export function manifestFor(dir: string): Record<string, unknown> | null {
  if (dir.includes('git-panel')) return GIT_PANEL_MANIFEST
  if (dir.includes('free-search')) return FREE_SEARCH_MANIFEST
  return null
}

export function baseOptions(run: PluginManagerOptions['run']): PluginManagerOptions {
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
