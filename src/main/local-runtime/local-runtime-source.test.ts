import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { InstanceStatusEvent } from '@shared/contracts'
import { createLocalRuntime } from './local-runtime'
import type { SpawnInvocation, SpawnedProcess } from '../transport/spawn'
import {
  ISO,
  localInstance,
  storeStub,
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

describe('运行时来源与下载确认', () => {
  function pathChild(): { child: FakeChild; spawnImpl: ReturnType<typeof vi.fn> } {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 888001
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    return { child, spawnImpl }
  }

  const PATH_DSH = { command: '/usr/local/bin/dsh', version: '0.9.9' }

  it('接管外部 dsh 的状态事件不包含访问 URL', async () => {
    const manager = createLocalRuntime({
      store: storeStub,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data'
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))
    await manager.adopt(localInstance(), { pid: 77, port: 3080, patch: null })
    expect(events.at(-1)).toMatchObject({
      status: 'running',
      runtimeSource: 'external',
      port: 3080
    })
    expect(events.at(-1)?.url).toBeUndefined()
  })

  it('未固定实例:PATH 有 dsh → 不安装、直接用本机 dsh 启动,事件带 runtimeSource=path', async () => {
    const { child, spawnImpl } = pathChild()
    const installer = makeFakeInstaller()
    const manager = createLocalRuntime({
      store: storeStub,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      pathProbe: { probe: async () => ({ ...PATH_DSH }) }
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    // 不走安装(未固定 + PATH 优先):ensureInstalled 绝不能被调
    expect(installer.ensureInstalled).not.toHaveBeenCalled()
    // spawn 经 nodeInvocation + PATH 上的 dsh bin(而不是隔离目录入口)
    const invocation = (
      spawnImpl.mock.calls[0] as unknown as [
        { command: string; args: string[]; env: NodeJS.ProcessEnv }
      ]
    )[0]
    expect(invocation.args).toContain(PATH_DSH.command)
    expect(invocation.args.some((arg) => arg.includes('runtimes/dsh-'))).toBe(false)
    // running 事件带版本与来源
    const running = events.find((event) => event.status === 'running')
    expect(running?.version).toBe('0.9.9')
    expect(running?.runtimeSource).toBe('path')
    expect(manager.statusOf(instance.id)?.version).toBe('0.9.9')
  })

  it('固定版本:hub 已装同版本 → 用 hub 入口(runtimeSource=hub),不走确认', async () => {
    const { child, spawnImpl } = pathChild()
    const installer = makeFakeInstaller({
      listInstalled: async () => [
        {
          version: '0.1.4-rc.1',
          dir: '/tmp/runtimes/dsh-0.1.4-rc.1',
          entry: '/tmp/runtimes/dsh-0.1.4-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js',
          installedAt: ISO
        }
      ]
    })
    const confirm = vi.fn(async () => true)
    const manager = createLocalRuntime({
      store: storeStub,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      confirmDownload: confirm,
      pathProbe: { probe: async () => ({ ...PATH_DSH }) } // 版本不匹配,不该被固定版采用
    })
    const instance = localInstance({ dshVersion: '0.1.4-rc.1', id: randomUUID() })
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    expect(confirm).not.toHaveBeenCalled() // hub 命中 → 不需下载 → 不需确认
    const invocation = (
      spawnImpl.mock.calls[0] as unknown as [{ command: string; args: string[] }]
    )[0]
    expect(invocation.args.some((arg) => arg.includes('dsh-0.1.4-rc.1'))).toBe(true)
    expect(manager.statusOf(instance.id)?.runtimeSource).toBe('hub')
  })

  it('下载未确认 → stopped,不 spawn、不安装', async () => {
    const { spawnImpl } = pathChild()
    const installer = makeFakeInstaller()
    const manager = createLocalRuntime({
      store: storeStub,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 2000,
      confirmDownload: async () => false
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))
    const instance = localInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'stopped')

    expect(spawnImpl).not.toHaveBeenCalled()
    expect(installer.ensureInstalled).not.toHaveBeenCalled()
    expect(manager.statusOf(instance.id)?.detail).toContain('未获确认')
  })

  it('未配置确认口(缺省)→ 拒绝下载并 stopped(安全缺省,不静默安装)', async () => {
    const { spawnImpl } = pathChild()
    const installer = makeFakeInstaller()
    const manager = createLocalRuntime({
      store: storeStub,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never
      // 刻意不传 confirmDownload
    })
    const instance = localInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'stopped')
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(installer.ensureInstalled).not.toHaveBeenCalled()
  })

  it('确认后下载并启动(runtimeSource=hub),未固定实例解析 latest 为下载目标', async () => {
    const { child, spawnImpl } = pathChild()
    const installer = makeFakeInstaller()
    const confirm = vi.fn(async () => true)
    const manager = createLocalRuntime({
      store: storeStub,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      confirmDownload: confirm
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    expect(confirm).toHaveBeenCalledWith('0.1.5-rc.1') // resolveDefaultVersion 的返回值
    expect(installer.ensureInstalled).toHaveBeenCalledWith('0.1.5-rc.1', expect.any(Function))
    expect(manager.statusOf(instance.id)?.runtimeSource).toBe('hub')
  })
})

describe('hub 来源启动优先真实 node', () => {
  it('解析到 node 时用 node 执行 hub 安装的运行时（Electron 版本不在 dsh 白名单时启动即败）', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999987
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    let spawned: SpawnInvocation | undefined
    const spawnImpl = vi.fn((invocation: SpawnInvocation) => {
      spawned = invocation
      return child as unknown as SpawnedProcess
    })
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      resolveNode: () => '/fake/bin/node',
      readyTimeoutMs: 2000
    })

    const instance = localInstance({ dshVersion: '0.1.5-rc.1' })
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(spawned).toMatchObject({
      command: '/fake/bin/node',
      args: expect.arrayContaining([
        '--expose-internals',
        '/tmp/runtimes/dsh-0.1.5-rc.1/lib/bin.js'
      ])
    })
    expect(spawned?.env['DSH_HOME']).toContain('homes')
    expect(spawned?.env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
  })
})
