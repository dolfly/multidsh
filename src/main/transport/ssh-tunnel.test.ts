import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { InstanceStatusEvent, SshInstance } from '@shared/contracts'
import { parseKnownHosts } from '../ssh/host-trust'
import {
  controlSlug,
  createSshTunnels,
  ensureSocketsDir,
  socketsDirFor,
  type SshTunnelManager
} from './ssh-tunnel'
import type { SpawnedProcess } from './spawn'

// 进程组回收的平台机制（POSIX 负 pid / Windows taskkill）在 spawn.test.ts 单测；
// 这里只关心「何时、以何信号回收」，故把 killProcessGroup 固定为直接 kill 子进程，
// 让 killCall 断言在任意宿主平台（含 Windows CI）稳定，不受真实 taskkill spawn 影响。
vi.mock('./spawn', async (importActual) => ({
  ...(await importActual<typeof import('./spawn')>()),
  killProcessGroup: (child: { kill(signal?: NodeJS.Signals): boolean }, signal: NodeJS.Signals) => {
    child.kill(signal)
  }
}))

const ISO = '2026-09-15T00:00:00.000Z'

function sshInstance(overrides: Partial<SshInstance> = {}): SshInstance {
  return {
    id: randomUUID(),
    name: '隧道实例',
    transport: 'ssh',
    authMode: 'auto',
    host: 'dsh.internal',
    port: 22,
    username: 'dev',
    remotePort: 3080,
    localPort: null,
    identityFile: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  }
}

interface FakeChild extends SpawnedProcess {
  stdout: PassThrough
  stderr: PassThrough
  emit(event: string, ...args: unknown[]): boolean
  killCall: NodeJS.Signals[]
}

let pidCounter = 900000

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = pidCounter--
  child.killCall = []
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killCall.push(signal ?? 'SIGTERM')
    return true
  }) as never
  return child
}

