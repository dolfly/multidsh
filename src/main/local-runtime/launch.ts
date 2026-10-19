/**
 * 本机实例启动管线：解析运行时来源与执行入口 → 安装 → 分配端口 → spawn → 交监视回调盯到就绪。
 * 状态发布、条目表、安装探测、环境解析与进程监视/回收经 createLauncher 显式注入；不 import Electron。
 */
import { mkdir } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { LocalInstance } from '@shared/contracts'
import { redactLine } from '@shared/redact'
import { DEFAULT_PORT_RANGE_END, findFreePort } from './port-allocator'
import type { PortProbe } from './port-allocator'
import type { RuntimeInstaller } from './runtime-installer'
import { followsSystemDsh } from './dsh-source-policy'
import { resolveCmdShim } from './cmd-shim'
import { planRuntimeSource, type PathProbe } from './runtime-source'
import { mergeLoginPath } from './login-path'
import { mergeShellEnv } from './shell-env'
import { withBundledPnpmPath } from '../shell/bundled-pnpm'
import type { StatusBus } from '../transport/status-bus'
import type { SpawnInvocation, SpawnLike } from '../transport/spawn'
import type { Entry } from './entry'

/**
 * 本机 dsh web 的默认端口。与 dsh 自身默认端口一致：用户对 3080 有既有预期，
 * 工作区地址 `127.0.0.1:3080` 可直接访问；被占用时仍向上递增。
 *
 * 刻意不复用 `DEFAULT_PORT_RANGE_START`（30000）：该常量与 SSH 隧道共用，改它会连带改变隧道端口。
 */
export const DEFAULT_LOCAL_PORT = 3080

/** 串行启动任务的结果：spawned=正常拉起；cancelled=排队期间被取消；duplicate=已被前一个任务拉起 */
export type StartOutcome = 'spawned' | 'cancelled' | 'duplicate'

/** 启动来源解析结果：执行入口、显示用版本、来源标记与注入 wrapper 的 dsh。 */
export interface LaunchPlan {
  version: string
  runtimeSource: 'hub' | 'path'
  scriptPath: string
  /** 注入给 dush/duush 的 dsh 可执行文件；null = 不注入，由 wrapper 按 PATH 解析。 */
  dshBin: string | null
  /** 非默认启动器名（dush/duush 等）；null = 默认 dsh 启动器。 */
  customLauncherName: string | null
}

/**
 * 启动命令展示串:命令与参数原样拼接,含空白或引号的片段加双引号,
 * 供状态事件与详情页展示、复制到终端复现。
 */
