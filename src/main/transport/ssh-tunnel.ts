/**
 *
 * 生命周期：start 分配并保留本地端口 → spawn 系统 OpenSSH（`ssh -N -L`，参数库见
 * stderr 特征）→ 指数退避 1→2→4→…→30s 自动重连，稳定运行 ≥ stableResetMs 后重置
 *
 * 状态推进只经 `onStatus` 向外发布，本模块可脱离 Electron 单独测试。
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstanceStatusEvent, SshInstance } from '@shared/contracts'
import { redactLine } from '@shared/redact'
import {
  DEFAULT_PORT_RANGE_END,
  DEFAULT_PORT_RANGE_START,
  findFreePort,
  isPortFree
} from '../local-runtime/port-allocator'
import type { PortProbe } from '../local-runtime/port-allocator'
import {
  askpassSocketPath,
  ensureAskpassScripts,
  startAskpassServer,
  type AskpassServer
} from '../ssh/askpass'
import {
  createHostTrustProbe,
  evaluateHostTrust,
  hostTargetLabel,
  knownHostsHostField,
  recordHostTrust,
  toFingerprints,
  resolveSshTarget,
  type HostKeyEntry,
  type HostKeyPrompt,
  type HostTrustProbe,
  type ResolvedSshTarget
} from '../ssh/host-trust'
import { classifySshExit, type SshExitAttribution } from './attribution'
import { sshTunnelEndpoint } from './endpoint-resolver'
import { httpHealthProbe, sleep, type HealthProbe } from './probe'
import { buildSshArgs } from './ssh-args'
import { createStatusBus } from './status-bus'
import { nodeModeExecutable } from '../node-mode'
import { controlSlug, ensureSocketsDir, socketsDirFor } from './ssh-sockets'

// ControlPath 目录规划与实例 slug 由 ssh-sockets 承载，这里继续对外暴露同一组入口。
export { controlSlug, ensureSocketsDir, socketsDirFor }
import {
  detachedSpawn,
  killProcessGroup,
  waitForProcessExit,
  type SpawnLike,
  type SpawnedProcess
} from './spawn'

/** 诊断用的日志环形缓冲行数与残片上限（与 local-runtime 同构） */
const LOG_BUFFER_LINES = 40
const LOG_BUFFER_MAX = 64 * 1024

export interface SshTunnelOptions {
  /** 应用数据根：ControlPath / 私有 known_hosts 落在 `<dataRoot>/ssh/` */
  dataRoot: string
  /** ssh 可执行文件（缺省 `ssh`，跟随 PATH） */
  sshCommand?: string
  /** 注入假 spawn 以便单测（缺省真 spawn + detached） */
  spawnImpl?: SpawnLike
  probe?: HealthProbe
  /** 端口可绑定探测（含本管理器保留集；缺省真实 bind 探测） */
  portProbe?: PortProbe
  healthTimeoutMs?: number
  healthProbeRetryMs?: number
  /** 就绪探测总期限（含远端 dsh 未就绪的容忍，默认 30s） */
  readyTimeoutMs?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  stableResetMs?: number
  stopGraceMs?: number
  now?: () => number
  askpass?: (request: { instanceId: string; prompt: string }) => Promise<string | null>
  confirmHostKey?: (request: HostKeyPrompt) => Promise<'trust' | 'reject'>
  /** askpass helper 使用的 Node 命令(缺省 process.execPath + ELECTRON_RUN_AS_NODE) */
  askpassNode?: { command: string; args: string[] }
  /** ssh -G 实际目标解析器（注入以便别名 + TOFU 对齐的测试） */
  resolveTarget?: (
    instance: Pick<SshInstance, 'host' | 'port' | 'username'>
  ) => Promise<ResolvedSshTarget>
  /** 信任探测器工厂(注入以便单测覆盖 TOFU 写入/轮换;缺省 ssh-keyscan + 私有 known_hosts) */
  hostTrustProbe?: (host: string, port: number, knownHostsPath: string) => HostTrustProbe
}

