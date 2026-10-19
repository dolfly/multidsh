import { describe, expect, it, vi } from 'vitest'
import { createPluginManager } from './plugin-manager'
import type { CommandResult } from './exec-file'
import { LIST_JSON, baseOptions, localInstance, fakeBundles } from './plugin-manager.testkit'

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
