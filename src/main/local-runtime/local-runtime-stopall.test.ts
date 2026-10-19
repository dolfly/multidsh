import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createLocalRuntime } from './local-runtime'
import type { SpawnedProcess } from '../transport/spawn'
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

describe('stopAll 与排队中启动的取消', () => {
  it('stopAll 会取消全局队列中尚未建立 entry 的启动任务', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999300 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        setImmediate(() => child.emit('exit', 0, signal ?? 'SIGTERM'))
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2_000,
      stopGraceMs: 20
    })
    const first = localInstance()
    const second = localInstance({ id: randomUUID() })
    const startFirst = manager.start(first)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    const startSecond = manager.start(second)

    await manager.stopAll()
    await Promise.all([startFirst, startSecond])

    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(manager.runningIds()).toEqual([])
    expect(manager.statusOf(second.id)?.status).toBe('stopped')
  })

  it('stopAll 对卡住的启动队列有界等待，不阻断退出', async () => {
    let releaseInstall!: () => void
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const installer = makeFakeInstaller({
      ensureInstalled: vi.fn(async () => {
        await installGate
        return {
          version: '0.1.5-rc.1',
          dir: '/tmp/runtimes/dsh-0.1.5-rc.1',
          entry: '/tmp/runtimes/dsh-0.1.5-rc.1/lib/bin.js',
          installedAt: ISO
        }
      })
    })
    const spawnImpl = vi.fn()
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 2_000,
      stopGraceMs: 20,
      stopAllDrainMs: 50
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    await vi.waitFor(() => expect(installer.ensureInstalled).toHaveBeenCalledTimes(1))

    // 安装卡住时 stopAll 必须在上限内返回，否则应用退出被无限拖住。
    await manager.stopAll()

    releaseInstall()
    await starting
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
  })

  it('实例正在停止时收到新 start → 新启动排队执行（不被忽略）', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999500 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        if (signal === 'SIGKILL') setImmediate(() => child.emit('exit', 0, 'SIGKILL'))
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      stopGraceMs: 30
    })
    const instance = localInstance()
    const first = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    children[0]?.stdout.write(readyLine())
    await first
    await waitForStatus(manager, instance.id, 'running')

    // 开始停止：entry.stopping = true 但还没删除
    const stopping = manager.stop(instance.id)
    // 在停止过程中立即 start
    const second = manager.start(instance)

    // 等第二个 spawn 发生
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2))
    // 给第二个子进程就绪行
    children[1]?.stdout.write(readyLine())

    // 两者都应正常完成
    await stopping
    await second
    await waitForStatus(manager, instance.id, 'running')

    // 第二代进程被拉起
    expect(manager.runningIds()).toEqual([instance.id])
  })
})