export interface SshTunnelManager {
  onStatus(listener: (event: InstanceStatusEvent) => void): () => void
  statusOf(id: string): InstanceStatusEvent | null
  runningIds(): string[]
  start(instance: SshInstance): Promise<void>
  stop(id: string): Promise<void>
  stopAll(): Promise<void>
  /**
   * 忘记某实例主机的已信任公钥 —— 删除 hub 私有 known_hosts 中该目标的全部条目。
   * 这是**显式、独立、破坏性**的操作,不属于连接确认流程:连接时指纹变化一律拒绝
   * 且不自动清理;只有用户主动调用本方法后,下一次连接才会重新走首次 TOFU。
   */
  forgetHostKey(instance: SshInstance): Promise<void>
}

interface TunnelEntry {
  id: string
  child: SpawnedProcess | null
  localPort: number
  /** 远端目标展示标签（如 `myhost:3080`） */
  remoteLabel: string
  url: string
  log: string[]
  buffer: string
  ready: boolean
  stopping: boolean
  reconnectScheduled: boolean
  reconnectTimer: NodeJS.Timeout | null
  /** 当前退避：断线后先等 backoffMs 再重连，随后翻倍（上限 backoffMaxMs） */
  backoffMs: number
  /** 最近一次就绪时刻；null = 当前不在稳定运行 */
  stableSince: number | null
  /** 就绪超时主动杀死子进程时携带的归因（exit handler 消费） */
  pendingReason: SshExitAttribution | null
  /** 上次退出归因为端口转发失败 → 重连前换端口 */
  forwardFailed: boolean
  reconnectCount: number
  controlPath: string
  reconnecting: boolean
  askpassServer: AskpassServer | null
  askpassWrapperPath: string | null
}

