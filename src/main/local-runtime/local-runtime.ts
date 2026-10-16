/**
 * 本机实例运行时管理：启动排队与取消、停止与外部接管、dsh 版本升级、状态发布。
 * 启动来源解析与 spawn 管线在 launch.ts；本模块保留就绪监视续体与进程回收。
 * 不 import Electron，状态只经 `onStatus` 向外发布，因此可脱离 Electron 单独测试。
 */
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type {
  DshVersionProgressEvent,
  EnvironmentDiff,
  InstanceStatusEvent,
  LocalInstance
} from '@shared/contracts'
import { redactLine } from '@shared/redact'
import { isLoopbackHost } from '@shared/endpoint'
import type { PortProbe } from './port-allocator'
import type { InstallProgress } from './runtime-installer'
import { InstanceStoreError, type InstanceStore } from '../registry/instance-store'
import { isExternalRuntime, resolveSystemDshUsage } from './dsh-source-policy'
import { searchNodeDirs } from './node-dirs'
import { resolveLoginPathOnce } from './login-path'
import { resolveShellEnvOnce } from './shell-env'
import { diffEnvironment } from './env-diff'
import { httpHealthProbe, retryProbe, type HealthProbe } from '../transport/probe'
import { createStatusBus } from '../transport/status-bus'
import { nodeModeExecutable } from '../node-mode'
import {
  detachedSpawn,
  killProcessGroup,
  waitForProcessExit,
  type SpawnLike
} from '../transport/spawn'
import type { Entry } from './entry'
import { createLauncher, type LaunchOptions } from './launch'

/** dsh 就绪输出：`dsh web: http://127.0.0.1:52300/?token=...` */
const READY_PATTERN = /dsh\s+web:\s+(https?:\/\/\S+)/i

/** 诊断用的日志环形缓冲行数 */
const LOG_BUFFER_LINES = 80

/** 未以换行结尾的残片上限:异常的超长单行只保留尾部,防止无界增长 */
const LOG_BUFFER_MAX = 64 * 1024

export interface LocalRuntimeOptions extends LaunchOptions {
  /** 实例注册表；升级编排完成后回写 dshVersion。 */
  store: Pick<InstanceStore, 'update'>
  /** 缺省用 Electron 自带 Node（ELECTRON_RUN_AS_NODE）执行 dsh 入口 */
  nodeInvocation?: { command: string; args: string[]; env: NodeJS.ProcessEnv }
  spawnImpl?: SpawnLike
  probe?: HealthProbe
  /** 端口可绑定探测（注入以便测试端口分配时序；缺省用真实 bind 探测） */
  portProbe?: PortProbe
  profile?: string
  /** 用户主目录来源；仅用来生成固定 ~/.dsh，不接受 renderer 指定路径。 */
  homeDir?: () => string
  readyTimeoutMs?: number
  stopGraceMs?: number
  /** stopAll 等待启动队列排空的上限；超时放弃等待，退出不被卡死的安装拖住。 */
  stopAllDrainMs?: number
  healthTimeoutMs?: number
  healthProbeRetries?: number
  healthProbeRetryMs?: number
  now?: () => number
  /**
   * 为本机（`path` 来源）启动器解析一个真实 node 可执行文件；缺省按「同目录 → PATH」探测。
   * 注入以便测试固定该解析结果（默认实现要读真实文件系统）。
   */
  resolveNode?: (scriptPath: string) => string | null
  /**
   * 登录环境 PATH 解析（登录 shell / Windows 注册表）；null=不可用时回退继承 PATH。
   * 缺省用进程内缓存的真实解析；注入以便测试。可选 `.invalidate()` 供 refreshEnv 清缓存，
   * 可选 `.peek()` 读缓存作刷新前基线（不触发解析）。
   */
  loginPath?: (() => Promise<string | null>) & {
    invalidate?: () => void
    peek?: () => Promise<string | null> | undefined
  }
  /**
   * 当前用户登录 shell 的完整环境解析（含 .zshrc/.bashrc 的 export）；null=不可用。
   * 缺省用进程内缓存的真实解析；注入以便测试。可选 `.invalidate()` / `.peek()`，同上。
   */
  shellEnv?: (() => Promise<Map<string, string> | null>) & {
    invalidate?: () => void
    peek?: () => Promise<Map<string, string> | null> | undefined
  }
  /**
   * 是否把登录 shell 完整环境合并进本机实例；false 时仅合并 PATH（回退旧行为）。
   * 缺省 true；由设置项 inheritShellEnv 决定，读取函数注入以便运行中改设置即时生效。
   */
  inheritShellEnv?: () => boolean
  /**
   * 公共空间实例升级系统默认 dsh 前的二次确认：该升级全局生效。
   * 返回 false = 用户拒绝，本次升级不产生任何进度、不改任何状态。缺省视为拒绝。
   */
  confirmSystemUpgrade?: (latest: string, current: string) => Promise<boolean>
  /**
   * 每次启动、确定目标 dsh 版本后、真正 spawn 前调用（不阻断启动流程的失败由实现方自行收敛）。
   * 用于「dsh 版本变更后首次启动核对插件兼容性」这类与运行时版本绑定的准备工作。
   */
  beforeSpawn?: (instance: LocalInstance, version: string) => Promise<void>
}

