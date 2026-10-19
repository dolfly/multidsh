import { describe, expect, it, vi } from 'vitest'
import { createPluginManager } from './plugin-manager'
import type { ProfileBundleStore } from './profile-bundles'
import {
  LIST_JSON,
  baseOptions,
  fakeBundles,
  localInstance,
  memoryStore,
  okResult,
  stateWith,
  stubRun,
  toPosix,
  GIT_PANEL_MANIFEST
} from './plugin-manager.testkit'

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
    const run = stubRun(VIEW_JSON)
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
    const run = stubRun(VIEW_JSON)
    const manager = createPluginManager(baseOptions(run))
    await manager.check(localInstance({ profile: 'tui' }), '@xbzbing/dsh-git-panel')
    expect(run.mock.calls[1]![1]).toEqual([
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
    // 已装 1.1.0 不在 time 里（本地 file: 安装 / 版本已下架）。
    const run = stubRun(JSON.stringify({ version: '1.2.0', time: { '1.2.0': 'x' } }))
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
    // pnpm view 对未发布包返回 exit 1，stderr 含 404 标记。
    const run = stubRun({
      code: 1,
      stdout: '',
      stderr:
        'Command failed with exit code 1: pnpm view dsh-opencode-zen-provider version peerDependencies time --json\nERR_PNPM_FETCH_404 GET https://registry.npmjs.org/dsh-opencode-zen-provider: Not Found - 404'
    })
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.check(localInstance(), '@xbzbing/dsh-git-panel')).rejects.toThrow(
      /未发布到 npm registry/
    )
  })

  it('不兼容：latest peer 要求高于实例 dsh 版本', async () => {
    const run = stubRun(
      JSON.stringify({
        version: '2.0.0',
        peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' }
      })
    )
    const manager = createPluginManager(baseOptions(run))
    const check = await manager.check(
      localInstance({ dshVersion: '0.1.7-rc.2' }),
      '@xbzbing/dsh-git-panel'
    )
    expect(check.compatible).toBe(false)
    expect(check.dshPeer).toBe('>=0.2.0')
  })

  it('不兼容：主包满足但 dsh 子包锁 ^0.2.0-rc.1（better-sidebar 0.24.1 真实场景）', async () => {
    const run = stubRun(
      JSON.stringify({
        version: '0.24.1',
        peerDependencies: {
          react: '^18.2.0',
          '@deepseek-ai/dsh-llm': '^0.2.0-rc.1',
          '@deepseek-ai/dsh-session': '^0.2.0-rc.1'
        }
      })
    )
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
    const run = stubRun(
      JSON.stringify({
        version: '2.0.0',
        peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' },
        time: { '1.1.0': '2026-09-20T02:30:00.000Z', '2.0.0': '2026-09-28T11:16:59.586Z' }
      })
    )
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
    // 已装 1.1.0，registry latest 1.0.9（更旧）→ 不应报「有更新」。
    const run = stubRun(
      JSON.stringify({
        version: '1.0.9',
        peerDependencies: { '@deepseek-ai/dsh': '>=0.1.7-rc.2' }
      })
    )
    const stateStore = memoryStore()
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    const check = await manager.check(localInstance(), '@xbzbing/dsh-git-panel')
    expect(check.hasUpdate).toBe(false)
    expect((await stateStore.read('inst-1')).updates).toEqual({})
  })

  it('已是最新：清掉可升级标记，但发布时间快照留下（同一版本发布时间恒定）', async () => {
    // 已装 1.1.0，registry latest 也是 1.1.0 → 无更新
    const run = stubRun(
      JSON.stringify({
        version: '1.1.0',
        peerDependencies: {},
        time: { '1.1.0': '2026-09-20T02:30:00.000Z' }
      })
    )
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
    const run = stubRun(LIST_JSON)
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
    const run = stubRun(
      (args) => {
        // add 之后已装版本切到 2.0.0：list 随之反映新版本。
        if (args.includes('add')) {
          upgraded = true
          return okResult()
        }
        // 仅查 time 字段时 dsh 输出裸的「版本 → 发布时刻」映射（不嵌套在 time 键下）。
        return okResult(
          JSON.stringify({
            '1.1.0': '2026-09-20T02:30:00.000Z',
            '2.0.0': '2026-10-05T08:00:00.000Z',
            created: '2026-09-01T00:00:00.000Z'
          })
        )
      },
      () => (upgraded ? listV2 : LIST_JSON)
    )
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
    const run = stubRun(
      (args) => {
        if (args.includes('add')) {
          upgraded = true
          return okResult()
        }
        return okResult(
          JSON.stringify({
            time: { '1.1.0': '2026-09-20T02:30:00.000Z', '2.0.0': '2026-10-05T08:00:00.000Z' }
          })
        )
      },
      () => (upgraded ? listV2 : LIST_JSON)
    )
    const stateStore = memoryStore()
    const manager = createPluginManager({ ...baseOptions(run), stateStore })
    await manager.upgrade(localInstance(), '@xbzbing/dsh-git-panel', '2.0.0')
    expect((await stateStore.read('inst-1')).published).toEqual({
      '@xbzbing/dsh-git-panel': { version: '2.0.0', at: '2026-10-05T08:00:00.000Z' }
    })
  })

  it('升级后取不到新版本发布时间（如离线）：清掉旧版本的陈旧快照', async () => {
    // view 无输出（取不到发布时间）。
    const run = stubRun()
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
    const run = stubRun()
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
    const run = stubRun(async () => {
      await gate
      return okResult(JSON.stringify({ version: '2.0.0', peerDependencies: {} }))
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
    const run = stubRun()
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
    const run = stubRun()
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
    const run = stubRun()
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
    const run = stubRun()
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
    const run = stubRun()
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
    const run = stubRun((args) =>
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
    const run = stubRun()
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
    const run = stubRun()
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
    const run = stubRun()
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
    const run = stubRun(LIST_JSON)
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.check(localInstance(), 'nope')).rejects.toThrow(/未安装/)
  })

  it('兼容判定按实际执行命令的 dsh 版本（注册表固定版本未装、回落到 hub 副本时不再误报兼容）', async () => {
    const run = stubRun(
      JSON.stringify({
        version: '0.24.1',
        peerDependencies: { '@deepseek-ai/dsh-llm': '^0.2.0-rc.1' }
      })
    )
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
    const run = stubRun(
      JSON.stringify({
        version: '0.24.1',
        peerDependencies: { '@deepseek-ai/dsh-llm': '^0.2.0-rc.1' }
      })
    )
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
