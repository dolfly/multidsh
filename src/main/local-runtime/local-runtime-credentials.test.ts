import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { delimiter } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { InstanceStatusEvent } from '@shared/contracts'
import { createLocalRuntime } from './local-runtime'
import type { SpawnedProcess } from '../transport/spawn'
import {
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

describe('凭据脱敏', () => {
  it('就绪 URL 中的 token 不出现在 error detail 中（健康探测失败）', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999600
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never

    // 恒失败探测:触发 detail 中包含就绪 URL 的 error 事件
    const probe = vi.fn(async () => false)
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe,
      readyTimeoutMs: 2000,
      healthProbeRetries: 2,
      healthProbeRetryMs: 10
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))

    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write('dsh web: http://127.0.0.1:31234/?token=SECRET_TOKEN_VALUE\n')
    await starting
    await waitForStatus(manager, instance.id, 'error')

    const errorEvent = events.find((e) => e.status === 'error')
    expect(errorEvent).toBeDefined()
    // detail 中的 URL 必须脱敏:查询串(含 token)被剥离
    expect(errorEvent!.detail).not.toContain('SECRET_TOKEN_VALUE')
    expect(errorEvent!.detail).toContain('http://127.0.0.1:31234')
    // 状态事件绝不携带 bearer token；完整 URL 仅保存在主进程 entry，供 openView 使用。
    expect(errorEvent!.url).toBeUndefined()
  })

  it('pushLog 不脱敏:就绪行匹配不受影响（READY_PATTERN 守卫）', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999601
    child.kill = vi.fn(() => true) as never

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    // 就绪行含完整 token:pushLog 不脱敏才能匹配 READY_PATTERN
    child.stdout.write('dsh web: http://127.0.0.1:31234/?token=my-secret-token\n')
    await starting
    await waitForStatus(manager, instance.id, 'running')

    // 状态事件不暴露 token；运行时内部仍持有完整 URL，供主进程打开工作区。
    expect(manager.statusOf(instance.id)?.url).toBeUndefined()
  })

  it('进程意外退出的详情带子进程日志,但就绪 URL 的 token 必须被脱敏', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999602
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      readyTimeoutMs: 5000
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))

    const instance = localInstance()
    const starting = manager.start(instance)
    await vi.waitFor(() => expect(manager.runningIds()).toContain(instance.id))
    // 子进程先输出诊断行，再输出一行**带 token 的就绪 URL**（后者是凭据，绝不能进详情）。
    child.stderr.write('Error: unsupported Electron runtime fingerprint\n')
    child.stdout.write('dsh web: http://127.0.0.1:52300/?token=super-secret-token\n')
    child.emit('exit', 1, null)
    await starting
    await waitForStatus(manager, instance.id, 'error')

    const errorEvent = events.findLast((event) => event.status === 'error')
    expect(errorEvent).toBeDefined()
    // 失败原因可见（这是启动失败时唯一的诊断来源）。
    expect(errorEvent!.detail).toContain('unsupported Electron runtime fingerprint')
    // 但凭据必须已被 redactLine 脱敏。
    expect(errorEvent!.detail).not.toContain('super-secret-token')
    expect(errorEvent!.detail).not.toContain('token=')
  })

  it('path 来源用真实 node 执行本机启器,不用 Electron 充当 Node', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999701
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      pathProbe: {
        probe: async () => ({ command: '/Users/example/.local/bin/dsh', version: '0.1.6-alpha.2' })
      },
      // 本机启动器是 #!/usr/bin/env node 脚本:必须交给真实 node,
      // 用 Electron(ELECTRON_RUN_AS_NODE)会被 dsh 原生插件的运行时指纹拒绝而 code=1。
      resolveNode: (scriptPath) =>
        scriptPath.endsWith('/dsh') ? '/Users/example/.local/bin/node' : null,
      readyTimeoutMs: 2_000
    })

    const starting = manager.start(localInstance())
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stdout.write(readyLine())
    await starting

    const invocation = (
      spawnImpl.mock.calls[0] as unknown as [
        { command: string; args: string[]; env: NodeJS.ProcessEnv }
      ]
    )[0]
    expect(invocation.command).toBe('/Users/example/.local/bin/node')
    expect(invocation.args.slice(0, 2)).toEqual([
      '--expose-internals',
      '/Users/example/.local/bin/dsh'
    ])
    // 绝不能给真实 node 带上 Electron 的降级开关。
    expect(invocation.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    // 让 dsh spawn 的子进程也能找到同一个 node。
    expect(invocation.env.PATH?.startsWith('/Users/example/.local/bin')).toBe(true)
  })

  it('启动 env 合并登录 PATH:node 目录 → 登录 PATH → 继承 PATH', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999703
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      pathProbe: {
        probe: async () => ({ command: '/Users/example/.local/bin/dsh', version: '0.1.6-alpha.2' })
      },
      resolveNode: () => '/Users/example/.local/bin/node',
      loginPath: async () => '/login/bin',
      inheritShellEnv: () => false,
      readyTimeoutMs: 2_000
    })

    const starting = manager.start(localInstance())
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stdout.write(readyLine())
    await starting

    const invocation = (spawnImpl.mock.calls[0] as unknown as [{ env: NodeJS.ProcessEnv }])[0]
    const segments = (invocation.env.PATH ?? '').split(delimiter)
    expect(segments[0]).toBe('/Users/example/.local/bin')
    expect(segments[1]).toBe('/login/bin')
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter((d) => d !== '')) {
      expect(segments).toContain(dir)
    }
  })

  it('登录 PATH 不可用时回退继承 PATH,node 目录仍前置', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999704
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      pathProbe: {
        probe: async () => ({ command: '/Users/example/.local/bin/dsh', version: '0.1.6-alpha.2' })
      },
      resolveNode: () => '/Users/example/.local/bin/node',
      loginPath: async () => null,
      inheritShellEnv: () => false,
      readyTimeoutMs: 2_000
    })

    const starting = manager.start(localInstance())
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stdout.write(readyLine())
    await starting

    const invocation = (spawnImpl.mock.calls[0] as unknown as [{ env: NodeJS.ProcessEnv }])[0]
    expect(invocation.env.PATH).toBe(
      `/Users/example/.local/bin${delimiter}${process.env.PATH ?? ''}`
    )
  })

  it('开启 inheritShellEnv:合并登录 shell 环境变量,node 目录前置、受保护键不被覆盖', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999705
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      pathProbe: {
        probe: async () => ({ command: '/Users/example/.local/bin/dsh', version: '0.1.6-alpha.2' })
      },
      resolveNode: () => '/Users/example/.local/bin/node',
      inheritShellEnv: () => true,
      shellEnv: async () =>
        new Map<string, string>([
          ['PATH', '/shell/bin'],
          ['HTTP_PROXY', 'http://127.0.0.1:7890'],
          // 受保护键：即便 shell 里有，也不得覆盖 hub 注入的 DSH_HOME
          ['DSH_HOME', '/evil/home']
        ]),
      readyTimeoutMs: 2_000
    })

    const starting = manager.start(localInstance())
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stdout.write(readyLine())
    await starting

    const invocation = (spawnImpl.mock.calls[0] as unknown as [{ env: NodeJS.ProcessEnv }])[0]
    // shell 环境变量被注入
    expect(invocation.env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    // node 目录前置、shell PATH 随后
    const segments = (invocation.env.PATH ?? '').split(delimiter)
    expect(segments[0]).toBe('/Users/example/.local/bin')
    expect(segments[1]).toBe('/shell/bin')
    // 受保护键：DSH_HOME 仍是 hub 决定的隔离目录，不是 shell 里的伪造值
    expect(invocation.env.DSH_HOME).not.toBe('/evil/home')
    expect(invocation.env.DSH_HOME).toContain('homes')
  })

  it('找不到 node 时按脚本 shebang 直接执行,不悄悄回退到 Electron', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999702
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      pathProbe: {
        probe: async () => ({ command: '/Users/example/.local/bin/dsh', version: '0.1.6-alpha.2' })
      },
      resolveNode: () => null,
      readyTimeoutMs: 2_000
    })

    const starting = manager.start(localInstance())
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stdout.write(readyLine())
    await starting

    const invocation = (
      spawnImpl.mock.calls[0] as unknown as [{ command: string; args: string[] }]
    )[0]
    expect(invocation.command).toBe('/Users/example/.local/bin/dsh')
    expect(invocation.args).not.toContain('--expose-internals')
  })
})
