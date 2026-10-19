import { describe, expect, it, vi } from 'vitest'
import { createPluginManager } from './plugin-manager'
import type { ProfileBundleStore } from './profile-bundles'
import {
  baseOptions,
  fakeBundles,
  localInstance,
  memoryStore,
  okResult,
  stateWith,
  fakeRun,
  toPosix,
  GIT_PANEL_MANIFEST
} from './plugin-manager.testkit'

describe('createPluginManager.setEnabled', () => {
  it('setEnabled(禁用)：只从 bundles 移除，dependencies 不动，并记下原索引', async () => {
    const run = fakeRun()
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
    const run = fakeRun()
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
    const run = fakeRun()
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
    const allowVersion = run.mock.calls.find(([, args]) => args.includes('allow-version'))?.[1]
    expect(allowVersion).toBeDefined()
    expect(allowVersion!.slice(-5)).toEqual([
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
    const run = fakeRun()
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
    const allowVersion = run.mock.calls.find(([, args]) => args.includes('allow-version'))?.[1]
    expect(allowVersion).toContain('@xbzbing/dsh-git-panel@1.1.1')
    expect(result.exemptionGranted).toEqual({ pluginVersion: '1.1.1', dshVersion: '0.1.7-rc.2' })
  })

  it('setEnabled(启用)：兼容插件不授予豁免，不执行 allow-version', async () => {
    const run = fakeRun()
    const bundles = fakeBundles({
      bundles: ['@deepseek-ai/dsh-base', 'dsh-free-search'],
      dependencies: ['@xbzbing/dsh-git-panel', 'dsh-free-search']
    })
    const manager = createPluginManager({ ...baseOptions(run), bundleStore: bundles.store })

    const result = await manager.setEnabled(localInstance(), '@xbzbing/dsh-git-panel', true)
    expect(run.mock.calls.some(([, args]) => args.includes('allow-version'))).toBe(false)
    expect(result.exemptionGranted).toBeNull()
    expect(bundles.current.bundles).toContain('@xbzbing/dsh-git-panel')
  })

  it('setEnabled(启用)：豁免授予失败 → 报错且不加进加载清单', async () => {
    const run = fakeRun((args) =>
      args.includes('allow-version')
        ? {
            code: 1,
            stdout: '',
            stderr:
              'dsh: usage: dsh plugin allow-version <package@version> --dsh-version <exact> --accept-risk'
          }
        : okResult()
    )
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
    const run = fakeRun()
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
    const run = fakeRun()
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
})

describe('createPluginManager.reconcileRuntime', () => {
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
})