export function createSshTunnels(options: SshTunnelOptions): SshTunnelManager {
  const dataRoot = options.dataRoot
  const sshCommand = options.sshCommand ?? 'ssh'
  const spawnImpl = options.spawnImpl ?? detachedSpawn
  const probe = options.probe ?? httpHealthProbe
  const portProbe = options.portProbe
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  const healthProbeRetryMs = options.healthProbeRetryMs ?? 500
  const readyTimeoutMs = options.readyTimeoutMs ?? 30_000
  const backoffBaseMs = options.backoffBaseMs ?? 1_000
  const backoffMaxMs = options.backoffMaxMs ?? 30_000
  const stableResetMs = options.stableResetMs ?? 60_000
  const stopGraceMs = options.stopGraceMs ?? 3_000
  const now = options.now ?? (() => Date.now())
  const askpass = options.askpass
  const confirmHostKey = options.confirmHostKey
  const askpassNode = options.askpassNode ?? { command: nodeModeExecutable(), args: [] }
  const resolveTarget =
    options.resolveTarget ??
    ((instance: Pick<SshInstance, 'host' | 'port' | 'username'>) =>
      resolveSshTarget(instance, sshCommand))
  const trustProbeFactory =
    options.hostTrustProbe ??
    ((host: string, port: number, knownHostsPath: string) =>
      createHostTrustProbe(host, port, { knownHostsPath }))

  const entries = new Map<string, TunnelEntry>()
  /** 同 id 并发 start 的同步闸（start 入口即占用，finally 释放） */
  const startingIds = new Set<string>()
  /** 排队期间被 stop 的实例：轮到它 spawn 前直接放弃 */
  const cancelRequested = new Set<string>()
  /** 本管理器已保留的本地端口（并发分配互斥，防两个隧道抢同一端口） */
  const reservedPorts = new Set<number>()
  /** 重连时需要的实例最新配置；start 登记、stop/删除清理 */
  const latestInstances = new Map<string, SshInstance>()

  const bus = createStatusBus(now, 'ssh-tunnel')
  const { emit, onStatus, statusOf } = bus

  function pushLog(entry: TunnelEntry, chunk: unknown): void {
    entry.buffer += String(chunk)
    // 无换行残片上限（超长单行异常输出），只保留尾部防无界增长
    if (entry.buffer.length > LOG_BUFFER_MAX) entry.buffer = entry.buffer.slice(-LOG_BUFFER_MAX)
    let newlineIndex: number
    while ((newlineIndex = entry.buffer.indexOf('\n')) !== -1) {
      const line = entry.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      entry.buffer = entry.buffer.slice(newlineIndex + 1)
      // 日志行进 detail/归因前统一脱敏：剥掉行内 URL 的查询串（防 ?token= 等意外泄漏）。
      if (line.trim() !== '') entry.log.push(redactLine(line))
    }
    if (entry.log.length > LOG_BUFFER_LINES)
      entry.log.splice(0, entry.log.length - LOG_BUFFER_LINES)
  }

  function drainLogBuffer(entry: TunnelEntry): void {
    const trailing = entry.buffer.trim()
    if (trailing !== '') entry.log.push(redactLine(trailing))
    entry.buffer = ''
    if (entry.log.length > LOG_BUFFER_LINES)
      entry.log.splice(0, entry.log.length - LOG_BUFFER_LINES)
  }

  async function resolveTargetOrFallback(instance: SshInstance): Promise<ResolvedSshTarget> {
    try {
      return await resolveTarget(instance)
    } catch {
      // `ssh -G` 仅用于对齐别名的实际目标；不可用时仍可按实例输入继续连接并归因。
      return { host: instance.host, port: instance.port }
    }
  }

  async function ensureTrust(
    instance: SshInstance,
    emitWaiting: (detail: string) => void
  ): Promise<boolean> {
    const target = await resolveTargetOrFallback(instance)
    const knownHostsPath = join(dataRoot, 'ssh', 'known_hosts')
    const hostField = knownHostsHostField(target.host, target.port)
    const probe = trustProbeFactory(target.host, target.port, knownHostsPath)
    const trusted = await probe.readTrusted()
    let scanned: HostKeyEntry[]
    try {
      scanned = await probe.scan()
    } catch {
      // keyscan 拿不到公钥(主机不可达/网络抖动):不做 TOFU 判定,放行交给 ssh 自己连接。
      // 这是安全的 fail-open —— ssh 侧以 StrictHostKeyChecking=yes + 私有 UserKnownHostsFile
      // 运行（见 ssh-args），未知主机在 ssh 层直接失败关闭，hub 放行不等于自动信任。
      return true
    }
    // 同理，keyscan 返回空（远端未出示任何公钥）时也放行给 ssh 兜底判定。
    if (scanned.length === 0) return true
    const evaluation = evaluateHostTrust(trusted, scanned)
    if (evaluation.verdict === 'trusted') return true
    if (evaluation.verdict === 'changed') {
      // 这里仍然把新旧指纹如实投给 UI 供人工核对(告警),但**任何回答都不放行**,旧公钥
      // 一个字节都不改。想恢复只能在隧道外显式执行遗忘（forgetHostKey），下次连接重新 TOFU。
      emitWaiting('服务器指纹已变化，已拒绝连接')
      if (confirmHostKey) {
        await confirmHostKey({
          instanceId: instance.id,
          target: hostTargetLabel(target.host, target.port),
          verdict: 'changed',
          fingerprints: toFingerprints(scanned),
          previousFingerprints: toFingerprints(evaluation.mismatched)
        })
      }
      return false
    }
    if (!confirmHostKey) return true // 未接线(单测)则直接放行
    emitWaiting('等待确认服务器指纹')
    const decision = await confirmHostKey({
      instanceId: instance.id,
      target: hostTargetLabel(target.host, target.port),
      verdict: 'unknown',
      fingerprints: toFingerprints(scanned),
      previousFingerprints: []
    })
    if (decision !== 'trust') return false
    await recordHostTrust(knownHostsPath, hostField, scanned, 'append')
    return true
  }

  async function startAskpassFor(entry: TunnelEntry): Promise<AskpassServer | null> {
    if (!askpass) return null
    const scripts = await ensureAskpassScripts(
      join(dataRoot, 'ssh'),
      askpassNode.command,
      askpassNode.args
    )
    const server = await startAskpassServer({
      socketPath: askpassSocketPath(socketsDirFor(dataRoot), controlSlug(entry)),
      onPrompt: async ({ prompt }) => {
        emit(entry.id, 'starting', { detail: '等待输入 SSH 口令（不落盘）' })
        const secret = await askpass({ instanceId: entry.id, prompt })
        if (secret !== null) emit(entry.id, 'starting', { detail: '已收到口令，继续建立隧道' })
        return secret
      }
    })
    entry.askpassWrapperPath = scripts.wrapperPath
    return server
  }

  /** 端口可用性 = 未被本管理器保留 + 可绑定（portProbe 可注入） */
  async function isPortAvailable(port: number): Promise<boolean> {
    if (reservedPorts.has(port)) return false
    if (portProbe) return portProbe(port)
    return isPortFree(port)
  }

  /**
   * 释放条目占用的资源：从注册表移除、归还本地端口、关掉 askpass 服务。
   * `dropControlPath` 为真时一并删除本条目的 ControlPath（带 force，文件不存在不算错）。
   */
  function disposeEntry(
    entry: TunnelEntry,
    { dropControlPath }: { dropControlPath: boolean }
  ): void {
    entries.delete(entry.id)
    reservedPorts.delete(entry.localPort)
    if (dropControlPath) {
      void rm(entry.controlPath, { force: true }).catch(() => undefined)
    }
    if (entry.askpassServer) void entry.askpassServer.close().catch(() => undefined)
    entry.askpassServer = null
  }

  /** 本地端口分配串行链：保留集的 check-then-add 必须原子，并发分配不得抢到同一端口 */
  let allocChain: Promise<unknown> = Promise.resolve()

  /** 分配并保留本地端口：优先沿用实例已持久化的 localPort（被占则递增），区间外向 65535 递进 */
  function allocLocalPort(instance: SshInstance): Promise<number> {
    const next = allocChain.then(() => allocLocalPortInner(instance))
    allocChain = next.catch(() => undefined)
    return next
  }

  /**
   * 换一个本地端口（forward 失败重连用）：先释放旧端口再在区间内找新端口。
   * 必须与 allocLocalPort 走同一条 allocChain —— 否则 findFreePort 与 reservedPorts.add
   * 之间的窗口里，另一实例的并发分配会把同一端口观察为空闲而双双保留（重复 -L 绑定）。
   */
  function reallocLocalPort(previous: number): Promise<number> {
    const next = allocChain.then(async () => {
      reservedPorts.delete(previous)
      const port = await findFreePort({
        start: DEFAULT_PORT_RANGE_START,
        end: DEFAULT_PORT_RANGE_END,
        probe: isPortAvailable
      })
      reservedPorts.add(port)
      return port
    })
    allocChain = next.catch(() => undefined)
    return next
  }

  async function allocLocalPortInner(instance: SshInstance): Promise<number> {
    const preferred = instance.localPort
    if (preferred !== null && (await isPortAvailable(preferred))) {
      reservedPorts.add(preferred)
      return preferred
    }
    const start = preferred ?? DEFAULT_PORT_RANGE_START
    const end = start > DEFAULT_PORT_RANGE_END ? 65_535 : DEFAULT_PORT_RANGE_END
    const port = await findFreePort({ start, end, probe: isPortAvailable })
    reservedPorts.add(port)
    return port
  }

  function spawnSsh(entry: TunnelEntry, instance: SshInstance): SpawnedProcess {
    const args = buildSshArgs(instance, entry.localPort, {
      controlPath: entry.controlPath,
      knownHostsPath: join(dataRoot, 'ssh', 'known_hosts')
    })
    // - DISPLAY 需非空,OpenSSH 才会走 askpass 分支（无 tty 场景）
    // - ELECTRON_RUN_AS_NODE=1 让包装脚本用 Electron 自带 Node 执行 helper
    // - DSH_HUB_ASKPASS_SOCKET 指向本实例的 unix socket
    const askpassEnv = entry.askpassWrapperPath
      ? {
          SSH_ASKPASS: entry.askpassWrapperPath,
          SSH_ASKPASS_REQUIRE: 'force',
          DISPLAY: process.env['DISPLAY'] ?? 'dsh-hub',
          ELECTRON_RUN_AS_NODE: '1',
          DSH_HUB_ASKPASS_SOCKET: askpassSocketPath(socketsDirFor(dataRoot), controlSlug(entry))
        }
      : { SSH_ASKPASS_REQUIRE: 'never' as const }
    const child = spawnImpl({
      command: sshCommand,
      args,
      env: { ...process.env, ...askpassEnv },
      cwd: join(dataRoot, 'ssh'),
      detached: true
    })
    attachHandlers(child, entry)
    return child
  }

  async function waitForReady(entry: TunnelEntry, child: SpawnedProcess): Promise<void> {
    // 探测与重试都要重新判定：期间条目可能已被 stop 摘除或换成新子进程。
    const stale = (): boolean => entry.stopping || entry.child !== child
    if (stale()) return
    const deadline = now() + readyTimeoutMs
    while (now() < deadline) {
      if (stale()) return
      const healthy = await probe(entry.url, healthTimeoutMs)
      if (stale()) return
      if (healthy) {
        if (stale()) return
        entry.ready = true
        entry.stableSince = now()
        entry.forwardFailed = false
        emit(entry.id, 'running', {
          url: entry.url,
          port: entry.localPort,
          detail: `SSH 隧道已就绪（127.0.0.1:${entry.localPort} → ${entry.remoteLabel}）`
        })
        return
      }
      if (stale()) return
      await sleep(healthProbeRetryMs)
    }
    if (stale()) return
    // 就绪期限内远端 dsh 未响应：杀掉本次隧道，让看门狗按退避重连（远端可能正在重启）
    entry.pendingReason = { kind: 'connect', message: '远端 dsh 未就绪' }
    killProcessGroup(child, 'SIGKILL')
    const exited = await waitForProcessExit(child, stopGraceMs)
    if (entry.child !== child) return
    if (!exited) {
      // 僵尸兜底：exit 事件不来的话，也要让用户看到归因并安排重连
      entry.pendingReason = null
      emit(entry.id, 'error', { detail: '远端 dsh 未就绪（就绪探测超时），即将自动重连' })
      scheduleReconnect(entry)
    }
  }

  /** 取消已排队的重连：清 timer **必须同时复位 reconnectScheduled**,
   *  否则后续 scheduleReconnect 会被幂等守卫短路 → 看门狗永久卡死
   *  （实测:僵尸兜底先 schedule、迟到 exit 又清 timer 时就复现） */
  function cancelReconnect(entry: TunnelEntry): void {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
    }
    entry.reconnectScheduled = false
  }

  /** 看门狗：按当前退避调度重连（幂等：已调度则不重复） */
  function scheduleReconnect(entry: TunnelEntry): void {
    if (entry.stopping || entry.reconnectScheduled) return
    entry.reconnectScheduled = true
    const waitMs = entry.backoffMs
    entry.backoffMs = Math.min(entry.backoffMs * 2, backoffMaxMs)
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectScheduled = false
      entry.reconnectTimer = null
      if (entry.stopping) return
      void reconnect(entry).catch((error: unknown) => {
        console.error('[ssh-tunnel] 自动重连失败：', error)
        const current = entries.get(entry.id)
        if (current === entry && !entry.stopping) scheduleReconnect(entry)
      })
    }, waitMs)
    entry.reconnectTimer.unref?.()
  }

  async function reconnect(entry: TunnelEntry): Promise<void> {
    if (entry.stopping || entry.reconnecting) return
    entry.reconnecting = true
    try {
      await reconnectInner(entry)
    } finally {
      entry.reconnecting = false
    }
  }

  async function reconnectInner(entry: TunnelEntry): Promise<void> {
    if (entry.stopping) return
    entry.reconnectCount += 1
    emit(entry.id, 'starting', { detail: `第 ${entry.reconnectCount} 次自动重连（${entry.url}）` })
    // 陈旧的 ControlPath 遗留一并清理（死进程残留的 socket 会让 ssh 拒绝复用）。
    await rm(entry.controlPath, { force: true }).catch(() => undefined)
    const instance = latestInstances.get(entry.id)
    if (!instance) {
      // 实例已被删除：停止隧道，不再重连
      entry.stopping = true
      disposeEntry(entry, { dropControlPath: false })
      emit(entry.id, 'stopped', { detail: '实例已删除' })
      return
    }
    // 端口转发失败（本地端口被占）→ 换一个本地端口再试
    if (entry.forwardFailed) {
      entry.forwardFailed = false
      try {
        // 经 allocChain 串行：check-then-add 原子，不与并发分配抢同一端口。
        const port = await reallocLocalPort(entry.localPort)
        if (entry.stopping) {
          reservedPorts.delete(port)
          return
        }
        entry.localPort = port
        entry.url = sshTunnelEndpoint(port)
        emit(entry.id, 'starting', { detail: `本地端口已重新分配为 ${port}` })
      } catch {
        // 无可用端口：按原端口再试一次（下次 forward 失败还会换）
      }
    }
    if (entry.stopping) return
    const child = spawnSsh(entry, instance)
    entry.child = child
    await waitForReady(entry, child)
  }

  function attachHandlers(child: SpawnedProcess, entry: TunnelEntry): void {
    const id = entry.id
    child.stdout?.on('data', (chunk: unknown) => pushLog(entry, chunk))
    child.stderr?.on('data', (chunk: unknown) => pushLog(entry, chunk))

    child.on('error', (error: Error) => {
      if (entries.get(id) !== entry || entry.child !== child) return
      if (entry.stopping) return
      entry.stopping = true
      emit(id, 'error', { detail: `SSH 进程启动失败：${error.message}` })
      disposeEntry(entry, { dropControlPath: false })
    })

    child.on('exit', (code) => {
      if (entries.get(id) !== entry || entry.child !== child) return
      entry.child = null
      cancelReconnect(entry)
      if (entry.stopping) return // stop() 独占发布 stopped
      drainLogBuffer(entry)
      const attribution = entry.pendingReason ?? classifySshExit(code, entry.log.join('\n'))
      entry.pendingReason = null
      entry.ready = false
      if (entry.stableSince !== null && now() - entry.stableSince >= stableResetMs) {
        entry.backoffMs = backoffBaseMs
      }
      entry.stableSince = null
      if (attribution.kind === 'forward') {
        // 端口冲突与远端状态无关：重连前换端口，且以基数立即重试
        entry.forwardFailed = true
        entry.backoffMs = backoffBaseMs
      }
      emit(id, 'error', {
        detail: `SSH 隧道断开（${attribution.message}）；${entry.backoffMs / 1000}s 后自动重连`
      })
      scheduleReconnect(entry)
    })
  }

  /**
   * 分配本地端口、确认服务器指纹、拉起 ssh 子进程并等到就绪。
   * 失败时释放本次分配的端口并发布 error；各取消点自行发布 stopped。
   */
  async function establishTunnel(
    id: string,
    instance: SshInstance,
    cancelIfRequested: () => boolean
  ): Promise<void> {
    let allocatedPort: number | null = null
    try {
      emit(id, 'starting', { detail: '分配本地端口' })
      const localPort = await allocLocalPort(instance)
      allocatedPort = localPort
      if (cancelIfRequested()) {
        reservedPorts.delete(localPort)
        emit(id, 'stopped', { detail: '已取消启动' })
        return
      }
      // known_hosts 落在 dataRoot/ssh（文件,无长度问题）;control socket 目录可能退化到共享临时目录
      await mkdir(join(dataRoot, 'ssh'), { recursive: true, mode: 0o700 })
      await ensureSocketsDir(dataRoot)
      if (cancelIfRequested()) {
        reservedPorts.delete(localPort)
        emit(id, 'stopped', { detail: '已取消启动' })
        return
      }
      const entry: TunnelEntry = {
        id,
        child: null,
        localPort,
        remoteLabel: `${instance.host}:${instance.remotePort}`,
        url: sshTunnelEndpoint(localPort),
        log: [],
        buffer: '',
        ready: false,
        stopping: false,
        reconnectScheduled: false,
        reconnectTimer: null,
        backoffMs: backoffBaseMs,
        stableSince: null,
        pendingReason: null,
        forwardFailed: false,
        reconnectCount: 0,
        reconnecting: false,
        askpassServer: null,
        askpassWrapperPath: null,
        // 短名 + 目标哈希:同一目标的多实例/多连接天然复用同一条主连接(ControlMaster=auto)
        controlPath: join(socketsDirFor(dataRoot), `ctl-${controlSlug(instance)}`)
      }
      emit(id, 'starting', { detail: '校验服务器指纹' })
      const trusted = await ensureTrust(instance, (detail) => emit(id, 'starting', { detail }))
      if (!trusted) {
        reservedPorts.delete(localPort)
        emit(id, 'error', { detail: '服务器指纹未确认（或已变化），已拒绝连接' })
        return
      }
      if (cancelIfRequested()) {
        reservedPorts.delete(localPort)
        emit(id, 'stopped', { detail: '已取消启动' })
        return
      }
      entry.askpassServer = await startAskpassFor(entry).catch((error: unknown) => {
        // 口令通道不可用时必须让用户看见:否则需要口令的主机会以「鉴权失败」静默失败
        console.error('[ssh-tunnel] askpass 通道启动失败：', error)
        emit(id, 'starting', { detail: '口令输入通道不可用，将尝试非交互认证（agent / 免密密钥）' })
        return null
      })
      entries.set(id, entry)
      emit(id, 'starting', {
        detail: `建立 SSH 隧道（${localPort} → ${entry.remoteLabel}）`
      })
      // spawn 前清除可能残留的 ControlPath（重启场景）
      await rm(entry.controlPath, { force: true }).catch(() => undefined)
      // stop()/stopAll()/实例删除可能正好落在上面这个 await 窗口内:条目已被 stop 从
      // entries 摘除并标记 stopping,spawn 却还没发生。此时若照常 spawn,这个 ssh 子进程
      // 就成了 stop() 再也找不到的孤儿（一直占着转发端口），而 UI 早已显示「隧道已停止」。
      // 与 reconnectInner 同款守卫；放弃时必须把本次已获取的资源按 stop() 的做法全部回滚。
      const cancelPending = cancelIfRequested()
      if (entry.stopping || cancelPending) {
        disposeEntry(entry, { dropControlPath: true })
        emit(id, 'stopped', { detail: '已取消启动' })
        return
      }
      const child = spawnSsh(entry, instance)
      entry.child = child
      await waitForReady(entry, child)
    } catch (error) {
      if (allocatedPort !== null) reservedPorts.delete(allocatedPort)
      emit(id, 'error', {
        detail: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return {
    onStatus,
    statusOf,

    runningIds() {
      return [...entries.keys()]
    },

    async start(instance) {
      const id = instance.id
      /** 清掉本实例挂起的取消标记，并返回它原先是否被挂起。 */
      const cancelIfRequested = (): boolean => cancelRequested.delete(id)
      if (entries.has(id) || startingIds.has(id)) {
        const existing = entries.get(id)
        if (existing) {
          if (
            !existing.ready &&
            !existing.stopping &&
            existing.child === null &&
            !existing.reconnectScheduled &&
            !existing.reconnecting
          ) {
            // 自愈:看门狗链路断了(无子进程、无待重连)时,用户点「启动」应能恢复
            existing.backoffMs = backoffBaseMs
            emit(id, 'starting', { detail: '检测到隧道已中断，重新建立连接' })
            scheduleReconnect(existing)
            return
          }
          emit(id, existing.ready ? 'running' : 'starting', {
            ...(existing.url ? { url: existing.url } : {}),
            ...(existing.ready ? { port: existing.localPort } : {}),
            detail: '隧道已在运行，忽略重复启动'
          })
          return
        }
        emit(id, 'starting', { detail: '隧道正在启动，忽略重复启动' })
        return
      }
      startingIds.add(id)
      cancelIfRequested()
      latestInstances.set(id, instance)
      try {
        await establishTunnel(id, instance, cancelIfRequested)
      } finally {
        startingIds.delete(id)
      }
    },

    async stop(id) {
      cancelRequested.add(id)
      latestInstances.delete(id)
      const entry = entries.get(id)
      if (!entry) {
        emit(id, 'stopped', { detail: '实例未在运行' })
        return
      }
      entry.stopping = true
      cancelReconnect(entry)
      const child = entry.child
      if (child) {
        killProcessGroup(child, 'SIGTERM')
        const exited = await waitForProcessExit(child, stopGraceMs)
        if (!exited) {
          killProcessGroup(child, 'SIGKILL')
          await waitForProcessExit(child, 1_000)
        }
      }
      disposeEntry(entry, { dropControlPath: true })
      emit(id, 'stopped', { detail: '隧道已停止' })
    },

    async stopAll() {
      // 已进入启动流程但尚未建立 entry 的实例同样必须取消，避免退出后 spawn detached ssh。
      const ids = new Set([...entries.keys(), ...startingIds])
      await Promise.all([...ids].map((id) => this.stop(id)))
    },

    /**
     * 复用 recordHostTrust 的 `replace` 语义(先删该目标的旧行);keys 传空数组 = 只删不写,
     * 于是下一次连接读不到已信任公钥 → 重新走一遍首次 TOFU 确认。
     * 主进程侧唯一的调用方是显式的「忘记该主机指纹」动作,连接流程绝不调用它。
     */
    async forgetHostKey(instance) {
      const target = await resolveTargetOrFallback(instance)
      await recordHostTrust(
        join(dataRoot, 'ssh', 'known_hosts'),
        knownHostsHostField(target.host, target.port),
        [],
        'replace'
      )
    }
  }
}