async function waitForStatus(
  manager: SshTunnelManager,
  id: string,
  status: InstanceStatusEvent['status'],
  // CI 的 Windows runner 负载高时达到 running 偏慢（并发用例曾在 ~3s 擦边超时）；
  // 放宽等待预算消除时序抖动，正常情况仍在到达目标状态时立即返回。
  timeoutMs = 8000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (manager.statusOf(id)?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待状态 ${status} 超时（当前：${manager.statusOf(id)?.status}）`)
}

describe('createSshTunnels（隧道管理器 + 看门狗）', () => {
  // 隧道参数里的 ControlPath/askpass 是 OpenSSH 的 POSIX 接线,Windows 侧另有通道
  it.skipIf(process.platform === 'win32')(
    'start → 隧道建立(参数含 -L 转发/私有 known_hosts) → 探测通过 → running',
    async () => {
      const child = makeFakeChild()
      let lastInvocation!: { args: string[]; env: NodeJS.ProcessEnv }
      const spawnImpl = vi.fn((invocation: { args: string[]; env: NodeJS.ProcessEnv }) => {
        lastInvocation = invocation
        return child as unknown as SpawnedProcess
      })
      const manager = createSshTunnels({
        dataRoot: '/tmp/hub-data',
        spawnImpl: spawnImpl as never,
        probe: async () => true,
        readyTimeoutMs: 2000
      })
      const events: InstanceStatusEvent[] = []
      manager.onStatus((event) => events.push(event))
      const instance = sshInstance()
      await manager.start(instance)
      await waitForStatus(manager, instance.id, 'running')

      expect(lastInvocation?.args).toEqual(
        expect.arrayContaining(['-L', expect.stringMatching(/^30\d+:127\.0\.0\.1:3080$/)])
      )
      expect(lastInvocation?.args.join(' ')).toContain(
        'UserKnownHostsFile=/tmp/hub-data/ssh/known_hosts'
      )
      expect(lastInvocation?.args.join(' ')).toContain('ControlPath=/tmp/hub-data/ssh/')
      expect(lastInvocation?.env['SSH_ASKPASS_REQUIRE']).toBe('never')
      const status = manager.statusOf(instance.id)
      expect(status?.url).toMatch(/^http:\/\/127\.0\.0\.1:30\d+\/$/)
      expect(status?.port).toBeDefined()
      expect(events.map((event) => event.status)).toContain('running')
    }
  )

  it('SSH 别名解析为实际目标时，TOFU 将实际主机键写入私有 known_hosts', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises')
    const dataRoot = await mkdtemp(join(tmpdir(), 'hub-ssh-alias-'))
    const resolved = { host: '108.61.187.89', port: 22 }
    const HOST_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const child = makeFakeChild()
    const manager = createSshTunnels({
      dataRoot,
      spawnImpl: (() => child) as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      portProbe: (async () => true) as never,
      resolveTarget: async () => resolved,
      confirmHostKey: async () => 'trust' as const,
      hostTrustProbe: (host, port) => {
        expect({ host, port }).toEqual(resolved)
        return {
          scan: async () => [{ type: 'ssh-ed25519', blob: HOST_KEY }],
          readTrusted: async () => []
        }
      }
    })
    const instance = sshInstance({ host: 'vsgp' })

    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')

    const knownHosts = await readFile(join(dataRoot, 'ssh', 'known_hosts'), 'utf8')
    expect(knownHosts).toContain(`${resolved.host} ssh-ed25519 ${HOST_KEY}`)
    expect(knownHosts).not.toContain('vsgp ssh-ed25519')

    await manager.forgetHostKey(instance)
    const afterForget = await readFile(join(dataRoot, 'ssh', 'known_hosts'), 'utf8')
    expect(afterForget).not.toContain(resolved.host)
  })

  it('并发启动两个实例 → 本地端口互不冲突(保留集互斥)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      portProbe: (async () => true) as never
    })
    const a = sshInstance({ name: 'A' })
    const b = sshInstance({ name: 'B' })
    void manager.start(a)
    void manager.start(b)
    await waitForStatus(manager, a.id, 'running')
    await waitForStatus(manager, b.id, 'running')

    const ports = (args: string[]): string | undefined => {
      const idx = args.indexOf('-L')
      return args[idx + 1]?.split(':')[0]
    }
    const calls = spawnImpl.mock.calls as Array<[invocation?: { args: string[] }]>
    const portA = ports(calls[0]?.[0]?.args ?? [])
    const portB = ports(calls[1]?.[0]?.args ?? [])
    expect(portA).toBeDefined()
    expect(portB).toBeDefined()
    expect(portA).not.toBe(portB)
  })

  it('spawn 报错(ssh 缺失/资源失败) → error,不进入看门狗', async () => {
    const child = makeFakeChild()
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      readyTimeoutMs: 2000
    })
    const instance = sshInstance()
    const starting = manager.start(instance)
    // 等 spawn 与 'error' 监听器挂好(EventEmitter 无监听器时 emit error 会抛)
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalled())
    child.emit('error', new Error('spawn ssh ENOENT'))
    await starting
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('ENOENT')
    expect(manager.runningIds()).toEqual([])
    // 等一小段,确认没有看门狗重连
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(spawnImpl).toHaveBeenCalledTimes(1)
  })

  it('就绪探测超时(远端未就绪)→ error + 杀进程 + 看门狗自动重连 → running', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    let probePass = false
    const probe = vi.fn(async () => probePass)
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe,
      readyTimeoutMs: 120,
      healthProbeRetryMs: 10,
      backoffBaseMs: 20,
      backoffMaxMs: 200,
      stopGraceMs: 30
    })
    const instance = sshInstance()
    const starting = manager.start(instance)
    // 第一代:探测恒失败 → 就绪超时 → 杀进程 → 看门狗
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('远端 dsh 未就绪')
    expect(children[0]?.killCall).toContain('SIGKILL')
    // 恢复探测 → 重连成功
    probePass = true
    const reconnected = await Promise.race([
      new Promise<'ok'>((resolve) => {
        const timer = setInterval(() => {
          if (
            spawnImpl.mock.calls.length >= 2 &&
            manager.statusOf(instance.id)?.status === 'running'
          ) {
            clearInterval(timer)
            resolve('ok')
          }
        }, 10)
      }),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000))
    ])
    expect(reconnected).toBe('ok')
    await starting
    expect(manager.statusOf(instance.id)?.status).toBe('running')
    expect(manager.statusOf(instance.id)?.detail).toContain('已就绪')
  })

  it('无换行的鉴权失败 stderr 仍可归因，不退化成笼统 255', async () => {
    const child = makeFakeChild()
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')

    child.stderr.write('work@dsh.internal: Permission denied (publickey,password).')
    child.emit('exit', 255, null)

    await waitForStatus(manager, instance.id, 'error')
    const detail = manager.statusOf(instance.id)?.detail ?? ''
    expect(detail).toContain('鉴权失败')
    expect(detail).not.toContain('SSH 会话异常退出（code=255）')
  })

  it('子进程日志行进 detail 前脱敏:行内 URL 查询串被剥离', async () => {
    const child = makeFakeChild()
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: (() => child) as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')

    // 子进程若打印带查询串的 URL（如误把就绪地址回显到 stderr），归因 detail 不得带出 ?token=
    child.stderr.write('ssh error near http://127.0.0.1:3080/?token=leaked-secret\n')
    child.emit('exit', 1, null)
    await waitForStatus(manager, instance.id, 'error')
    const detail = manager.statusOf(instance.id)?.detail ?? ''
    expect(detail).not.toContain('leaked-secret')
    expect(detail).not.toContain('token=')
  })

  it('看门狗:断线 → 归因 + 退避重连(第 N 次自动重连)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      backoffBaseMs: 30,
      backoffMaxMs: 500,
      stableResetMs: 60_000,
      stopGraceMs: 30
    })
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')

    // 模拟断线:stderr 带连接拒绝特征
    children[0]?.stderr.write('ssh: connect to host 10.0.0.1 port 22: Connection refused\n')
    children[0]?.emit('exit', 255, null)
    await waitForStatus(manager, instance.id, 'error')
    const errorDetail = manager.statusOf(instance.id)?.detail ?? ''
    expect(errorDetail).toContain('连接被拒绝')
    expect(errorDetail).toContain('自动重连')

    // 退避后自动重连 → 再次 running
    await waitForStatus(manager, instance.id, 'running', 5000)
    expect(spawnImpl).toHaveBeenCalledTimes(2)
    await waitForStatus(manager, instance.id, 'running')
    // 第二次自动重连的 detail 序号递增
    const restartEvents = manager.statusOf(instance.id)
    expect(restartEvents?.detail).toContain('已就绪')
  })

  it('稳定 ≥ stableResetMs 后断线 → 退避重置()', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      backoffBaseMs: 40,
      backoffMaxMs: 400,
      stableResetMs: 100,
      stopGraceMs: 30
    })
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')

    // 第一次断线:不稳定(就绪 10ms) → 退避从基数 0.04s 开始,下一次翻倍为 0.08s
    children[0]?.emit('exit', 255, null)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('0.04s')

    // 重连并稳定 400ms(≫100ms 阈值,留足并行跑余量) 后再断线 → 退避重置回基数
    await waitForStatus(manager, instance.id, 'running', 5000)
    await new Promise((resolve) => setTimeout(resolve, 400))
    children[1]?.emit('exit', 1, null)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('0.04s') // 而非 0.08s

    // 第三次连接按基数重试
    await waitForStatus(manager, instance.id, 'running', 5000)
    expect(spawnImpl).toHaveBeenCalledTimes(3)
  })

  it('forward 失败(本地端口被占)→ 重连前重新分配端口', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    /** 无类型 mock 下安全取第 index 次 spawn 的 argv */
    const argsOf = (index: number): string[] =>
      (spawnImpl.mock.calls as Array<[invocation?: { args: string[] }]>)[index]?.[0]?.args ?? []
    const specOf = (index: number): string => {
      const args = argsOf(index)
      return args[args.indexOf('-L') + 1] ?? ''
    }
    // 30000 在第一次分配后变成「外部占用」
    let externalBlocked: number[] = []
    const portProbe = vi.fn(async (port: number) => !externalBlocked.includes(port))
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      backoffBaseMs: 20,
      stableResetMs: 60_000,
      stopGraceMs: 30,
      portProbe: portProbe as never
    })
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    const firstPort = specOf(0)

    externalBlocked = [Number(firstPort.split(':')[0])]
    children[0]?.stderr.write('Warning: remote port forwarding failed for listen port 3080\n')
    children[0]?.emit('exit', 255, null)

    await waitForStatus(manager, instance.id, 'running', 5000)
    const secondPort = specOf(1)
    expect(secondPort).not.toBe('')
    // 换端口重连:新端口的 -L 描述不同于旧端口
    const portOf = (spec: string): string => spec.split(':')[0] ?? ''
    expect(portOf(secondPort)).not.toBe(portOf(firstPort))
    expect(manager.statusOf(instance.id)?.detail).toContain('已就绪')
  })

  it('stop → SIGTERM 杀进程树 → stopped;恢复后端口释放可复用', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      // 对 SIGTERM 不退出 → stop 需 SIGKILL 兜底(模拟僵尸)
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        if (signal === 'SIGKILL') setImmediate(() => child.emit('exit', 0, 'SIGKILL'))
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      stopGraceMs: 30
    })
    const instance = sshInstance()
    const starting = manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    await manager.stop(instance.id)
    expect(children[0]?.killCall).toContain('SIGKILL')
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
    expect(manager.runningIds()).toEqual([])
    await starting

    // 重启:分配的端口与第一次相同(沿用被占用的端口检查通过)
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    const ports: string[] = []
    const calls = spawnImpl.mock.calls as Array<[invocation?: { args: string[] }]>
    for (let index = 0; index < calls.length; index++) {
      const args = calls[index]?.[0]?.args ?? []
      const idx = args.indexOf('-L')
      ports.push((args[idx + 1] ?? '').split(':')[0] ?? '')
    }
    expect(ports[1] ?? '').toBe(ports[0] ?? '')
  })

  it('排队期间 stop(端口分配窗口)→ 取消启动,不 spawn', async () => {
    let releasePort!: () => void
    const gate = new Promise<boolean>((resolve) => {
      releasePort = () => resolve(true)
    })
    const portProbe = vi.fn(() => gate) as never
    const spawnImpl = vi.fn(() => makeFakeChild() as unknown as SpawnedProcess)
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      portProbe,
      readyTimeoutMs: 2000
    })
    const instance = sshInstance()
    const starting = manager.start(instance)
    await vi.waitFor(() => expect(portProbe).toHaveBeenCalled())
    await manager.stop(instance.id) // 无条目 → 登记取消意图
    expect(manager.statusOf(instance.id)?.status).toBe('stopped')
    releasePort()
    await starting
    expect(spawnImpl).not.toHaveBeenCalled() // 端口分配后检查取消意图并放弃
  })

  it('stop 落在 ControlPath 清理的 await 窗口内 → 不 spawn 孤儿 ssh,条目/端口全部回滚', async () => {
    // 会把条目从 entries 摘除并标记 stopping;旧代码在这里没有重新检查,于是照样 spawn 出一个
    // stop()/stopAll() 再也找不到的 ssh 进程(一直占着转发端口),而 UI 已显示「隧道已停止」。
    const child = makeFakeChild()
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      portProbe: (async () => true) as never
    })
    const instance = sshInstance()
    let stopScheduled = false
    manager.onStatus((event) => {
      if (event.id !== instance.id || stopScheduled) return
      // 「建立 SSH 隧道」这条 starting 紧跟在 entries.set 之后,下一条语句就是
      // `await rm(entry.controlPath)`:用微任务把 stop() 排到 rm 的 I/O 回调之前,
      // 它就确定性地落在那个 await 窗口内(不靠 sleep 抢跑)。
      if (event.status !== 'starting' || event.detail?.includes('建立 SSH 隧道') !== true) return
      stopScheduled = true
      queueMicrotask(() => void manager.stop(instance.id))
    })
    await manager.start(instance)
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(manager.runningIds()).toEqual([]) // 条目已从 entries 回滚,无残留跟踪
    expect(manager.statusOf(instance.id)?.status).toBe('stopped') // 终端状态准确,绝不报 running
  })

  it('同 id 重复 start 幂等:已在运行则不再 spawn', async () => {
    const child = makeFakeChild()
    const spawnImpl = vi.fn(() => child as unknown as SpawnedProcess)
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000
    })
    const instance = sshInstance()
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    await manager.start(instance)
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    expect(manager.statusOf(instance.id)?.detail).toContain('忽略重复启动')
  })
})
// unix socket 104 字节上限是 POSIX AF_UNIX 约束,Windows 无此语义
describe.skipIf(process.platform === 'win32')(
  'ControlPath 路径规则（unix socket 104 字节上限）',
  () => {
    it('socket slug 按实例隔离且短（12 hex,UUID 去横线）', () => {
      const instance = sshInstance({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' })
      expect(controlSlug(instance)).toBe('f47ac10b58cc')
      expect(controlSlug(instance)).toHaveLength(12)
      expect(controlSlug(sshInstance({ id: 'a47ac10b-58cc-4372-a567-0e02b2c3d479' }))).not.toBe(
        controlSlug(instance)
      )
    })

    it('数据目录短 → socket 落在 <dataRoot>/ssh', () => {
      expect(socketsDirFor('/tmp/hub-data')).toBe('/tmp/hub-data/ssh')
    })

    it('数据目录过长时自适应退化到系统临时目录', () => {
      // 长度是这条用例的关键输入:退化阈值是 dataRoot ≥ 66 字节。前缀取自系统临时目录,
      // 既不写死任何用户的目录结构,又在 macOS/Linux 上都足够长。
      const long = join(
        tmpdir(),
        'workspace',
        'private',
        'some-very-long-org',
        'dsh-plugins',
        'dsh-hub-desktop',
        'hub-data',
        'verify-ssh'
      )
      expect(long.length).toBeGreaterThan(66)
      const dir = socketsDirFor(long)
      expect(dir).not.toBe(`${long}/ssh`)
      const base =
        process.env['XDG_RUNTIME_DIR'] !== undefined && process.env['XDG_RUNTIME_DIR'].trim() !== ''
          ? process.env['XDG_RUNTIME_DIR']
          : tmpdir()
      expect(dir.startsWith(base)).toBe(true)
      // 最坏形态(12 字符 slug + ssh 追加大约 16 字符随机后缀)必须 < 104 字节
      expect(join(dir, 'ctl-000000000000').length + 17).toBeLessThan(104)
    })
  }
)

describe.skipIf(process.platform === 'win32')('ensureSocketsDir（socket 目录安全）', () => {
  it('短 dataRoot → 创建 <root>/ssh 为 0700，与 socketsDirFor 同步', async () => {
    const root = await mkdtemp('/tmp/hub-ensure-short-')
    try {
      const dir = await ensureSocketsDir(root)
      expect(dir).toBe(join(root, 'ssh'))
      expect(socketsDirFor(root)).toBe(dir)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('已存在但权限过宽 → 收敛回 0700（不换目录）', async () => {
    const root = await mkdtemp('/tmp/hub-ensure-wide-')
    try {
      const dir = join(root, 'ssh')
      await mkdir(dir, { recursive: true, mode: 0o755 })
      await chmod(dir, 0o755)
      const ensured = await ensureSocketsDir(root)
      expect(ensured).toBe(dir)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('属主校验不过（他人预建）→ mkdtemp 随机目录，后续派生共用', async () => {
    const root = await mkdtemp('/tmp/hub-ensure-owner-')
    let fallbackDir: string | null = null
    // 模拟「目录属主不是当前进程」：getuid 返回一个不可能匹配的值
    const spy = vi.spyOn(process, 'getuid').mockReturnValue(999_999)
    try {
      const dir = await ensureSocketsDir(root)
      fallbackDir = dir
      expect(dir).not.toBe(join(root, 'ssh'))
      // ControlPath 与 askpass 两处派生点经 socketsDirFor 拿到同一目录
      expect(socketsDirFor(root)).toBe(dir)
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      // 缓存：再次 ensure 不换目录
      expect(await ensureSocketsDir(root)).toBe(dir)
    } finally {
      spy.mockRestore()
      if (fallbackDir !== null) await rm(fallbackDir, { recursive: true, force: true })
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('防线', () => {
  it('僵尸兜底安排重连后,迟到的 exit 不得吞掉重连(清 timer 必须复位标志)', async () => {
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      // SIGKILL 免疫:exit 事件迟到 60ms(落在 reconnect timer 之前)
      child.kill = vi.fn((signal?: NodeJS.Signals) => {
        child.killCall.push(signal ?? 'SIGTERM')
        if (signal === 'SIGKILL') setTimeout(() => child.emit('exit', null, 'SIGKILL'), 60)
        return true
      }) as never
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => false, // 就绪探测恒失败 → 走僵尸兜底分支
      readyTimeoutMs: 60,
      healthProbeRetryMs: 5,
      backoffBaseMs: 200,
      stopGraceMs: 20,
      portProbe: (async () => true) as never
    })
    const instance = sshInstance()
    await manager.start(instance)
    // 迟到 exit(~140ms) 与 reconnect timer(200ms) 都过去后,看门狗必须已经重连
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(spawnImpl.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('子进程启动失败留下「有条目无子进程」状态时,再次 start 能自愈重排', async () => {
    // 否则第二次 start 走全新条目路径,自愈分支永不被覆盖(旧用例是空转测试)
    const children: FakeChild[] = []
    let firstAttempt = true
    const spawnImpl = vi.fn((invocation: { args: string[] }) => {
      void invocation
      if (firstAttempt) {
        firstAttempt = false
        throw new Error('spawn 失败（模拟 ENOENT/资源不足）')
      }
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot: '/tmp/hub-data',
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      stopGraceMs: 20,
      portProbe: (async () => true) as never
    })
    const instance = sshInstance()
    // 第一次:spawn 同步抛错 → start 的 catch 兜住,条目留在 entries 且 child===null
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')
    expect(spawnImpl).toHaveBeenCalledTimes(1)

    await manager.start(instance)
    await vi.waitFor(() => expect(spawnImpl.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000
    })
    // 自愈后应能真正就绪
    await waitForStatus(manager, instance.id, 'running', 5000)
  })
})

describe('防线', () => {
  it('指纹变化一律拒绝连接且不改动旧公钥;显式「忘记该主机指纹」后才重新 TOFU', async () => {
    //   变化 → 拒绝(即使渲染层回答 trust,旧公钥也一个字节都不改)
    //   → 显式 forgetHostKey → 下一次连接重新走首次 TOFU,确认后才放行。
    const { mkdtemp, readFile, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dataRoot = await mkdtemp(join(tmpdir(), 'hub-t5-forget-'))
    const knownHostsPath = join(dataRoot, 'ssh', 'known_hosts')
    const OLD_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIL/GqayzeH4ALFQzq7BrQ4lodGaiDICVgULWk7rQZ4iw'
    const NEW_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const hostField = '[dsh.internal]:2222'
    // 预置一条「已被取代」的旧公钥
    await mkdir(join(dataRoot, 'ssh'), { recursive: true })
    await writeFile(knownHostsPath, `${hostField} ssh-ed25519 ${OLD_KEY}\n`, { mode: 0o600 })

    // 即使确认回调返回 trust，已变化的指纹仍必须被拒绝。
    const confirmHostKey = vi.fn(async (request: { verdict: string }) => {
      void request
      return 'trust' as const
    })
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot,
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      confirmHostKey,
      portProbe: (async () => true) as never,
      // 服务端现在出示新公钥(与已信任的不同 → changed);已信任集合从磁盘真实读取,
      // 「忘记」才有可观测效果
      hostTrustProbe: () => ({
        scan: async () => [{ type: 'ssh-ed25519', blob: NEW_KEY }],
        readTrusted: async () => {
          const content = await readFile(knownHostsPath, 'utf8').catch(() => '')
          return parseKnownHosts(content, hostField)
        }
      })
    })
    const instance = sshInstance({ host: 'dsh.internal', port: 2222 })

    // ① 指纹变化 → 拒绝连接:不 spawn、不 running、旧公钥不被覆盖
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('拒绝连接')
    expect(confirmHostKey).toHaveBeenCalledTimes(1)
    expect(confirmHostKey.mock.calls[0]?.[0]).toMatchObject({ verdict: 'changed' })
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(manager.runningIds()).toEqual([])
    const afterRefusal = await readFile(knownHostsPath, 'utf8')
    expect(afterRefusal).toContain(OLD_KEY) // 旧公钥仍在
    expect(afterRefusal).not.toContain(NEW_KEY) // 新公钥未被写入

    // ② 显式恢复动作(不属于连接确认流程):忘记该主机指纹
    await manager.forgetHostKey(instance)
    const afterForget = await readFile(knownHostsPath, 'utf8')
    expect(afterForget).not.toContain(OLD_KEY)
    expect(afterForget).not.toContain(NEW_KEY)

    // ③ 忘记之后重新连接 = 首次 TOFU:必须再确认一次,确认后才放行
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    expect(confirmHostKey).toHaveBeenCalledTimes(2)
    expect(confirmHostKey.mock.calls[1]?.[0]).toMatchObject({ verdict: 'unknown' })
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    const afterTrust = await readFile(knownHostsPath, 'utf8')
    expect(afterTrust).toContain(NEW_KEY)
    expect(children[0]?.pid).toBeDefined()
  })

  it('首次连接确认后追加写入(unaffected 行保留)', async () => {
    const { mkdtemp, readFile, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dataRoot = await mkdtemp(join(tmpdir(), 'hub-t5-append-'))
    const knownHostsPath = join(dataRoot, 'ssh', 'known_hosts')
    const OTHER_HOST_LINE = 'other.host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHER'
    await mkdir(join(dataRoot, 'ssh'), { recursive: true })
    await writeFile(knownHostsPath, `${OTHER_HOST_LINE}\n`, { mode: 0o600 })

    const NEW_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const child = makeFakeChild()
    const manager = createSshTunnels({
      dataRoot,
      spawnImpl: (() => child) as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      confirmHostKey: async () => 'trust' as const,
      portProbe: (async () => true) as never,
      hostTrustProbe: () => ({
        scan: async () => [{ type: 'ssh-ed25519', blob: NEW_KEY }],
        readTrusted: async () => []
      })
    })
    const instance = sshInstance({ host: 'dsh.internal', port: 2222 })
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    const content = await readFile(knownHostsPath, 'utf8')
    expect(content).toContain(NEW_KEY)
    expect(content).toContain(OTHER_HOST_LINE) // 其他主机条目不受影响
  })

  it('用户拒绝确认 → 隧道不建立且不写 known_hosts', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dataRoot = await mkdtemp(join(tmpdir(), 'hub-t5-reject-'))
    const knownHostsPath = join(dataRoot, 'ssh', 'known_hosts')
    const spawnImpl = vi.fn(() => makeFakeChild() as unknown as SpawnedProcess)
    const manager = createSshTunnels({
      dataRoot,
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      confirmHostKey: async () => 'reject' as const,
      portProbe: (async () => true) as never,
      hostTrustProbe: () => ({
        scan: async () => [{ type: 'ssh-ed25519', blob: 'AAAAC3NzaC1lZDI1NTE5AAAAINEWNEWNEW' }],
        readTrusted: async () => []
      })
    })
    const instance = sshInstance({ host: 'dsh.internal', port: 2222 })
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('指纹')
    expect(spawnImpl).not.toHaveBeenCalled() // 未确认身份则不 spawn
    await expect(readFile(knownHostsPath, 'utf8')).rejects.toThrow() // 未写入
  })
})
