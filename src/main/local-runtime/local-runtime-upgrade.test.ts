import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { DshVersionProgressEvent } from '@shared/contracts'
import type { InstallProgress, InstalledRuntime } from './runtime-installer'
import { createLocalRuntime } from './local-runtime'
import type { SpawnedProcess } from '../transport/spawn'
import {
  ISO,
  localInstance,
  makeFakeInstaller,
  waitForStatus,
  readyLine
} from './local-runtime.testkit'
import type { FakeChild } from './local-runtime.testkit'

// 进程组回收的平台机制（POSIX 负 pid / Windows taskkill）在 transport/spawn.test.ts 单测；
// 这里只关心管理器「何时、以何信号回收」，故把 killProcessGroup 固定为直接 kill 子进程，
// 让断言在任意宿主平台（含 Windows CI）稳定，不受真实 taskkill spawn 影响。
vi.mock('../transport/spawn', async (importActual) => ({
  ...(await importActual<typeof import('../transport/spawn')>()),
  killProcessGroup: (child: { kill(signal?: NodeJS.Signals): boolean }, signal: NodeJS.Signals) => {
    child.kill(signal)
  }
}))

// 默认让登录 shell 环境解析返回 null：单测不真的起 `zsh -l -i -c 'env -0'`，
// 保持 hermetic（不读跑测机器的 .zshrc、无交互 shell 卡死风险）。验证该特性的用例
// 通过 shellEnv 选项注入固定 Map。mergeShellEnv 保留真实实现。
vi.mock('./shell-env', async (importActual) => ({
  ...(await importActual<typeof import('./shell-env')>()),
  resolveShellEnvOnce: async () => null
}))

// 同理 mock 登录 PATH 解析：默认实现会真起登录 shell（mac/Linux）或读注册表（Windows），
// 未注入 loginPath 的用例会命中它，非 hermetic 且子进程启动开销可能吃满测试超时预算。
// 保留 mergeLoginPath 真实实现；注入 loginPath 的用例覆盖此默认，不受影响。
vi.mock('./login-path', async (importActual) => ({
  ...(await importActual<typeof import('./login-path')>()),
  resolveLoginPathOnce: async () => null
}))