export interface LocalRuntimeManager {
  onStatus(listener: (event: InstanceStatusEvent) => void): () => void
  /** 订阅 dsh 版本升级进度；返回取消订阅函数。 */
  onUpgradeProgress(listener: (event: DshVersionProgressEvent) => void): () => void
  /**
   * 升级到 registry 最新可用版本（按版本比较取最大，含 rc/alpha 等预发布渠道 —— dsh 以
   * 预发布渠道持续发布，dist-tags.latest 常滞后）：解析版本 →（运行中先停）→ 安装 →
   * 回写注册表 →（升级前在运行则重启）。
   * 公共空间且运行系统默认 dsh 的实例例外：先二次确认，确认后原位升级系统默认 dsh。
   * 调用立即返回并后台执行，进展经 onUpgradeProgress 回推；
   * 失败以 phase='error' 结束：隔离目录保留旧版，升级前在运行的实例停在停止态。
   */
  upgradeInstance(instance: LocalInstance): Promise<void>
  /** 面向主进程的私有工作区 URL；本地 BrowserAuth token 不得出现在状态事件中。 */
  urlOf(id: string): string | null
  statusOf(id: string): InstanceStatusEvent | null
  runningIds(): string[]
  start(instance: LocalInstance): Promise<void>
  stop(id: string): Promise<void>
  stopAll(): Promise<void>
  /**
   * 失效并重新解析登录环境缓存（PATH / shell 环境），使下一次启动的实例解析到最新环境。
   * 用于用户装了新工具（如 git）后无需重启 app：清缓存并预热，之后 (重)启实例即生效。
   * 已在运行的实例进程环境不可变，须由调用方重启后才会用上新环境。
   * 返回刷新前后的差异（只含 PATH 条目与变量名），供调用方报告「多了什么」。
   */
  refreshEnv(): Promise<EnvironmentDiff>
  /**
   * 接管后 statusOf 返回 running + 外部 URL,「打开视图」直接可用;
   * stop() 只断开接管,**绝不终止**用户自己的进程。
   */
  adopt(instance: LocalInstance, external: AdoptTarget): Promise<void>
}

/** 接管目标(来自 external-dsh 的只读探测;端口必须已确定) */
export interface AdoptTarget {
  pid: number
  port: number
  /** `--patch <file>` 取值(dush 形态);仅用于展示 */
  patch: string | null
  /** 已验证的完整访问 URL；外部 dsh 开启 browser-auth 时包含用户提供的 token。 */
  url?: string
}