function formatCommandLine(invocation: Pick<SpawnInvocation, 'command' | 'args'>): string {
  return [invocation.command, ...invocation.args]
    .map((part) => (part !== '' && !/[\s"]/.test(part) ? part : `"${part.replace(/"/g, '\\"')}"`))
    .join(' ')
}

/**
 * 解析子进程的基础环境（不含 node 目录前置与 DSH_HOME，那两步由调用方叠加）。
 *
 * 默认合并当前用户登录 shell 的完整环境（含 .zshrc/.bashrc 的 export，受保护键除外）；
 * 关闭开关、非 zsh/bash 或解析失败/超时时，回退到仅合并登录 PATH。与用户终端解析结果一致。
 */
async function resolveBaseEnv(deps: {
  inherit: boolean
  shellEnv: () => Promise<Map<string, string> | null>
  loginPath: () => Promise<string | null>
}): Promise<NodeJS.ProcessEnv> {
  const shellEnvMap = deps.inherit ? await deps.shellEnv().catch(() => null) : null
  if (shellEnvMap !== null) {
    return mergeShellEnv(process.env, shellEnvMap, process.platform)
  }
  const loginEnvPath = await deps.loginPath().catch(() => null)
  return {
    ...process.env,
    PATH: mergeLoginPath(process.env.PATH ?? '', loginEnvPath, process.platform)
  }
}

function logTail(entry: Entry, lines = 6): string {
  return entry.log.slice(-lines).join(' / ').split(' / ').map(redactLine).join(' / ')
}

/** 启动管线消费的运行时配置子集；`LocalRuntimeOptions` extends 它以保证键一致。 */
export interface LaunchOptions {
  installer: RuntimeInstaller
  dataRoot: string
  /** 探测用户本机 PATH 上的 dsh；缺省不探测，来源决策退化为「hub → 下载」两级。 */
  pathProbe?: PathProbe
  /** 下载 dsh 前的用户确认口，返回 true 才继续下载；缺省视为拒绝。 */
  confirmDownload?: (version: string) => Promise<boolean>
  /** 随包分发 pnpm 启动器所在目录；提供时前置到 dsh 子进程 PATH，令 dsh 用自带 pnpm。 */
  pnpmBinDir?: string
}

/** createLauncher 的依赖：状态发布、共享状态、解析后的启动配置，以及管理器侧的进程监视/回收。 */
export interface LauncherDeps {
  emit: StatusBus['emit']
  /** 运行中条目表；与管理器共享同一引用。 */
  entries: Map<string, Entry>
  /** 取消代：取消点 >= 本任务 generation 时放弃启动。 */
  cancelGeneration: Map<string, number>
  /** 运行时配置里启动段消费的子集。 */
  options: LaunchOptions
  portProbe?: PortProbe
  homeDir: () => string
  profile: string
  resolveNode: (scriptPath: string) => string | null
  nodeInvocation: { command: string; args: string[]; env: NodeJS.ProcessEnv }
  spawnImpl: SpawnLike
  inheritShellEnv: () => boolean
  shellEnv: () => Promise<Map<string, string> | null>
  loginPath: () => Promise<string | null>
  readyTimeoutMs: number
  /** 接管子进程 stdout/stderr、匹配就绪行；由管理器实现（持有 handleReady 续体）。 */
  watchStdout: (id: string, entry: Entry) => void
  /** 杀子进程组（外部接管条目为空操作）；停止路径与启动失败路径共用同一实现。 */
  killTree: (entry: Entry, signal: NodeJS.Signals) => void
}

export interface Launcher {
  resolveLaunch(id: string, gen: number, instance: LocalInstance): Promise<LaunchPlan | null>
  spawnAndWatch(
    id: string,
    gen: number,
    instance: LocalInstance,
    launch: LaunchPlan
  ): Promise<StartOutcome>
}

export function createLauncher(deps: LauncherDeps): Launcher {
  const {
    emit,
    entries,
    cancelGeneration,
    options,
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
  } = deps

  /**
   * 解析本次启动的运行时来源（dsh-source-policy）与执行入口。
   * 返回 null 表示终态已由本函数发布（取消或下载未获确认），调用方直接结束本次启动。
   */
  async function resolveLaunch(
    id: string,
    gen: number,
    instance: LocalInstance
  ): Promise<LaunchPlan | null> {
    emit(id, 'starting', { detail: '解析运行时来源' })
    // dush/duush 由用户已安装的启动器直接执行；它实际加载的 dsh 由 hub 经 DSH_BIN 决定。
    // 必须拿到**绝对路径**：裸命令名依赖 PATH 解析，而打包后 GUI 启动的 PATH 未必含用户 bin 目录。
    const customLauncherName =
      instance.launcher !== null && instance.launcher !== 'dsh' ? instance.launcher : null
    const launcherRuntime = customLauncherName
      ? ((await options.pathProbe?.probeLauncher?.(customLauncherName).catch(() => null)) ?? null)
      : null
    // 探测能力存在却没探到：裸命令名在打包后的 PATH 下注定 ENOENT（或被 node 包成
    // MODULE_NOT_FOUND），直接给出可行动的失败原因，不再构造注定失败的调用。
    if (
      customLauncherName !== null &&
      options.pathProbe?.probeLauncher !== undefined &&
      launcherRuntime === null
    ) {
      throw new Error(`未找到启动器 ${customLauncherName}（PATH 与常见安装位置均未探到）`)
    }
    const customLauncher = customLauncherName
      ? (launcherRuntime?.command ?? customLauncherName)
      : null
    // 启动来源判定与升级/版本检查共用 dsh-source-policy：公共空间 + 自定义启动器
    // 固定跟随系统默认 dsh（PATH 实测），不装 hub 副本、不理会实例的固定版本；
    // 隔离空间与默认启动器走同一套来源决策。
    const followSystemDsh = followsSystemDsh(instance.useDefaultSpace, instance.launcher)
    const [hubInstalled, pathRuntime] = await Promise.all([
      followSystemDsh
        ? Promise.resolve([] as string[])
        : options.installer
            .listInstalled()
            .then((items) => items.map((item) => item.version))
            .catch(() => [] as string[]),
      options.pathProbe ? options.pathProbe.probe().catch(() => null) : Promise.resolve(null)
    ])
    const plan = followSystemDsh
      ? pathRuntime === null
        ? null
        : {
            kind: 'path' as const,
            command: pathRuntime.command,
            version: pathRuntime.version,
            reason: 'unpinned-path-any' as const
          }
      : planRuntimeSource({
          desiredVersion: instance.dshVersion,
          hubInstalled,
          pathRuntime
        })
    if ((cancelGeneration.get(id) ?? -1) >= gen) {
      emit(id, 'stopped', { detail: '已取消启动' })
      return null
    }

    // 统一收敛为:执行入口(wrapper 或 dsh) + 显示用 version + 来源标记 + 注入给 wrapper 的 DSH_BIN
    let version: string
    let runtimeSource: 'hub' | 'path'
    let scriptPath: string
    let dshBin: string | null = null
    let resolved: { version: string; source: 'hub' | 'path'; command: string } | null = null
    if (plan?.kind === 'path') {
      resolved = { version: plan.version, source: 'path', command: plan.command }
    } else if (plan?.kind === 'hub') {
      resolved = {
        version: plan.version,
        source: 'hub',
        command: options.installer.resolveEntry(plan.version)
      }
    } else if (plan?.kind === 'download') {
      // download:目标版本(未固定时解析 registry latest),**必须经用户确认**
      const target = plan.version ?? (await options.installer.resolveDefaultVersion())
      emit(id, 'starting', { version: target, detail: `需要下载 dsh ${target}，等待确认` })
      const confirmed = await options.confirmDownload?.(target)
      if (confirmed !== true) {
        emit(id, 'stopped', {
          version: target,
          detail: `需要下载 dsh ${target}，未获确认，已取消启动（hub 与 PATH 上均无可用运行时）`
        })
        return null
      }
      if ((cancelGeneration.get(id) ?? -1) >= gen) return null
      resolved = { version: target, source: 'hub', command: options.installer.resolveEntry(target) }
    }
    if (customLauncher !== null) {
      scriptPath = customLauncher
      // 系统默认 dsh 未探到的公共实例退回旧显示:创建时选定的版本,未固定则保留 'custom' 占位。
      version = resolved?.version ?? instance.dshVersion ?? 'custom'
      runtimeSource = resolved?.source ?? 'path'
      dshBin = resolved?.command ?? null
    } else {
      if (resolved === null) throw new Error('invalid-launcher')
      scriptPath = resolved.command
      version = resolved.version
      runtimeSource = resolved.source
    }
    return { version, runtimeSource, scriptPath, dshBin, customLauncherName }
  }

  /**
   * 队列内执行一次启动：查重 → 安装 → 分配端口 → spawn → 接管子进程事件 → 等到就绪/退出/超时。
   * 段结束即放行队列里的下一个实例，此时端口与 DSH_HOME 已稳定。
   */
  async function spawnAndWatch(
    id: string,
    gen: number,
    instance: LocalInstance,
    launch: LaunchPlan
  ): Promise<StartOutcome> {
    const { version, runtimeSource, dshBin, customLauncherName } = launch
    // .cmd shim 解析后要回写，故保持可变
    let scriptPath = launch.scriptPath
    // 队列内二次查重:同一 tick 并发 start(双击启动 / 向导自动启动与手动启动竞速)
    // 时,第一次查重发生在首个 await 之前会双双通过,前一个任务可能已把该实例拉起
    const already = entries.get(id)
    if (already && !already.stopping) {
      emit(id, already.ready ? 'running' : 'starting', {
        version: already.version,
        runtimeSource: already.runtimeSource,
        ...(already.port !== null ? { port: already.port } : {}),
        ...(already.command !== undefined ? { command: already.command } : {}),
        detail: '实例已在运行，忽略重复启动'
      })
      return 'duplicate'
    }
    // Generation-based cancel: 取消点 >= 本任务的 generation 时取消
    if ((cancelGeneration.get(id) ?? -1) >= gen) return 'cancelled'
    emit(id, 'starting', {
      version,
      runtimeSource,
      detail:
        runtimeSource === 'path'
          ? `使用本机 dsh ${version} 启动`
          : `准备 dsh ${version} 运行时（首次需要安装，可能较慢）`
    })
    // path 来源运行的是用户本机安装,不需要(也不许)往应用隔离目录安装
    if (runtimeSource === 'hub')
      await options.installer.ensureInstalled(version, (progress) => {
        emit(id, 'installing', { version: progress.version, detail: progress.detail })
      })
    if ((cancelGeneration.get(id) ?? -1) >= gen) return 'cancelled'

    // 优先实例记录里用户选定的端口(向导高级设置);被占则向上递增,启动后仍回写实际端口。
    // 用户端口可能落在默认区间(3080-30999)之外(如 dsh 自身默认 52300):
    // 区间内被占递增到 30999;区间外则向 65535 递进,保证用户端口本身先被尝试,
    // 否则该端口会被静默丢弃且每次启动都漂移新端口
    const portStart = instance.port ?? DEFAULT_LOCAL_PORT
    const portEnd = portStart > DEFAULT_PORT_RANGE_END ? 65_535 : DEFAULT_PORT_RANGE_END
    const preferredPort = await findFreePort({
      start: portStart,
      end: portEnd,
      probe: portProbe
    }).catch(() => 0)
    emit(id, 'starting', {
      version,
      runtimeSource,
      detail:
        preferredPort > 0
          ? `分配端口并启动进程（端口 ${preferredPort}）`
          : '分配端口并启动进程（端口区间不可用，改由 dsh 自动选择）'
    })
    const home = instance.useDefaultSpace
      ? join(homeDir(), '.dsh')
      : join(options.dataRoot, 'homes', id)
    await mkdir(home, { recursive: true })

    // --profile 会直接选择 web profile，不能再附加 web 子命令；所有参数由 Hub 构造，不经 shell 解释。
    // 刻意不传 --host：由 dsh 自己的默认绑定决定（与用户直接运行 `dsh --profile web --port N --no-open` 一致）。
    const profileArgs = ['--profile', instance.profile ?? profile]
    const serverArgs = ['--port', String(preferredPort), '--no-open']
    // win32 的 .cmd shim 无法被 spawn 直接执行（Node 命令注入防护）：解析出入口脚本
    // 交给 node 直跑；解析失败立即失败，不构造注定 EINVAL/ENOENT 的调用。
    if (scriptPath.toLowerCase().endsWith('.cmd')) {
      const script = resolveCmdShim(scriptPath)
      if (script === null) {
        throw new Error(`无法解析启动器脚本（${scriptPath}）`)
      }
      scriptPath = script
    }
    // hub 与 path 来源都优先真实 node：dsh 的原生插件按运行时指纹（Electron 版本白名单）
    // 校验，不在白名单的 Electron 启动即以 code=1 退出；真实 node 不受该限制。
    const runtimeNode = resolveNode(scriptPath)
    const nodeArgs = nodeInvocation.args
    // 环境构造：登录 shell 完整环境 / 仅 PATH（见 resolveBaseEnv）；node 目录始终前置，
    // 保证 dsh 自己 spawn 的子进程解析到同一个 node。
    const baseEnv = await resolveBaseEnv({ inherit: inheritShellEnv(), shellEnv, loginPath })
    const basePath = baseEnv.PATH ?? ''
    // node 目录前置（dsh 自己 spawn 的子进程解析到同一个 node）；随包 pnpm 启动器目录按平台并入：
    // Windows 前置（系统 pnpm 的全局 shim 已损坏，自带 pnpm 必须胜出），其余平台后置兜底
    // （系统 pnpm 与用户既有 profile 的 store 大版本匹配，优先用它，避免 ERR_PNPM_UNEXPECTED_STORE）。
    const nodeAndBase =
      runtimeNode !== null ? `${dirname(runtimeNode)}${delimiter}${basePath}` : basePath
    const runtimePath = withBundledPnpmPath(nodeAndBase, options.pnpmBinDir)
    const runtimeEnv: NodeJS.ProcessEnv = {
      ...baseEnv,
      PATH: runtimePath,
      DSH_HOME: home,
      // pnpm v12 的全局命令默认是「上下文感知 shim」（globalShims），dsh 转发 pnpm/node
      // 时该 shim 会做签名完整性校验并二次派发；在 nvm 等按需切换 node 的 Windows 环境下
      // 校验会失败（shim integrity check failed），二次派发还会弹出控制台窗口。dsh 把 pnpm/node
      // 当普通工具直接调用，无需 shim 派发，统一设 PNPM_SHIM_BYPASS=1 绕过（无 shim 的环境下为无副作用的空操作）。
      PNPM_SHIM_BYPASS: '1'
    }
    if (customLauncherName !== null) {
      // dush/duush wrapper 会把自己的隔离 patch 追加到 DUSH_PATCH_FILE；继承用户全局
      // patch 会让同一个 loader entry 加载两次，直接触发 duplicate 报错。
      delete runtimeEnv.DUSH_PATCH_FILE
    }
    if (dshBin !== null) {
      // wrapper 缺省回退 PATH 上的 dsh；注入 DSH_BIN 让它跑 hub 决定的那一份，
      // 状态里显示的版本、升级的目标与实际运行的 dsh 才始终一致。
      runtimeEnv.DSH_BIN = dshBin
    }
    const invocation =
      runtimeNode !== null
        ? {
            command: runtimeNode,
            args: [...nodeArgs, scriptPath, ...profileArgs, ...serverArgs],
            // 让 dsh 自己 spawn 的子进程也能解析到同一个 node。
            env: runtimeEnv
          }
        : runtimeSource === 'path'
          ? {
              // 找不到 node：仍按脚本 shebang 直接执行（用户 PATH 里可能有）。
              // 失败时退出详情会带上脱敏后的子进程日志，能看到 `env: node: ...` 这类原因。
              command: scriptPath,
              args: [...profileArgs, ...serverArgs],
              env: runtimeEnv
            }
          : {
              // hub 来源也找不到 node：回退内置 Electron（版本命中白名单时可用）。
              command: nodeInvocation.command,
              args: [...nodeArgs, scriptPath, ...profileArgs, ...serverArgs],
              env: { ...runtimeEnv, ...nodeInvocation.env, DSH_HOME: home }
            }
    const child = spawnImpl({
      ...invocation,
      cwd: home,
      // POSIX：detached 使子进程自成进程组，便于 process.kill(-pid) 整树回收。
      // Windows：detached 会给控制台子进程（node.exe）分配一个全新控制台，windowsHide
      // 挡不住这个新控制台 → 启动时弹出黑色命令行窗；且 Windows 的树回收走 taskkill /T
      // 不依赖进程组，故 Windows 一律非 detached（与 runtime-installer 的 npm spawn 一致）。
      detached: process.platform !== 'win32'
    })

    const entry: Entry = {
      child,
      url: null,
      port: null,
      version,
      command: formatCommandLine(invocation),
      runtimeSource,
      home,
      log: [],
      buffer: '',
      ready: false,
      stopping: false,
      timer: null
    }
    entries.set(id, entry)
    watchStdout(id, entry)

    // 队列放行信号:就绪 / 退出 / 出错 / 超时 任一发生即 settle
    let settleSpawned: (() => void) | null = null
    const spawnSettledPromise = new Promise<void>((resolve) => {
      settleSpawned = resolve
    })
    let settled = false
    entry.settleSpawn = () => {
      if (settled) return
      settled = true
      settleSpawned?.()
    }

    entry.timer = setTimeout(() => {
      // 身份守卫:本 timer 只属于本次尝试,不得误伤替换后的新条目
      if (entries.get(id) !== entry) return
      if (entry.ready || entry.stopping) return
      emit(id, 'error', {
        detail: `启动超时（${Math.round(readyTimeoutMs / 1000)}s）：未解析到就绪 URL${entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''}`
      })
      entry.stopping = true
      killTree(entry, 'SIGKILL')
      entries.delete(id)
      entry.settleSpawn?.()
    }, readyTimeoutMs)
    entry.timer.unref?.()

    child.on('error', (error: Error) => {
      // 身份守卫:陈旧条目的迟到事件不得删除更晚的同 id 条目
      if (entries.get(id) !== entry) return
      if (entry.stopping) return
      entry.stopping = true
      // 与下方 exit 处理器一致地清理就绪 timer，避免它在条目删除后仍空转到期。
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      emit(id, 'error', { detail: `进程启动失败：${error.message}` })
      entries.delete(id)
      entry.settleSpawn?.()
    })

    child.on('exit', (code, signal) => {
      // 身份守卫:旧子进程的迟到 exit(SIGKILL 无效的僵尸/D 态)会误删新条目,
      // 让新进程沦为无主、状态错误翻转为 stopped
      if (entries.get(id) !== entry) return
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      entries.delete(id)
      if (entry.stopping) {
        // 停止语义由 stop() 独占发布,这里不再重复 emit(每次正常停止只一条 stopped)
      } else {
        entry.stopping = true // 兜底:防止在途 handleReady 续体继续以「运行中」发布
        emit(id, 'error', {
          // 附上子进程最后几行输出:启动失败时它是唯一的失败原因来源。
          // `logTail` 经 `redactLine` 脱敏(剥掉 URL 查询串),就绪 URL 的 ?token= 不会进入详情。
          detail: `进程意外退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）${
            entry.log.length > 0 ? `；日志 ${logTail(entry)}` : ''
          }`
        })
      }
      entry.settleSpawn?.()
    })

    // 兜底:stop() 若落在「最后一次取消检查 → entries.set」之间(findFreePort/mkdir
    // 都是 await),它只登记了取消意图而看不到条目;这里必须补杀,否则子进程成为
    // 无主孤儿(before-quit 的 stopAll 也扫不到),继续占用端口与 DSH_HOME
    if ((cancelGeneration.get(id) ?? -1) >= gen) {
      entry.stopping = true
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      killTree(entry, 'SIGKILL')
      entries.delete(id)
      entry.settleSpawn?.()
      return 'cancelled'
    }

    // 等到就绪/退出/超时,再放行下一个实例(端口已稳定分配的保证)
    await spawnSettledPromise
    return 'spawned'
  }

  return { resolveLaunch, spawnAndWatch }
}