describe('upgradeInstance 升级编排', () => {
  const installedRuntime = (version: string): InstalledRuntime => ({
    version,
    dir: `/tmp/runtimes/dsh-${version}`,
    entry: `/tmp/runtimes/dsh-${version}/node_modules/@deepseek-ai/dsh/lib/bin.js`,
    installedAt: ISO
  })

  it('停止态升级：只安装并回写版本，不触发 stop/start，末尾 done', async () => {
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({
      resolveLatestVersion: async () => '0.1.6',
      ensureInstalled: vi.fn(
        async (version: string, onProgress?: (progress: InstallProgress) => void) => {
          onProgress?.({ phase: 'installing', version, detail: '下载依赖 (10)：pkg' })
          return installedRuntime(version)
        }
      )
    })
    const spawnImpl = vi.fn(() => {
      throw new Error('停止态升级不应拉起进程')
    })
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      confirmDownload: async () => true,
      readyTimeoutMs: 2000
    })
    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))

    const instance = localInstance({ dshVersion: '0.1.4' })
    await manager.upgradeInstance(instance)

    expect(events.map((event) => event.phase)).toEqual([
      'checking',
      'downloading',
      'installing',
      'done'
    ])
    expect(events.at(-1)).toMatchObject({
      instanceId: instance.id,
      phase: 'done',
      version: '0.1.6'
    })
    // 每个事件都必须带可解析的 ISO 时间戳（弱断言「至少一个合法」曾让坏 at 溜过）。
    expect(events.every((event) => !Number.isNaN(Date.parse(event.at)))).toBe(true)
    // checking 只表示「正在检查」，不携带下载详情。
    expect(events.find((event) => event.phase === 'checking')?.detail).toBeUndefined()
    expect(installer.ensureInstalled).toHaveBeenCalledWith('0.1.6', expect.any(Function))
    expect(store.update).toHaveBeenCalledWith(instance.id, { dshVersion: '0.1.6' })
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('运行中升级：先 stop，装最新版，回写版本，再 start，末尾 done', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999988
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({
      resolveLatestVersion: async () => '0.1.6',
      ensureInstalled: vi.fn(
        async (version: string, onProgress?: (progress: InstallProgress) => void) => {
          onProgress?.({ phase: 'installing', version, detail: '下载依赖 (30)：pkg' })
          return installedRuntime(version)
        }
      )
    })
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      confirmDownload: async () => true,
      readyTimeoutMs: 2000
    })

    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    // 升级内的 stop/start 用间谍截断：只验证编排顺序，不再真的杀进程或重新 spawn。
    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue(undefined)
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue(undefined)
    installer.ensureInstalled.mockClear()

    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))
    await manager.upgradeInstance(instance)

    expect(events.map((event) => event.phase)).toEqual([
      'checking',
      'downloading',
      'installing',
      'done'
    ])
    expect(events.at(-1)).toMatchObject({ phase: 'done', version: '0.1.6' })
    expect(stopSpy).toHaveBeenCalledWith(instance.id)
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: instance.id, dshVersion: '0.1.6' })
    )
    expect(store.update).toHaveBeenCalledWith(instance.id, { dshVersion: '0.1.6' })
    const stopOrder = stopSpy.mock.invocationCallOrder[0] as number
    const installOrder = installer.ensureInstalled.mock.invocationCallOrder.at(-1) as number
    const startOrder = startSpy.mock.invocationCallOrder[0] as number
    expect(stopOrder).toBeLessThan(installOrder)
    expect(installOrder).toBeLessThan(startOrder)
  })

  it('安装失败：emit phase=error 且不回写版本、不重启', async () => {
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({
      resolveLatestVersion: async () => '0.1.6',
      ensureInstalled: vi.fn(async () => {
        throw new Error('registry 不可达')
      })
    })
    const spawnImpl = vi.fn(() => {
      throw new Error('安装失败后不应启动进程')
    })
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      confirmDownload: async () => true,
      readyTimeoutMs: 2000
    })
    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))

    await manager.upgradeInstance(localInstance({ dshVersion: '0.1.4' }))

    expect(events.at(-1)).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('registry 不可达')
    })
    expect(store.update).not.toHaveBeenCalled()
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('未启动的公共空间默认启动器实例：按启动计划升级 hub 运行时，不误报系统 dsh 缺失', async () => {
    const store = { update: vi.fn(async () => localInstance()) }
    const listInstalled = vi.fn(async () => [])
    const installer = makeFakeInstaller({
      listInstalled,
      resolveLatestVersion: async () => '0.1.6',
      ensureInstalled: vi.fn(
        async (version: string, onProgress?: (progress: InstallProgress) => void) => {
          onProgress?.({ phase: 'installing', version, detail: '下载依赖 (10)：pkg' })
          return installedRuntime(version)
        }
      ),
      installGlobal: vi.fn(async () => {
        throw new Error('计划为 hub 运行时，不应触发全局升级')
      })
    })
    const confirmSystemUpgrade = vi.fn(async () => true)
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: vi.fn(() => {
        throw new Error('停止态升级不应拉起进程')
      }) as never,
      probe: async () => true,
      confirmDownload: async () => true,
      confirmSystemUpgrade,
      readyTimeoutMs: 2000
    })
    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))
    // 默认启动器 + 公共空间 + 未启动：启动计划是 pinned-missing → hub 副本，
    // 旧判据把「未启动」当系统 dsh，PATH 探不到时会误报「未找到系统默认 dsh」。
    const instance = localInstance({ useDefaultSpace: true, dshVersion: '0.1.5-rc.1' })

    await manager.upgradeInstance(instance)

    expect(confirmSystemUpgrade).not.toHaveBeenCalled()
    expect(installer.installGlobal).not.toHaveBeenCalled()
    expect(listInstalled).toHaveBeenCalled()
    expect(events.map((event) => event.phase)).toEqual([
      'checking',
      'downloading',
      'installing',
      'done'
    ])
    expect(installer.ensureInstalled).toHaveBeenCalledWith('0.1.6', expect.any(Function))
    expect(store.update).toHaveBeenCalledWith(instance.id, { dshVersion: '0.1.6' })
  })

  it('外部接管的实例拒绝代管升级：error 相位且不产生任何安装动作', async () => {
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({
      installGlobal: vi.fn(async () => {
        throw new Error('外部接管实例不应触发全局升级')
      }),
      ensureInstalled: vi.fn(async () => {
        throw new Error('外部接管实例不应安装 hub 运行时')
      })
    })
    const confirmSystemUpgrade = vi.fn(async () => true)
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: vi.fn(() => {
        throw new Error('不应拉起进程')
      }) as never,
      probe: async () => true,
      confirmDownload: async () => true,
      confirmSystemUpgrade,
      readyTimeoutMs: 2000
    })
    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))
    const instance = localInstance({ useDefaultSpace: true })
    await manager.adopt(instance, { pid: 77, port: 3080, patch: null })

    await manager.upgradeInstance(instance)

    expect(events.at(-1)).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('外部接管的 dsh 进程归用户所有')
    })
    expect(confirmSystemUpgrade).not.toHaveBeenCalled()
    expect(installer.installGlobal).not.toHaveBeenCalled()
    expect(installer.ensureInstalled).not.toHaveBeenCalled()
    expect(store.update).not.toHaveBeenCalled()
  })

  it('公共空间 dsh/duush：二次确认通过后原位升级系统默认 dsh（npm 全局安装 + 回写）', async () => {
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({
      resolveLatestVersion: async () => '0.1.6',
      resolveGlobalPrefix: async (command) => (command === '/tmp/system/dsh' ? '/usr/local' : null),
      installGlobal: vi.fn(
        async (
          _prefix: string,
          version: string,
          onProgress?: (progress: InstallProgress) => void
        ) => {
          onProgress?.({ phase: 'installing', version, detail: '下载依赖 (10)：pkg' })
        }
      )
    })
    const confirmSystemUpgrade = vi.fn(async () => true)
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: vi.fn(() => {
        throw new Error('停止态升级不应拉起进程')
      }) as never,
      confirmDownload: async () => true,
      confirmSystemUpgrade,
      pathProbe: {
        probe: async () => ({ command: '/tmp/system/dsh', version: '0.1.5' }),
        probeLauncher: async () => null
      },
      readyTimeoutMs: 2000
    })
    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))

    const instance = localInstance({ launcher: 'dush', useDefaultSpace: true, dshVersion: '0.1.4' })
    await manager.upgradeInstance(instance)

    // 二次确认带上目标版本与当前系统版本；确认后才出现进度事件。
    expect(confirmSystemUpgrade).toHaveBeenCalledWith('0.1.6', '0.1.5')
    expect(installer.installGlobal).toHaveBeenCalledWith(
      '/usr/local',
      '0.1.6',
      expect.any(Function)
    )
    expect(installer.ensureInstalled).not.toHaveBeenCalled()
    expect(store.update).toHaveBeenCalledWith(instance.id, { dshVersion: '0.1.6' })
    expect(events.map((event) => event.phase)).toEqual([
      'checking',
      'downloading',
      'installing',
      'done'
    ])
    expect(events.at(-1)).toMatchObject({ phase: 'done', version: '0.1.6' })
  })

  it('公共空间 dsh/duush：升级前在运行则停 → 全局升级 → 重启', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999987
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({
      resolveLatestVersion: async () => '0.1.6',
      resolveGlobalPrefix: async () => '/usr/local',
      installGlobal: vi.fn(async () => undefined)
    })
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      confirmDownload: async () => true,
      confirmSystemUpgrade: async () => true,
      pathProbe: {
        probe: async () => ({ command: '/tmp/system/dsh', version: '0.1.5' }),
        probeLauncher: async () => ({ command: '/tmp/dush', version: '0.1.1-rc.3' })
      },
      resolveNode: () => null,
      readyTimeoutMs: 2000
    })

    const instance = localInstance({ launcher: 'dush', useDefaultSpace: true })
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue(undefined)
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue(undefined)
    installer.installGlobal.mockClear()

    await manager.upgradeInstance(instance)

    expect(stopSpy).toHaveBeenCalledWith(instance.id)
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: instance.id, dshVersion: '0.1.6' })
    )
    const stopOrder = stopSpy.mock.invocationCallOrder[0] as number
    const installOrder = installer.installGlobal.mock.invocationCallOrder[0] as number
    const startOrder = startSpy.mock.invocationCallOrder[0] as number
    expect(stopOrder).toBeLessThan(installOrder)
    expect(installOrder).toBeLessThan(startOrder)
  })

  it('公共空间 dsh/duush：拒绝二次确认 → 不产生进度、不安装、不回写', async () => {
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({
      resolveLatestVersion: async () => '0.1.6',
      resolveGlobalPrefix: async () => '/usr/local',
      installGlobal: vi.fn(async () => undefined)
    })
    const confirmSystemUpgrade = vi.fn(async () => false)
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: vi.fn(() => {
        throw new Error('拒绝确认后不应拉起进程')
      }) as never,
      confirmDownload: async () => true,
      confirmSystemUpgrade,
      pathProbe: {
        probe: async () => ({ command: '/tmp/system/dsh', version: '0.1.5' }),
        probeLauncher: async () => null
      },
      readyTimeoutMs: 2000
    })
    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))

    await manager.upgradeInstance(localInstance({ launcher: 'duush', useDefaultSpace: true }))

    expect(confirmSystemUpgrade).toHaveBeenCalledWith('0.1.6', '0.1.5')
    expect(events).toEqual([])
    expect(installer.installGlobal).not.toHaveBeenCalled()
    expect(store.update).not.toHaveBeenCalled()
  })

  it('公共空间 dsh/duush：探不到系统默认 dsh → error 相位且不弹二次确认', async () => {
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({ resolveLatestVersion: async () => '0.1.6' })
    const confirmSystemUpgrade = vi.fn(async () => true)
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: vi.fn(() => {
        throw new Error('不应拉起进程')
      }) as never,
      confirmDownload: async () => true,
      confirmSystemUpgrade,
      pathProbe: {
        probe: async () => null,
        probeLauncher: async () => null
      },
      readyTimeoutMs: 2000
    })
    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))

    await manager.upgradeInstance(localInstance({ launcher: 'dush', useDefaultSpace: true }))

    expect(events.at(-1)).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('未找到系统默认 dsh')
    })
    expect(confirmSystemUpgrade).not.toHaveBeenCalled()
    expect(installer.installGlobal).not.toHaveBeenCalled()
  })

  it('公共空间 dsh/duush：系统 dsh 非 npm 全局安装 → error 相位说明无法代管升级', async () => {
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({
      resolveLatestVersion: async () => '0.1.6',
      resolveGlobalPrefix: async () => null
    })
    const confirmSystemUpgrade = vi.fn(async () => true)
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: vi.fn(() => {
        throw new Error('不应拉起进程')
      }) as never,
      confirmDownload: async () => true,
      confirmSystemUpgrade,
      pathProbe: {
        probe: async () => ({ command: '/opt/homebrew/bin/dsh', version: '0.1.5' }),
        probeLauncher: async () => null
      },
      readyTimeoutMs: 2000
    })
    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))

    await manager.upgradeInstance(localInstance({ launcher: 'dush', useDefaultSpace: true }))

    expect(events.at(-1)).toMatchObject({
      phase: 'error',
      error: expect.stringContaining('不是 npm 全局安装')
    })
    expect(confirmSystemUpgrade).not.toHaveBeenCalled()
    expect(installer.installGlobal).not.toHaveBeenCalled()
  })

  it('公共空间实例当前跑 hub 副本时，升级的是 hub 运行时而非系统默认 dsh', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999983
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({
      resolveLatestVersion: async () => '0.1.6',
      ensureInstalled: vi.fn(
        async (
          version: string,
          onProgress?: (progress: InstallProgress) => void
        ): Promise<InstalledRuntime> => {
          onProgress?.({ phase: 'installing', version, detail: '下载依赖 (10)：pkg' })
          return {
            version,
            dir: `/tmp/runtimes/dsh-${version}`,
            entry: `/tmp/runtimes/dsh-${version}/node_modules/@deepseek-ai/dsh/lib/bin.js`,
            installedAt: ISO
          }
        }
      ),
      installGlobal: vi.fn(async () => {
        throw new Error('公共空间跑 hub 副本时不应触发全局升级')
      })
    })
    const confirmSystemUpgrade = vi.fn(async () => true)
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      confirmDownload: async () => true,
      confirmSystemUpgrade,
      resolveNode: () => null,
      readyTimeoutMs: 2000
    })
    // 未装配 pathProbe → 计划落到「需下载」，确认后实例在公共空间里跑的是 hub 副本。
    const instance = localInstance({ useDefaultSpace: true, dshVersion: '0.1.5-rc.1' })
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')
    expect(manager.statusOf(instance.id)?.runtimeSource).toBe('hub')

    const stopSpy = vi.spyOn(manager, 'stop').mockResolvedValue(undefined)
    const startSpy = vi.spyOn(manager, 'start').mockResolvedValue(undefined)
    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))
    await manager.upgradeInstance(instance)

    // 升级对象是实例实际在用的 hub 副本：不弹全局升级确认，也不碰系统 dsh。
    expect(confirmSystemUpgrade).not.toHaveBeenCalled()
    expect(installer.installGlobal).not.toHaveBeenCalled()
    expect(installer.ensureInstalled).toHaveBeenCalledWith('0.1.6', expect.any(Function))
    expect(store.update).toHaveBeenCalledWith(instance.id, { dshVersion: '0.1.6' })
    expect(stopSpy).toHaveBeenCalledWith(instance.id)
    expect(startSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: instance.id, dshVersion: '0.1.6' })
    )
    expect(events.map((event) => event.phase)).toEqual([
      'checking',
      'downloading',
      'installing',
      'done'
    ])
  })
})