function defaultNodeInvocation(): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  // macOS 用 Helper 二进制并带 ELECTRON_RUN_AS_NODE 退化为纯 Node 执行 dsh（避免 Dock 图标闪现；见 node-mode）。
  // `--expose-internals` 是 dsh web profile 的硬性要求（cordis-plugin-hmr 需要），缺失时就绪后即崩

  return { command: nodeModeExecutable(), args: ['--expose-internals'], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/**
 * 解析一个真实 node 可执行文件，供 hub 与本机启动器来源执行 dsh/dush/duush。
 *
 * dsh 的原生插件按运行时指纹校验：不在白名单的 Electron 版本启动即以 code=1 退出，
 * 因此**能用真实 node 时一律用真实 node**。查找顺序：脚本同目录（npm/pnpm 全局常放在一起）
 * → 常见安装落点（nvm/homebrew/pnpm 等；GUI 启动时进程 PATH 往往缺 node 目录）→ PATH。
 */
function resolveNodeFor(scriptPath: string, home: string): string | null {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const sameDir = join(dirname(scriptPath), nodeName)
  if (existsSync(sameDir)) return sameDir
  const listDir = (dir: string): string[] => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  }
  const dirs = [
    ...searchNodeDirs(home, listDir),
    ...(process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '')
  ]
  for (const dir of [...new Set(dirs)]) {
    const candidate = join(dir, nodeName)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function createLocalRuntime(options: LocalRuntimeOptions): LocalRuntimeManager {
  const spawnImpl = options.spawnImpl ?? detachedSpawn
  const probe = options.probe ?? httpHealthProbe
  const nodeInvocation = options.nodeInvocation ?? defaultNodeInvocation()
  const profile = options.profile ?? 'web'
  const homeDir = options.homeDir ?? homedir
  const resolveNode = options.resolveNode ?? ((scriptPath: string) => resolveNodeFor(scriptPath, homeDir()))
  const loginPath = options.loginPath ?? resolveLoginPathOnce
  const shellEnv = options.shellEnv ?? resolveShellEnvOnce
  const inheritShellEnv = options.inheritShellEnv ?? ((): boolean => true)
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000
  const stopGraceMs = options.stopGraceMs ?? 3_000
  const stopAllDrainMs = options.stopAllDrainMs ?? 10_000
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  // 就绪探测重试次数默认 5 次，与 HTTP 端点一致；见 probe.ts 的 retryProbe。
  const healthProbeRetries = options.healthProbeRetries ?? 5
  const healthProbeRetryMs = options.healthProbeRetryMs ?? 500
  const portProbe = options.portProbe
  const now = options.now ?? (() => Date.now())

  const entries = new Map<string, Entry>()
  const upgradeListeners = new Set<(event: DshVersionProgressEvent) => void>()
  /** 正在升级的实例；升级结束（含失败）即释放。 */
  const upgradingIds = new Set<string>()
  /** 启动阶段串行队列：同一时刻只让一个实例走完「安装 → 分配端口 → spawn → 就绪」 */
  let startChain: Promise<unknown> = Promise.resolve()
  /**
   * Generation-based cancellation: each start() call captures a generation number;
   * stop() records the current generation as the cancellation point.
   * A queued task is cancelled only if cancelGeneration >= its own generation,
   * so a new start after stop correctly proceeds while old queued starts stay cancelled.
   */
  const cancelGeneration = new Map<string, number>()
  const instanceGeneration = new Map<string, number>()
  /** 已进入启动流程的任务计数；退出时必须连同已排队任务一并取消。 */
  const pendingStartCounts = new Map<string, number>()

  function decrementPendingStart(id: string): void {
    const next = (pendingStartCounts.get(id) ?? 1) - 1
    if (next <= 0) pendingStartCounts.delete(id)
    else pendingStartCounts.set(id, next)
  }

  function enqueueStart<T>(task: () => Promise<T>): Promise<T> {
    const next = startChain.then(task, task)
    startChain = next.catch(() => undefined)
    return next
  }

  const bus = createStatusBus(now, 'local-runtime')
  const { emit, onStatus, statusOf } = bus

  function emitUpgrade(event: DshVersionProgressEvent): void {
    for (const listener of upgradeListeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[local-runtime] 升级进度监听器抛错：', error)
      }
    }
  }

  function pushLog(entry: Entry, chunk: unknown): string[] {
    entry.buffer += String(chunk)
    // 无换行残片上限(超长单行异常输出),只保留尾部防无界增长
    if (entry.buffer.length > LOG_BUFFER_MAX) entry.buffer = entry.buffer.slice(-LOG_BUFFER_MAX)
    const lines: string[] = []
    let newlineIndex: number
    while ((newlineIndex = entry.buffer.indexOf('\n')) !== -1) {
      const line = entry.buffer.slice(0, newlineIndex).replace(/\r$/, '')
      entry.buffer = entry.buffer.slice(newlineIndex + 1)
      if (line.trim() !== '') lines.push(line)
    }
    if (lines.length > 0) {
      entry.log.push(...lines)
      if (entry.log.length > LOG_BUFFER_LINES) entry.log.splice(0, entry.log.length - LOG_BUFFER_LINES)
    }
    return lines
  }

  function killTree(entry: Entry, signal: NodeJS.Signals): void {
    // 外部接管的条目没有子进程(hub 没 spawn 过):绝不对它做任何 kill
    if (entry.child) killProcessGroup(entry.child, signal)
  }

  async function waitForExit(entry: Entry, timeoutMs: number): Promise<boolean> {
    // 外部接管条目没有子进程:没什么可等的,视作「已退出」
    if (!entry.child) return true
    return waitForProcessExit(entry.child, timeoutMs)
  }

  async function handleReady(id: string, entry: Entry, url: string): Promise<void> {
    const failReady = (error: unknown): void => {
      if (entry.stopping || entries.get(id) !== entry) return
      emit(id, 'error', {
        detail: error instanceof Error ? `解析就绪地址失败：${error.message}` : '解析就绪地址失败'
      })
      entry.stopping = true
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      killTree(entry, 'SIGKILL')
      entries.delete(id)
      entry.settleSpawn?.()
    }
    try {
      // dsh 打印的就绪 URL 直接喂给内嵌工作区视图：host 必须钉在回环，否则被篡改的
      // stdout 行（`dsh web: http://attacker/…`）会让 hub 在工作区加载远端 origin。
      let readyUrl: URL
      try {
        readyUrl = new URL(url)
      } catch {
        failReady(new Error('就绪 URL 无法解析'))
        return
      }
      if (!isLoopbackHost(readyUrl.hostname)) {
        failReady(new Error(`就绪 URL 主机非回环地址（${readyUrl.hostname}），已拒绝`))
        return
      }
      // 在途续体身份守卫:探测/重试期间本条目的进程可能已退出(退出处理器会删条目并立即
      // 放行队列,同 id 的第二次 start 随即拉起新进程)。陈旧续体不得再发布 running、
      // 也不得在失败终局里 `entries.delete(id)` 误删新条目 —— 否则活进程沦为无主,
      // 下次 start 又 spawn 一个,两个 dsh 共享同一 DSH_HOME。
      const stale = (): boolean => entry.stopping || entries.get(id) !== entry
      const healthy = await retryProbe({
        url,
        probe,
        retries: healthProbeRetries,
        retryMs: healthProbeRetryMs,
        timeoutMs: healthTimeoutMs,
        shouldAbort: stale
      })
      if (healthy === null) return
      if (!healthy) {
        // 终局路径必须与超时路径对齐:杀进程、清条目、放行队列。
        // 缺失任一项都会造成 head-of-line 阻塞(下一个实例等到 readyTimer 触发)
        // 与无人回收的存活进程。
        emit(id, 'error', {
          detail: redactLine(`就绪 URL 无法访问（健康探测 ${healthProbeRetries} 次失败）：${url}`)
        })
        entry.stopping = true
        if (entry.timer) {
          clearTimeout(entry.timer)
          entry.timer = null
        }
        killTree(entry, 'SIGKILL')
        entries.delete(id)
        entry.settleSpawn?.()
        return
      }
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      entry.ready = true
      entry.url = url
      const port = Number(readyUrl.port)
      entry.port = Number.isInteger(port) && port > 0 ? port : null
      if (stale()) return
      emit(id, 'running', {
        version: entry.version,
        runtimeSource: entry.runtimeSource,
        ...(entry.port !== null ? { port: entry.port } : {}),
        ...(entry.command !== undefined ? { command: entry.command } : {}),
        detail: `已在 ${entry.home} 启动（dsh web）`
      })
      entry.settleSpawn?.() // 排他地放行下一个实例的启动
    } catch (error) {
      failReady(error)
    }
  }

  function watchStdout(id: string, entry: Entry): void {
    const onChunk = (target: 'stdout' | 'stderr') => (chunk: unknown) => {
      const lines = pushLog(entry, chunk)
      if (target === 'stderr') return
      for (const line of lines) {
        const match = READY_PATTERN.exec(line)
        if (match?.[1] && !entry.ready && !entry.stopping) {
          void handleReady(id, entry, match[1])
          return
        }
      }
    }
    const child = entry.child
    // 只有 hub spawn 出来的条目才有 stdout/stderr 可监听(外部接管条目没有)
    if (!child) return
    child.stdout?.on('data', onChunk('stdout'))
    child.stderr?.on('data', onChunk('stderr'))
  }

  // 启动来源解析与 spawn 管线在 launch.ts；此处注入状态发布、共享状态、解析后的启动配置
  // 与管理器侧的就绪监视续体（watchStdout）和进程回收（killTree）。
  const beforeSpawn = options.beforeSpawn
  const { resolveLaunch, spawnAndWatch } = createLauncher({
    emit,
    entries,
    cancelGeneration,
    options: {
      installer: options.installer,
      pathProbe: options.pathProbe,
      confirmDownload: options.confirmDownload,
      dataRoot: options.dataRoot,
      pnpmBinDir: options.pnpmBinDir
    },
    portProbe,
    homeDir,
    profile,
    resolveNode,
    nodeInvocation,
    spawnImpl,
    inheritShellEnv,
    shellEnv,
    loginPath,
    readyTimeoutMs,
    watchStdout,
    killTree
  })

  return {
    onStatus,
    onUpgradeProgress(listener) {
      upgradeListeners.add(listener)
      return () => upgradeListeners.delete(listener)
    },

    async upgradeInstance(instance) {
      const id = instance.id
      // 单飞守卫：同一实例的升级进行中重复触发直接忽略，避免并发写同一隔离目录。
      if (upgradingIds.has(id)) return
      upgradingIds.add(id)
      const at = (): string => new Date(now()).toISOString()
      /**
       * 升级主序列：运行中先停 → 下载安装 → 回写版本 → 原样重启，末尾 done=100。
       * 两条升级路径共用；`checking` 由各分支自行发出 —— 系统升级要等二次确认之后
       * 才有进度，隔离升级则要在解析版本之前就给出反馈。
       */
      const runUpgrade = async (
        version: string,
        install: (onProgress: (progress: InstallProgress) => void) => Promise<unknown>
      ): Promise<void> => {
        const wasRunning = this.statusOf(id)?.status === 'running'
        if (wasRunning) await this.stop(id)
        emitUpgrade({ instanceId: id, phase: 'downloading', version, at: at() })
        await install((progress) => {
          emitUpgrade({
            instanceId: id,
            phase: 'installing',
            version,
            detail: progress.detail,
            at: at()
          })
        })
        await options.store.update(id, { dshVersion: version })
        if (wasRunning) await this.start({ ...instance, dshVersion: version })
        emitUpgrade({ instanceId: id, phase: 'done', version, at: at() })
      }
      try {
        // 升级对象经 dsh-source-policy 判定，与版本检查、启动路径共用同一判据：
        // 结论为「系统默认 dsh」时升级全局 npm 安装，所有共用该 dsh 的实例与终端
        // 都会跟随，因此必须先二次确认。拒绝时直接返回，不产生任何进度事件、不改任何
        // 状态；探测与安装布局判定在确认之前完成，注定失败的升级不先打扰用户。
        // 其余情况（隔离空间，或公共空间实际跑 hub 副本）都升级 hub 自己的运行时。
        const runtimeSource = this.statusOf(id)?.runtimeSource
        if (isExternalRuntime(runtimeSource)) {
          throw new InstanceStoreError('invalid-state', '外部接管的 dsh 进程归用户所有，hub 不能代管升级')
        }
        const decision = await resolveSystemDshUsage({
          transport: instance.transport,
          useDefaultSpace: instance.useDefaultSpace,
          launcher: instance.launcher,
          runtimeSource,
          desiredVersion: instance.dshVersion,
          listInstalledVersions: async () => {
            try {
              return (await options.installer.listInstalled()).map((item) => item.version)
            } catch {
              return [] as string[]
            }
          },
          probePath: async () => (await options.pathProbe?.probe().catch(() => null)) ?? null
        })
        if (decision.usesSystemDsh) {
          const newest = await options.installer.resolveLatestVersion()
          const system = decision.pathRuntime
          if (system === null) {
            throw new Error('未找到系统默认 dsh（PATH 上没有可用的 dsh），无法升级')
          }
          const prefix = await options.installer.resolveGlobalPrefix(system.command)
          if (prefix === null) {
            throw new Error(`系统 dsh 不是 npm 全局安装（${system.command}），hub 无法代管升级`)
          }
          const confirmed = await options.confirmSystemUpgrade?.(newest, system.version)
          if (confirmed !== true) return
          emitUpgrade({ instanceId: id, phase: 'checking', at: at() })
          await runUpgrade(newest, (onProgress) => options.installer.installGlobal(prefix, newest, onProgress))
          return
        }
        emitUpgrade({ instanceId: id, phase: 'checking', at: at() })
        const latest = await options.installer.resolveLatestVersion()
        await runUpgrade(latest, (onProgress) => options.installer.ensureInstalled(latest, onProgress))
      } catch (error) {
        emitUpgrade({
          instanceId: id,
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
          at: at()
        })
      } finally {
        upgradingIds.delete(id)
      }
    },

    statusOf,

    urlOf(id) {
      return entries.get(id)?.url ?? null
    },

    runningIds() {
      return [...entries.keys()]
    },

    async refreshEnv() {
      // 单侧解析失败按不可用（null）处理：diffEnvironment 据此标记该侧不可比。
      const settle = <T>(task: Promise<T>): Promise<T | null> => task.catch(() => null)
      // 基线：优先读缓存里上一次的解析结果（peek 不触发解析）；冷缓存先解析一次建立基线。
      const [beforePath, beforeEnv] = await Promise.all([
        settle(loginPath.peek?.() ?? loginPath()),
        settle(shellEnv.peek?.() ?? shellEnv())
      ])
      // 清掉进程内缓存的登录环境解析；下次启动的实例会重新解析到最新 PATH / shell 环境。
      loginPath.invalidate?.()
      shellEnv.invalidate?.()
      // 预热：重解析的结果既是与基线对比的新值，也让随后（手动或被重启触发）的启动不必等解析。
      const [afterPath, afterEnv] = await Promise.all([settle(loginPath()), settle(shellEnv())])
      return diffEnvironment(
        { path: beforePath, env: beforeEnv },
        { path: afterPath, env: afterEnv }
      )
    },

    async start(instance) {
      const id = instance.id
      const existing = entries.get(id)
      if (existing && !existing.stopping) {
        // 重复 start 只重播一次当前状态,不重复 spawn
        emit(id, existing.ready ? 'running' : 'starting', {
          version: existing.version,
          runtimeSource: existing.runtimeSource,
          ...(existing.port !== null ? { port: existing.port } : {}),
          ...(existing.command !== undefined ? { command: existing.command } : {}),
          detail: '实例已在运行，忽略重复启动'
        })
        return
      }

      // 新的启动请求：递增 generation（不删除旧 cancel，旧 queued task 检查自己的 generation）
      const gen = (instanceGeneration.get(id) ?? 0) + 1
      instanceGeneration.set(id, gen)
      pendingStartCounts.set(id, (pendingStartCounts.get(id) ?? 0) + 1)
      try {
        const launch = await resolveLaunch(id, gen, instance)
        if (launch === null) return
        // 目标版本已定、尚未 spawn：与运行时版本绑定的准备（如插件兼容性核对）在此进行；
        // 失败只记日志，绝不阻断启动——插件问题不该让实例起不来。
        if (beforeSpawn !== undefined) {
          try {
            await beforeSpawn(instance, launch.version)
          } catch (error) {
            console.error('[runtime] 启动前准备失败（已忽略，不影响启动）：', error)
          }
        }
        // 启动阶段串行(含安装):避免多实例并发首启时互相干扰(同版本重复安装/并发冷启动)。
        // 关键:串行段要等到「就绪或退出」才结束 —— 端口探测与 dsh 实际绑定之间存在竞态窗口,
        // 若只等 spawn 就放行,两个实例会抢同一端口,后启动的那个会崩溃。
        const outcome = await enqueueStart(() => spawnAndWatch(id, gen, instance, launch))
        if (outcome === 'cancelled') {
          emit(id, 'stopped', { detail: '已取消启动' })
          return
        }
      } catch (error) {
        emit(id, 'error', {
          detail: error instanceof Error ? error.message : String(error)
        })
      } finally {
        decrementPendingStart(id)
      }
    },

    async stop(id) {
      const entry = entries.get(id)
      // 无论有无条目都登记取消意图:排队中尚未 spawn 的重复 start 也会被一并取消,
      // 否则「start→start→stop」序列下,后一个排队任务会在停止后把实例重新拉起
      // Generation-based:记录当前 generation 作为取消点
      cancelGeneration.set(id, instanceGeneration.get(id) ?? 0)
      if (!entry) {
        emit(id, 'stopped', { detail: '实例未在运行' })
        return
      }
      // 外部接管(hub 没 spawn 过):只断开接管 —— 用户自己的 dsh web 进程必须留着,
      // 我们无权替用户结束它(误杀会连带终止他手工挂着的 patch 实例)。
      if (entry.runtimeSource === 'external') {
        entries.delete(id)
        emit(id, 'stopped', {
          detail: `已断开接管（外部 dsh web 进程 pid ${entry.externalPid ?? '?'} 未终止）`
        })
        return
      }
      entry.stopping = true
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      killTree(entry, 'SIGTERM')
      const exited = await waitForExit(entry, stopGraceMs)
      if (!exited) {
        killTree(entry, 'SIGKILL')
        await waitForExit(entry, 1_000)
      }
      // 身份守卫:stop 期间可能有新 start 替换了条目,只删除自己持有的旧条目
      if (entries.get(id) === entry) entries.delete(id)
      // 必须显式放行启动队列:正常停止由 exit handler 的 settle 兜住,但子进程若处于
      // SIGKILL 也无效的 D 态/僵尸,exit 事件永不触发 → 停在 spawnSettledPromise 的
      // 队列任务永不返回,之后所有实例的 start 全部永久排队(settled 标志保证此处重复无害)
      entry.settleSpawn?.()
      emit(id, 'stopped', { detail: exited ? '已停止' : '已强制停止（SIGKILL）' })
    },

    async adopt(instance, external) {
      const id = instance.id
      const existing = entries.get(id)
      if (existing) {
        // 已在运行(hub 自己拉起的或已接管的):不覆盖,只重播状态
        emit(id, existing.ready ? 'running' : 'starting', {
          version: existing.version,
          runtimeSource: existing.runtimeSource,
          ...(existing.port !== null ? { port: existing.port } : {}),
          detail: '实例已在运行，忽略重复接管'
        })
        return
      }
      const url = external.url ?? `http://127.0.0.1:${external.port}`
      entries.set(id, {
        child: null,
        url,
        port: external.port,
        // 外部进程的版本我们不去猜(hub 未安装、也不该回写):显式留空字符串,
        // 状态事件里由调用方决定是否展示
        version: '',
        runtimeSource: 'external',
        home: '',
        log: [],
        buffer: '',
        ready: true,
        stopping: false,
        timer: null,
        externalPid: external.pid
      })
      emit(id, 'running', {
        port: external.port,
        runtimeSource: 'external',
        detail: `已接管本机运行的 dsh web（pid ${external.pid}${external.patch ? `，patch ${external.patch}` : ''}）`
      })
    },

    async stopAll() {
      // entries 以外，安装/端口分配/全局队列中的启动任务也必须作废，防止退出后再 spawn。
      const ids = new Set([...entries.keys(), ...pendingStartCounts.keys()])
      await Promise.all([...ids].map((id) => this.stop(id)))
      // 队列可能卡在安装等待上：退出路径有界等待；取消代已保证放弃等待后不会迟到 spawn。
      await Promise.race([
        startChain,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, stopAllDrainMs)
          timer.unref?.()
        })
      ])
    }
  }
}