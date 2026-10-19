import { describe, expect, it } from 'vitest'
import { createPluginManager } from './plugin-manager'
import {
  LIST_JSON,
  baseOptions,
  localInstance,
  memoryStore,
  okResult,
  stateWith,
  fakeRun
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
    const run = fakeRun(VIEW_JSON)
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
    const run = fakeRun(VIEW_JSON)
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
    const run = fakeRun(JSON.stringify({ version: '1.2.0', time: { '1.2.0': 'x' } }))
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
    const run = fakeRun({
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
    const run = fakeRun(
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
    const run = fakeRun(
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
    const run = fakeRun(
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
    const run = fakeRun(
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
    const run = fakeRun(
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
    const run = fakeRun(LIST_JSON)
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
    const run = fakeRun(
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
    const run = fakeRun(
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
    const run = fakeRun()
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
    const run = fakeRun()
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
    const run = fakeRun(async () => {
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

  it('未安装的插件 → 抛错', async () => {
    const run = fakeRun(LIST_JSON)
    const manager = createPluginManager(baseOptions(run))
    await expect(manager.check(localInstance(), 'nope')).rejects.toThrow(/未安装/)
  })

  it('兼容判定按实际执行命令的 dsh 版本（注册表固定版本未装、回落到 hub 副本时不再误报兼容）', async () => {
    const run = fakeRun(
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
    const run = fakeRun(
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