describe('upgradeInstance 单飞守卫', () => {
  it('同一实例升级进行中重复触发被忽略，只安装一次', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const store = { update: vi.fn(async () => localInstance()) }
    const installer = makeFakeInstaller({
      resolveLatestVersion: async () => '0.1.6',
      ensureInstalled: vi.fn(async (version: string) => {
        await gate
        return {
          version,
          dir: `/tmp/runtimes/dsh-${version}`,
          entry: `/tmp/runtimes/dsh-${version}/node_modules/@deepseek-ai/dsh/lib/bin.js`,
          installedAt: ISO
        }
      })
    })
    const manager = createLocalRuntime({
      store,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: vi.fn(() => {
        throw new Error('停止态升级不应拉起进程')
      }) as never,
      confirmDownload: async () => true,
      readyTimeoutMs: 2000
    })
    const events: DshVersionProgressEvent[] = []
    manager.onUpgradeProgress((event) => events.push(event))

    const instance = localInstance({ dshVersion: '0.1.4' })
    const first = manager.upgradeInstance(instance)
    const second = manager.upgradeInstance(instance)
    await second
    release()
    await first

    expect(installer.ensureInstalled).toHaveBeenCalledTimes(1)
    expect(events.filter((event) => event.phase === 'checking')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ phase: 'done', version: '0.1.6' })
  })
})
