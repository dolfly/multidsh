import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe('createLocalRuntime', () => {
  it('refreshEnv 失效并重解析登录环境缓存，缓存有基线时只重解析一次并返回差异', async () => {
    const loginInvalidate = vi.fn()
    const shellInvalidate = vi.fn()
    // PATH 夹具必须和 refreshEnv 内部 diffEnvironment 用同一套分隔符（按 process.platform
    // 选，Windows 上是 ;）；用 node:path 的 delimiter 在「模拟平台」场景下会对不齐，
    // 硬编码 : 更会把整串当一个条目，在 Windows CI 上断言失败。
    const pathSeparator = process.platform === 'win32' ? ';' : ':'
    const loginPath = Object.assign(
      vi.fn(async () => ['/usr/bin', '/opt/homebrew/bin'].join(pathSeparator)),
      {
        invalidate: loginInvalidate,
        // 基线取缓存里上一次的解析结果；peek 不得触发新解析
        peek: vi.fn(async () => '/usr/bin')
      }
    )
    const shellEnv = Object.assign(
      vi.fn(async () => new Map([['HTTP_PROXY', 'http://new']])),
      {
        invalidate: shellInvalidate,
        peek: vi.fn(async () => new Map([['HTTP_PROXY', 'http://old']]))
      }
    )

    const manager = createLocalRuntime({
      store: storeStub,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      loginPath,
      shellEnv
    })

    const diff = await manager.refreshEnv()

    expect(loginInvalidate).toHaveBeenCalledOnce()
    expect(shellInvalidate).toHaveBeenCalledOnce()
    // 预热：失效后立刻重解析一次，使随后的启动不必等待解析；基线来自 peek，不额外解析
    expect(loginPath).toHaveBeenCalledOnce()
    expect(shellEnv).toHaveBeenCalledOnce()
    expect(diff.pathComparable).toBe(true)
    expect(diff.pathAdded).toEqual(['/opt/homebrew/bin'])
    expect(diff.pathRemoved).toEqual([])
    expect(diff.varsChanged).toEqual(['HTTP_PROXY'])
  })

  it('refreshEnv 冷缓存（没有 peek 结果）先解析一次建立基线，再失效重解析', async () => {
    const loginPath = Object.assign(
      vi.fn(async () => '/usr/bin'),
      { invalidate: vi.fn() }
    )
    const shellEnv = Object.assign(
      vi.fn(async () => new Map<string, string>()),
      {
        invalidate: vi.fn()
      }
    )

    const manager = createLocalRuntime({
      store: storeStub,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      loginPath,
      shellEnv
    })

    const diff = await manager.refreshEnv()

    // 基线 + 刷新后的重解析各一次
    expect(loginPath).toHaveBeenCalledTimes(2)
    expect(shellEnv).toHaveBeenCalledTimes(2)
    expect(diff.pathComparable).toBe(true)
    expect(diff.varsComparable).toBe(true)
    // 两次解析结果相同 → 无变化
    expect(diff.pathAdded).toEqual([])
    expect(diff.pathRemoved).toEqual([])
    expect(diff.varsAdded).toEqual([])
    expect(diff.varsRemoved).toEqual([])
    expect(diff.varsChanged).toEqual([])
  })

  it('start → 就绪行 → 健康探测通过 → running(带 url/port/version)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999991
    child.killCall = []
    child.kill = vi.fn((signal) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never

    const spawnImpl = vi.fn((invocation: SpawnInvocation) => {
      expect(invocation.args).toContain('--no-open')
      expect(invocation.args).toContain('--expose-internals')
      expect(invocation.env['DSH_HOME']).toContain('homes')
      expect(invocation.env['PNPM_SHIM_BYPASS']).toBe('1')
      // Windows 非 detached（避免新控制台弹窗）；其余平台 detached 以便进程组回收。
      expect(invocation.detached).toBe(process.platform !== 'win32')
      return child as unknown as SpawnedProcess
    })
    const probe = vi.fn(async () => true)
    const installer = makeFakeInstaller()

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe,
      // 固定为 Electron 回退路径：hub 解析到真实 node 时会改用 node，不随开发机环境漂移。
      resolveNode: () => null,
      readyTimeoutMs: 2000
    })
    const events: InstanceStatusEvent[] = []
    manager.onStatus((event) => events.push(event))

    const instance = localInstance()
    // start() 现在会等到「就绪或退出」才返回(TOCTOU 防线):先注入就绪行再 await
    const starting = manager.start(instance)
    child.stdout.write('dsh web: http://127.0.0.1:31234/?token=abc\n')
    await starting
    await waitForStatus(manager, instance.id, 'running')

    const status = manager.statusOf(instance.id)
    expect(status?.url).toBeUndefined()
    expect(status?.port).toBe(31234)
    expect(status?.version).toBe('0.1.5-rc.1')
    expect(probe).toHaveBeenCalledWith('http://127.0.0.1:31234/?token=abc', expect.any(Number))
    expect(spawnImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        args: expect.arrayContaining(['--profile', 'web', '--no-open'])
      })
    )
    expect(spawnImpl.mock.calls[0]?.[0].args.slice(-5)).toEqual([
      '--profile',
      'web',
      '--port',
      expect.stringMatching(/^\d+$/),
      '--no-open'
    ])
    // 启动进度序列:解析来源 → 需下载待确认 → 准备运行时 → 分配端口 → running
    expect(events.map((event) => event.status)).toEqual([
      'starting',
      'starting',
      'starting',
      'starting',
      'running'
    ])
  })

  it('beforeSpawn：在 spawn 前以解析出的 dsh 版本调用；抛错不阻断启动', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999993
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const seen: string[] = []

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: vi.fn(async () => true),
      resolveNode: () => null,
      readyTimeoutMs: 2000,
      beforeSpawn: async (_instance, version) => {
        seen.push(version)
        throw new Error('核对失败也不该阻断启动')
      }
    })

    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    // 版本来自启动计划（hub 固定版本），且核对失败不影响启动结果
    expect(seen).toEqual(['0.1.5-rc.1'])
    expect(spawnImpl).toHaveBeenCalled()
  })

  it.each(['dush', 'duush'] as const)(
    '选择 %s 启动器时由 Hub 固定 web、回环端口和 --no-open',
    async (launcher) => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999990
      child.killCall = []
      child.kill = vi.fn(() => true) as never
      const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
      const manager = createLocalRuntime({
        store: storeStub,
        confirmDownload: async () => true,
        installer: makeFakeInstaller(),
        dataRoot: '/tmp/hub-data',
        spawnImpl: spawnImpl as never,
        // 固定 node 解析结果,避免测试随开发机是否装有 node 漂移。
        resolveNode: () => null,
        pathProbe: {
          // 隔离实例优先复用 PATH 上的 dsh(path 来源),此时仍直接执行 wrapper 本体。
          probe: async () => ({ command: '/tmp/system/dsh', version: '0.1.5-rc.1' }),
          // 启动器已探到(绝对路径):探测为 null 会快速失败,不再回退注定 ENOENT 的裸命令名。
          probeLauncher: async () => ({ command: `/tmp/bin/${launcher}`, version: '0.1.1-rc.3' })
        },
        readyTimeoutMs: 2_000
      })

      const instance = localInstance({ launcher })
      const starting = manager.start(instance)
      child.stdout.write(readyLine())
      await starting

      expect(spawnImpl).toHaveBeenCalledWith(
        expect.objectContaining({
          command: `/tmp/bin/${launcher}`,
          args: ['--profile', 'web', '--port', expect.stringMatching(/^\d+$/), '--no-open'],
          // wrapper 实际加载哪份 dsh 由 hub 指定:注入 DSH_BIN,而不是放任它回退 PATH。
          env: expect.objectContaining({ DSH_BIN: '/tmp/system/dsh' })
        })
      )
    }
  )

  it.each([
    {
      dshVersion: '0.2.0',
      pathDsh: null,
      expected: '0.2.0',
      source: 'hub',
      dshBin: '/tmp/runtimes/dsh-0.2.0/lib/bin.js'
    },
    {
      dshVersion: null,
      pathDsh: { command: '/tmp/system/dsh', version: '0.1.1-rc.3' },
      expected: '0.1.1-rc.3',
      source: 'path',
      dshBin: '/tmp/system/dsh'
    },
    {
      dshVersion: null,
      pathDsh: null,
      expected: '0.1.5-rc.1',
      source: 'hub',
      dshBin: '/tmp/runtimes/dsh-0.1.5-rc.1/lib/bin.js'
    }
  ])(
    '自定义启动器：dshVersion=$dshVersion 来源=$source 时状态版本显示 $expected，DSH_BIN 指向该来源',
    async ({ dshVersion, pathDsh, expected, source, dshBin }) => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999986
      child.killCall = []
      child.kill = vi.fn(() => true) as never
      const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
      const manager = createLocalRuntime({
        store: storeStub,
        confirmDownload: async () => true,
        installer: makeFakeInstaller(),
        dataRoot: '/tmp/hub-data',
        spawnImpl: spawnImpl as never,
        probe: async () => true,
        resolveNode: () => null,
        pathProbe: {
          probeLauncher: async () => ({ command: '/tmp/dush', version: '0.1.1-rc.3' }),
          probe: async () => pathDsh
        },
        readyTimeoutMs: 2_000
      })

      const instance = localInstance({ launcher: 'dush', dshVersion, profile: 'dev' })
      const starting = manager.start(instance)
      child.stdout.write(readyLine())
      await starting
      await waitForStatus(manager, instance.id, 'running')

      const status = manager.statusOf(instance.id)
      expect(status?.version).toBe(expected)
      expect(status?.runtimeSource).toBe(source)
      // 命令行由 hub 固定的参数拼出,供详情页展示与复制;wrapper 路径始终出现在命令里。
      expect(status?.command).toMatch(/\/tmp\/dush --profile dev --port \d+ --no-open$/)
      const invocation = (spawnImpl.mock.calls[0] as unknown as [SpawnInvocation])[0]
      expect(invocation.env['DSH_BIN']).toBe(dshBin)
    }
  )

  it.each(['dush', 'duush'] as const)(
    '%s 启动不会继承父进程的 DUSH_PATCH_FILE，避免 loader 重复加载',
    async (launcher) => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999988
      child.killCall = []
      child.kill = vi.fn(() => true) as never
      const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
      const previousPatch = process.env.DUSH_PATCH_FILE
      process.env.DUSH_PATCH_FILE = '/tmp/global/cordis.dush.patch.yml'

      try {
        const probeLauncher = vi.fn(async () => ({
          command: `/tmp/${launcher}`,
          version: '0.1.1-rc.3'
        }))
        const manager = createLocalRuntime({
          store: storeStub,
          confirmDownload: async () => true,
          installer: makeFakeInstaller(),
          dataRoot: '/tmp/hub-data',
          spawnImpl: spawnImpl as never,
          resolveNode: () => null,
          pathProbe: {
            probeLauncher,
            probe: async () => ({ command: '/tmp/system/dsh', version: '0.1.5-rc.1' })
          },
          readyTimeoutMs: 2_000
        })
        const starting = manager.start(localInstance({ launcher }))
        await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
        child.stdout.write(readyLine())
        await starting

        // 探测必须按记录的启动器名进行，且优先用探到的绝对路径执行。
        expect(probeLauncher).toHaveBeenCalledWith(launcher)
        const invocation = (
          spawnImpl.mock.calls[0] as unknown as [{ env: NodeJS.ProcessEnv; command: string }]
        )[0]
        expect(invocation.command).toBe(`/tmp/${launcher}`)
        expect(invocation.env.DUSH_PATCH_FILE).toBeUndefined()
        expect(invocation.env.DSH_BIN).toBe('/tmp/system/dsh')
      } finally {
        if (previousPatch === undefined) delete process.env.DUSH_PATCH_FILE
        else process.env.DUSH_PATCH_FILE = previousPatch
      }
    }
  )

  it.each(['dush', 'duush'] as const)(
    '公共空间的 %s 实例固定跟随系统默认 dsh：探测结果注入 DSH_BIN，实例固定版本不生效',
    async (launcher) => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999985
      child.killCall = []
      child.kill = vi.fn(() => true) as never
      const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
      const listInstalled = vi.fn(async () => [])
      const ensureInstalled = vi.fn(async () => {
        throw new Error('公共空间实例不应安装 hub 副本')
      })
      const manager = createLocalRuntime({
        store: storeStub,
        confirmDownload: async () => true,
        installer: makeFakeInstaller({ listInstalled, ensureInstalled }),
        dataRoot: '/tmp/hub-data',
        spawnImpl: spawnImpl as never,
        probe: async () => true,
        resolveNode: () => null,
        pathProbe: {
          probeLauncher: async () => ({ command: `/tmp/${launcher}`, version: '0.1.1-rc.3' }),
          probe: async () => ({ command: '/tmp/system/dsh', version: '0.1.9' })
        },
        readyTimeoutMs: 2_000
      })

      const instance = localInstance({ launcher, useDefaultSpace: true, dshVersion: '0.2.0' })
      const starting = manager.start(instance)
      child.stdout.write(readyLine())
      await starting
      await waitForStatus(manager, instance.id, 'running')

      // 公共空间不装 hub 副本：既不列已装版本，也不做安装准备。
      expect(listInstalled).not.toHaveBeenCalled()
      expect(ensureInstalled).not.toHaveBeenCalled()
      const status = manager.statusOf(instance.id)
      expect(status?.version).toBe('0.1.9')
      expect(status?.runtimeSource).toBe('path')
      const invocation = (spawnImpl.mock.calls[0] as unknown as [SpawnInvocation])[0]
      expect(invocation.env['DSH_BIN']).toBe('/tmp/system/dsh')
    }
  )

  it.each([
    { dshVersion: null, expected: 'custom' },
    { dshVersion: '0.2.0', expected: '0.2.0' }
  ])(
    '公共空间实例未探到系统默认 dsh 时退回占位显示（dshVersion=$dshVersion → $expected）且不注入 DSH_BIN',
    async ({ dshVersion, expected }) => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999984
      child.killCall = []
      child.kill = vi.fn(() => true) as never
      const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
      const manager = createLocalRuntime({
        store: storeStub,
        confirmDownload: async () => true,
        installer: makeFakeInstaller(),
        dataRoot: '/tmp/hub-data',
        spawnImpl: spawnImpl as never,
        probe: async () => true,
        resolveNode: () => null,
        pathProbe: {
          probeLauncher: async () => ({ command: '/tmp/dush', version: '0.1.1-rc.3' }),
          probe: async () => null
        },
        readyTimeoutMs: 2_000
      })

      const instance = localInstance({ launcher: 'dush', useDefaultSpace: true, dshVersion })
      const starting = manager.start(instance)
      child.stdout.write(readyLine())
      await starting
      await waitForStatus(manager, instance.id, 'running')

      expect(manager.statusOf(instance.id)?.version).toBe(expected)
      const invocation = (spawnImpl.mock.calls[0] as unknown as [SpawnInvocation])[0]
      expect(invocation.env['DSH_BIN']).toBeUndefined()
    }
  )

  it('探测能力存在但未探到自定义启动器 → 直接失败，不再构造注定 ENOENT 的调用', async () => {
    const spawnImpl = vi.fn(() => {
      throw new Error('未探到启动器不应走到 spawn')
    })
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      resolveNode: () => null,
      pathProbe: { probe: async () => null, probeLauncher: async () => null },
      readyTimeoutMs: 2000
    })
    const instance = localInstance({ launcher: 'dush' })

    await manager.start(instance)

    expect(spawnImpl).not.toHaveBeenCalled()
    expect(manager.statusOf(instance.id)).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('未找到启动器 dush')
    })
  })

  it('win32 .cmd 启动器：解析出入口脚本交给 node，不再构造注定 EINVAL 的调用', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'dsh-hub-cmdshim-'))
    try {
      const binDir = join(tmpRoot, 'npm')
      await mkdir(join(binDir, 'node_modules', 'dush', 'bin'), { recursive: true })
      const cmdPath = join(binDir, 'dush.cmd')
      const jsPath = join(binDir, 'node_modules', 'dush', 'bin', 'dush.js')
      await writeFile(cmdPath, '@ECHO off\r\n"%dp0%\\node_modules\\dush\\bin\\dush.js" %*\r\n')
      await writeFile(jsPath, '')

      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999981
      child.killCall = []
      child.kill = vi.fn(() => true) as never
      const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
      const manager = createLocalRuntime({
        store: storeStub,
        confirmDownload: async () => true,
        installer: makeFakeInstaller(),
        dataRoot: '/tmp/hub-data',
        spawnImpl: spawnImpl as never,
        probe: async () => true,
        resolveNode: () => '/fake/node.exe',
        pathProbe: {
          probe: async () => ({ command: '/fake/system/dsh', version: '0.1.9' }),
          probeLauncher: async (launcher) =>
            launcher === 'dush' ? { command: cmdPath, version: '0.1.1-rc.3' } : null
        },
        readyTimeoutMs: 2000
      })
      const instance = localInstance({ launcher: 'dush' })
      const starting = manager.start(instance)
      child.stdout.write(readyLine())
      await starting
      await waitForStatus(manager, instance.id, 'running')

      const invocation = (spawnImpl.mock.calls[0] as unknown as [SpawnInvocation])[0]
      expect(invocation.command).toBe('/fake/node.exe')
      expect(invocation.args).toContain(jsPath)
      expect(invocation.args).not.toContain(cmdPath)
    } finally {
      await rm(tmpRoot, { recursive: true, force: true })
    }
  })

  it('公共空间仅使用主进程提供的 ~/.dsh，不接受渲染层路径', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999989
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      homeDir: () => '/tmp/default-space-home',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 2_000
    })

    const instance = localInstance({ useDefaultSpace: true })
    const starting = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledOnce())
    child.stdout.write(readyLine())
    await starting

    // 实现用 path.join 拼 home,期望值也用 join 构造,避免分隔符随平台漂移
    const defaultSpaceHome = join('/tmp/default-space-home', '.dsh')
    expect(spawnImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: defaultSpaceHome,
        env: expect.objectContaining({ DSH_HOME: defaultSpaceHome })
      })
    )
  })

  it('启动超时未出就绪行 → error + 杀进程', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999992
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
      readyTimeoutMs: 80
    })
    const instance = localInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')

    expect(manager.statusOf(instance.id)?.detail).toContain('启动超时')
    expect(child.killCall).toContain('SIGKILL')
    expect(manager.runningIds()).toEqual([])
  })

  it('进程在就绪前意外退出 → error(仅显示退出码)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999993
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 5000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    // 等 spawn 与监听器挂好(同一同步块),再注入退出事件,避免事件丢失
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stderr.write('Error: port already in use\n')
    child.emit('exit', 1, null)
    await starting
    await waitForStatus(manager, instance.id, 'error')

    expect(manager.statusOf(instance.id)?.detail).toContain('code=1')
    // 子进程的 stderr 是启动失败唯一的诊断来源,必须带进详情(该字样不含凭据)。
    expect(manager.statusOf(instance.id)?.detail).toContain('port already in use')
  })

  it('就绪行主机非回环 → error + 杀进程（不加载远端 origin）', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999997
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never
    const probe = vi.fn(async () => true)

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    // 被篡改的 stdout 打印远端 origin：主机非回环，必须拒绝、不得健康探测也不得进入 running
    child.stdout.write('dsh web: http://attacker.example/?token=abc\n')
    await starting
    await waitForStatus(manager, instance.id, 'error')

    expect(manager.statusOf(instance.id)?.detail).toContain('非回环')
    expect(probe).not.toHaveBeenCalled()
    expect(child.killCall).toContain('SIGKILL')
    expect(manager.runningIds()).toEqual([])
  })

  it('stop:SIGTERM → 子进程退出 → stopped;未退出 → SIGKILL 兜底', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999994
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      // SIGTERM 后不退出 → 需要 SIGKILL 兜底
      if (signal === 'SIGKILL') setImmediate(() => child.emit('exit', 0, 'SIGKILL'))
      return true
    }) as never

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      stopGraceMs: 60
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    await manager.stop(instance.id)
    expect(child.killCall).toEqual(['SIGTERM', 'SIGKILL'])
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
    expect(manager.statusOf(instance.id)?.detail).toContain('强制停止')
    expect(manager.runningIds()).toEqual([])
  })

  it('stop:未运行的 id → 幂等 stopped', async () => {
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data'
    })
    await manager.stop(randomUUID())
    // 事件里会有一条 stopped,但无需运行实体
    expect(manager.runningIds()).toEqual([])
  })

  it('重复 start 幂等:已在运行则不再 spawn', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999995
    child.kill = vi.fn(() => true) as never

    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const installer = makeFakeInstaller()
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')

    await manager.start(instance)
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(manager.statusOf(instance.id)?.detail).toContain('已在运行')
  })

  it('启动前经 ensureInstalled 准备运行时(指定版本直接用)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999996
    child.kill = vi.fn(() => true) as never

    const installer = makeFakeInstaller()
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer,
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await vi.waitFor(() =>
      expect(installer.ensureInstalled).toHaveBeenCalledWith('0.1.5-rc.1', expect.any(Function))
    )

    // 指定版本的实例:直接把该版本交给 ensureInstalled
    const pinned = makeFakeInstaller()
    const manager2 = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: pinned,
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      readyTimeoutMs: 2000
    })
    const startingPinned = manager2.start(
      localInstance({ dshVersion: '0.1.4-rc.1', id: randomUUID() })
    )
    child.stdout.write(readyLine())
    await startingPinned
    await vi.waitFor(() =>
      expect(pinned.ensureInstalled).toHaveBeenCalledWith('0.1.4-rc.1', expect.any(Function))
    )
  })

  it('并发启动串行化:A 就绪后才拉起 B(TOCTOU 防线)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999997 - children.length
      child.killCall = []
      child.kill = vi.fn(() => true) as never
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
      readyTimeoutMs: 2000
    })
    const a = localInstance({ name: 'A' })
    const b = localInstance({ name: 'B' })
    void manager.start(a)
    void manager.start(b)

    // A 先被拉起;未就绪时 B 不允许 spawn(否则两个实例会抢同一端口)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    children[0]?.stdout.write(readyLine())
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2))
    children[1]?.stdout.write(readyLine())

    await waitForStatus(manager, a.id, 'running')
    await waitForStatus(manager, b.id, 'running')
    expect(manager.runningIds().sort()).toEqual([a.id, b.id].sort())
  })

  it('排队期间 stop:取消启动,不再 spawn', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999998
    child.kill = vi.fn(() => true) as never

    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const blocker = makeFakeInstaller({
      ensureInstalled: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60)) // 占住串行队列
        return {
          version: '0.1.5-rc.1',
          dir: '/tmp/runtimes/dsh-0.1.5-rc.1',
          entry: '/tmp/bin.js',
          installedAt: ISO
        }
      })
    })
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: blocker,
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 2000
    })
    const a = localInstance({ name: 'A' })
    const b = localInstance({ name: 'B' })
    const startA = manager.start(a)
    const startB = manager.start(b)
    await manager.stop(b.id) // b 尚在排队
    await startA
    await startB

    expect(spawnImpl).toHaveBeenCalledTimes(1) // 只有 a 被拉起
    expect(manager.statusOf(b.id)?.status).toBe('stopped')
  })

  it('抛错路径(安装失败) → error 事件而非未处理拒绝', async () => {
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller({
        resolveDefaultVersion: async () => {
          throw new Error('registry 不可达')
        }
      }),
      dataRoot: '/tmp/hub-data'
    })
    const instance = localInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('registry 不可达')
  })

  it('健康探测连续失败 → error + SIGKILL + 条目清除 + 队列立即放行(不等到期定时器)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999750 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const probe = vi.fn(async (url: string) => !url.includes(':31234'))
    // readyTimeoutMs=60s:若失败路径不 settle,队列会被卡到定时器触发,测试会在此超时
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe,
      readyTimeoutMs: 60_000,
      healthProbeRetries: 5,
      healthProbeRetryMs: 10
    })
    const a = localInstance({ name: 'A' })
    const startA = manager.start(a)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    children[0]?.stdout.write(readyLine(31234)) // A:该端口探测恒失败
    await startA
    await waitForStatus(manager, a.id, 'error')
    expect(children[0]?.killCall).toContain('SIGKILL')
    expect(manager.runningIds()).toEqual([])
    expect(probe).toHaveBeenCalledTimes(5) // 连接期 500ms 重试

    // 队列未被卡死:B 在 60s 定时器未触达的情况下也能立即 spawn
    const b = localInstance({ name: 'B' })
    const startB = manager.start(b)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2))
    children[1]?.stdout.write(readyLine(31235)) // B:健康探测通过
    await startB
    await waitForStatus(manager, b.id, 'running')
  })

  it('健康探测先失败后成功(就绪行先于端口绑定)→ running', async () => {
    let calls = 0
    const probe = vi.fn(async () => {
      calls += 1
      return calls >= 2
    })
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999740
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
      probe,
      readyTimeoutMs: 2000,
      healthProbeRetries: 3,
      healthProbeRetryMs: 10
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    child.stdout.write(readyLine())
    await starting
    await waitForStatus(manager, instance.id, 'running')
    expect(probe).toHaveBeenCalledTimes(2)
    expect(child.killCall).toEqual([])
  })

  it('同一 id 并发 start 两次 → 只 spawn 一个进程(队列内二次查重)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999730
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const s1 = manager.start(instance)
    const s2 = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    child.stdout.write(readyLine())
    await Promise.all([s1, s2])
    await waitForStatus(manager, instance.id, 'running')
    expect(spawnImpl).toHaveBeenCalledTimes(1) // 绝不允许双进程共享同一 DSH_HOME
    expect(manager.statusOf(instance.id)?.detail).toContain('已在运行')
  })

  it('stop:先杀运行中的进程,排队中的重复 start 一并取消(不复活)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999720 - children.length
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
      stopGraceMs: 60
    })
    const instance = localInstance()
    const s1 = manager.start(instance)
    const s2 = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    await manager.stop(instance.id)
    await s1
    await s2
    expect(children[0]?.killCall).toContain('SIGKILL')
    expect(spawnImpl).toHaveBeenCalledTimes(1) // 排队中的 s2 不得把实例重新拉起
    expect(manager.runningIds()).toEqual([])
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
  })

  it('stop 落在 spawn 前最后一个 await 窗口(findFreePort)→ 补杀,不留孤儿进程', async () => {
    let releasePort!: () => void
    const portGate = new Promise<boolean>((resolve) => {
      releasePort = () => resolve(true)
    })
    const portProbe = vi.fn(() => portGate) as never

    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999710
    child.killCall = []
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      child.killCall.push(signal ?? 'SIGTERM')
      return true
    }) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)

    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      portProbe,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    // 队列任务正挂在 findFreePort 上(被 gate 卡住):此刻 stop 只登记取消意图
    await vi.waitFor(() => expect(portProbe).toHaveBeenCalled())
    await manager.stop(instance.id)
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
    releasePort()
    await starting

    // 子进程确实被拉起过,但随即被补杀:不留孤儿、不占端口、不误报 running
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(child.killCall).toContain('SIGKILL')
    expect(manager.runningIds()).toEqual([])
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
  })

  it('陈旧条目的迟到 exit 不误删新条目(身份守卫)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999700 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
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
      stopGraceMs: 40
    })
    const instance = localInstance()

    const first = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    children[0]?.stdout.write(readyLine())
    await first
    await waitForStatus(manager, instance.id, 'running')
    // 停止:SIGTERM/SIGKILL 都不生效(模拟 D 态僵尸)→ stop 自行清理条目
    await manager.stop(instance.id)
    expect(manager.runningIds()).toEqual([])
    // 第二代进程:重新启动并就绪
    const second = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2))
    children[1]?.stdout.write(readyLine())
    await second
    await waitForStatus(manager, instance.id, 'running')
    expect(manager.runningIds()).toEqual([instance.id])

    children[0]?.emit('exit', 0, null)
    expect(manager.runningIds()).toEqual([instance.id])
    expect(manager.statusOf(instance.id)?.status).toBe('running')
  })

  it('就绪行跨 chunk 拆分 → 仍能匹配就绪(running)', async () => {
    const child = new EventEmitter() as unknown as FakeChild
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 999690
    child.killCall = []
    child.kill = vi.fn(() => true) as never
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = localInstance()
    const starting = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.stdout.write('dsh web: http://127.0.0.1:31') // 半行(无换行)
    child.stdout.write('234/?token=abc\n') // 另一半 + 换行
    await starting
    await waitForStatus(manager, instance.id, 'running')
    expect(manager.statusOf(instance.id)?.url).toBeUndefined()
  })

  it('实例自定义端口:优先从该端口起分配(空闲直接用,被占则递增)', async () => {
    // 场景一:30123 空闲 → 直接用用户选定端口
    const portProbe = vi.fn(async (port: number) => port === 30123)
    let args1: string[] = []
    const child1 = new EventEmitter() as unknown as FakeChild
    child1.stdout = new PassThrough()
    child1.stderr = new PassThrough()
    child1.pid = 999680
    child1.killCall = []
    child1.kill = vi.fn(() => true) as never
    const spawnImpl1 = vi.fn((invocation: SpawnInvocation) => {
      args1 = invocation.args
      return child1 as unknown as SpawnedProcess
    })
    const manager1 = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl1 as never,
      portProbe: portProbe as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const inst1 = localInstance({ port: 30123 })
    const starting1 = manager1.start(inst1)
    child1.stdout.write(readyLine(30123))
    await starting1
    await waitForStatus(manager1, inst1.id, 'running')
    expect(portProbe).toHaveBeenCalledWith(30123)
    expect(args1).toEqual(expect.arrayContaining(['--port', '30123']))

    // 场景二:30123 被占 → 递增到 30124
    const portProbe2 = vi.fn(async (port: number) => port === 30124)
    let args2: string[] = []
    const child2 = new EventEmitter() as unknown as FakeChild
    child2.stdout = new PassThrough()
    child2.stderr = new PassThrough()
    child2.pid = 999670
    child2.killCall = []
    child2.kill = vi.fn(() => true) as never
    const spawnImpl2 = vi.fn((invocation: SpawnInvocation) => {
      args2 = invocation.args
      return child2 as unknown as SpawnedProcess
    })
    const manager2 = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl2 as never,
      portProbe: portProbe2 as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const inst2 = localInstance({ id: randomUUID(), port: 30123 })
    const starting2 = manager2.start(inst2)
    child2.stdout.write(readyLine(30124))
    await starting2
    await waitForStatus(manager2, inst2.id, 'running')
    expect(portProbe2).toHaveBeenCalledWith(30123)
    expect(portProbe2).toHaveBeenCalledWith(30124)
    expect(args2).toEqual(expect.arrayContaining(['--port', '30124']))

    // 场景三:用户端口超出默认区间(如 dsh 默认 52300)→ 仍先尝试该端口,被占则向 65535 递增
    const portProbe3 = vi.fn(async (port: number) => port >= 52301)
    let args3: string[] = []
    const child3 = new EventEmitter() as unknown as FakeChild
    child3.stdout = new PassThrough()
    child3.stderr = new PassThrough()
    child3.pid = 999660
    child3.killCall = []
    child3.kill = vi.fn(() => true) as never
    const spawnImpl3 = vi.fn((invocation: SpawnInvocation) => {
      args3 = invocation.args
      return child3 as unknown as SpawnedProcess
    })
    const manager3 = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl3 as never,
      portProbe: portProbe3 as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const inst3 = localInstance({ id: randomUUID(), port: 52300 })
    const starting3 = manager3.start(inst3)
    child3.stdout.write(readyLine(52301))
    await starting3
    await waitForStatus(manager3, inst3.id, 'running')
    expect(portProbe3).toHaveBeenCalledWith(52300) // 用户端口本身先被尝试
    expect(portProbe3).toHaveBeenCalledWith(52301) // 被占后递增,而非静默丢弃
    expect(args3).toEqual(expect.arrayContaining(['--port', '52301']))
  })

  it('在途 handleReady 的陈旧续体不误删新条目(就绪后崩溃场景)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999650 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    // 旧条目 A 的端口(31234)探测恒失败;B(31235)恒成功
    const probe = vi.fn(async (url: string) => url.includes(':31235'))
    const manager = createLocalRuntime({
      store: storeStub,
      confirmDownload: async () => true,
      installer: makeFakeInstaller(),
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe,
      readyTimeoutMs: 5000,
      healthProbeRetries: 3,
      healthProbeRetryMs: 10
    })
    const instance = localInstance()

    const first = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    children[0]?.stdout.write(readyLine(31234))
    children[0]?.emit('exit', 1, null)
    await first
    await waitForStatus(manager, instance.id, 'error') // 进程意外退出
    // 队列已放行,第二代进程拉起并就绪
    const second = manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2))
    children[1]?.stdout.write(readyLine(31235))
    await second
    await waitForStatus(manager, instance.id, 'running')
    // 等陈旧 handleReady(A) 的重试耗尽(3 次 × 10ms),再断言其失败终局不得误删第二代条目。
    // 注:本用例锁定「换代场景整体」——换代路径中旧条目必然已置 stopping,
    // 仅回看身份检查不足以覆盖此场景,故以整链时序 + 下方三断言兜底。
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(manager.runningIds()).toEqual([instance.id])
    expect(manager.statusOf(instance.id)?.url).toBeUndefined()
    expect(children[0]?.killCall).toEqual([])
  })

  it('stop:子进程永不退出(僵尸/D 态)→ 放行启动队列,排在后面的实例正常启动', async () => {
    // stop(id1) 必须自行 settle 队列,id2 才能开始;readyTimeoutMs 放大到 60s,
    // 防止 ready-timer 兜底触发 settle 而掩盖「缺失的 stop-settle」
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as unknown as FakeChild
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 999640 - children.length
      child.killCall = []
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        return true // 永不触发 exit(模拟 SIGKILL 免疫的 D 态)
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
      readyTimeoutMs: 60_000,
      stopGraceMs: 30
    })
    const inst1 = localInstance({ name: 'A' })
    const inst2 = localInstance({ name: 'B' })
    void manager.start(inst1) // id1:挂住队列头(未就绪、永不退出)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(1))
    // id1 已 spawn 但未写就绪行也不退出:串行任务卡在队列头,id2 排在后面
    const s2 = manager.start(inst2)
    await manager.stop(inst1.id) // kill 无效、永不 exit → 只能靠 stop() 自己放行

    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledTimes(2), { timeout: 2000 })
    children[1]?.stdout.write(readyLine())
    const outcome = await Promise.race([
      s2.then(() => 'settled' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000))
    ])
    expect(outcome).toBe('settled')
    await waitForStatus(manager, inst2.id, 'running')
    expect(manager.runningIds()).toEqual([inst2.id])
    expect(manager.statusOf(inst1.id)?.status).toBe('stopped')
  })
})
