/**
 * 本机运行时来源的纯决策与探测原语。
 *
 * 用户决策的获取优先级:「优先 hub 已装同版本 → 再探测 PATH → 都没有才下载,
 * 真要下载时需要用户确认」。本模块是其中的**纯决策与探测原语**:
 *
 * - `planRuntimeSource`:给定(固定版本 / hub 已装清单 / PATH 探测结果),产出
 *   「用 hub / 用 PATH / 需下载(需用户确认)」的计划。纯函数、依赖全注入,可穷举测试。
 * - `createPathProbe`:探测 PATH 上的 dsh(`which`/`where` → 绝对路径校验 →
 *   `dsh --version` 解析版本)。探测失败一律返回 null(尽力而为,不阻塞启动)。
 * - `compareDshVersions`:数字感知的版本比较(0.10.0 > 0.9.0;正式 > 同号 rc),
 *   用于「hub 已装清单取最新」。
 *
 * 接线(调用方)注意:PATH 来源运行时**不回写** `dshVersion` —— 未固定实例应跟随
 * 用户本机升级,而不是被钉死在探测当天的版本上(见 index.ts 状态事件的回写闸)。
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import type { LocalLauncher } from '@shared/local-launch'
import { DSH_VERSION_PATTERN } from '@shared/contracts'
import { execFileResult } from './exec-file'
import { resolveCmdShim } from './cmd-shim'
import { searchNodeDirs } from './node-dirs'
import type { CommandRunner } from './runtime-installer'

// 版本比较实现独立在 version-compare.ts（安装器与本模块共用）；
// 此处保留导出，调用方仍可从本模块取得。
export { compareDshVersions } from './version-compare'
import { compareDshVersions } from './version-compare'

/** PATH 上探测到的 dsh 运行时 */
export interface PathRuntime {
  /** dsh 可执行文件的绝对路径 */
  command: string
  /** `dsh --version` 输出的版本号(已校验) */
  version: string
}

/** 运行时来源计划(kind 字段做判别) */
export type RuntimePlan =
  | {
      kind: 'hub'
      version: string
      reason: 'pinned-installed' | 'unpinned-installed'
    }
  | {
      kind: 'path'
      command: string
      version: string
      reason: 'pinned-path-match' | 'unpinned-path-any'
    }
  | {
      kind: 'download'
      /** 下载目标版本;null = 未固定,由调用方解析 registry latest */
      version: string | null
      reason: 'pinned-missing' | 'unpinned-missing'
    }

/** planRuntimeSource 的输入(全部显式注入,便于穷举测试) */
export interface PlanInput {
  /** 实例固定版本;null = 未固定(跟随最新) */
  desiredVersion: string | null
  /** hub `runtimes/` 里已装的版本清单 */
  hubInstalled: readonly string[]
  /** PATH 探测结果;null = 没探到 */
  pathRuntime: PathRuntime | null
}

/**
 * 版本比较见 `./version-compare.ts`（数字感知：0.10.0 > 0.9.0；正式 > 同号 rc）。
 */

/**
 * 来源决策(纯函数):
 * - 固定 X:hub 装了 X → hub;PATH dsh 版本恰为 X → path;否则 download X(需确认)
 * - 未固定:PATH 有 dsh → path(用户自己维护的安装,永远最新);
 *   否则 hub 已装任意版本(取最新,复用已下载)→ hub;否则 download null(需确认)
 */
export function planRuntimeSource(input: PlanInput): RuntimePlan {
  const { desiredVersion, hubInstalled, pathRuntime } = input

  if (desiredVersion !== null) {
    if (hubInstalled.includes(desiredVersion)) {
      return { kind: 'hub', version: desiredVersion, reason: 'pinned-installed' }
    }
    if (pathRuntime !== null && pathRuntime.version === desiredVersion) {
      return {
        kind: 'path',
        command: pathRuntime.command,
        version: desiredVersion,
        reason: 'pinned-path-match'
      }
    }
    return { kind: 'download', version: desiredVersion, reason: 'pinned-missing' }
  }

  if (pathRuntime !== null) {
    return {
      kind: 'path',
      command: pathRuntime.command,
      version: pathRuntime.version,
      reason: 'unpinned-path-any'
    }
  }
  if (hubInstalled.length > 0) {
    const latest = [...hubInstalled].sort(compareDshVersions).at(-1) ?? hubInstalled[0]!
    return { kind: 'hub', version: latest, reason: 'unpinned-installed' }
  }
  return { kind: 'download', version: null, reason: 'unpinned-missing' }
}

export interface PathProbe {
  /** 探测 PATH 上的 dsh;失败返回 null(尽力而为) */
  probe(): Promise<PathRuntime | null>
  /** 探测指定的固定启动器；仅接受 dsh、dush 或 duush。 */
  probeLauncher?(launcher: LocalLauncher): Promise<PathRuntime | null>
}

export interface PathProbeOptions {
  run?: CommandRunner

  platform?: NodeJS.Platform

  home?: string
  /** 文件存在性检查(注入便于测试);默认 fs.existsSync */
  exists?: (path: string) => boolean
  /** 列目录(注入便于测试;nvm 多版本用);默认返回空数组(读失败即忽略) */
  listDir?: (path: string) => string[]
  /** 是否额外探测登录 shell(默认开;测试可关避免真的起 shell) */
  loginShell?: boolean
  /** win32 `.cmd` shim 的入口脚本解析(注入便于测试);缺省读磁盘解析 */
  resolveShim?: (cmdPath: string) => string | null
  /** 登录 shell 可执行文件;默认 process.env.SHELL ?? /bin/zsh */
  shell?: string
}

const WHICH_TIMEOUT_MS = 15_000
/** 登录 shell 探测的等待上限:比 which 更短,失败就走「未探到」 */
const SHELL_PROBE_TIMEOUT_MS = 8_000

export function createPathProbe(options: PathProbeOptions = {}): PathProbe {
  const run =
    options.run ??
    // 探测只关心 stdout/exit code；超时远短于安装器的 15 分钟，超时按失败 reject
    ((command, args) =>
      execFileResult(command, args, { timeout: WHICH_TIMEOUT_MS, maxBuffer: 64 * 1024 }))

  /**
   * 带超时的执行(候选探测/登录 shell 兜底用)。注入的 `run` 自带其超时策略,
   * 这里只做签名适配;默认实现按传入的 timeoutMs 走独立超时。
   */
  const injectedRun = options.run
  const runWith = (
    command: string,
    args: string[],
    timeoutMs: number,
    env?: NodeJS.ProcessEnv
  ): Promise<CommandResultLike> => {
    if (injectedRun) return injectedRun(command, args)
    return execFileResult(command, args, {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024,
      ...(env === undefined ? {} : { env })
    })
  }
  const platform = options.platform ?? process.platform
  const home = options.home ?? homedir()
  const exists = options.exists ?? ((path: string) => existsSync(path))
  const listDir =
    options.listDir ??
    ((path: string) => {
      try {
        return readdirSync(path)
      } catch {
        return []
      }
    })
  const useLoginShell = options.loginShell ?? true
  const shell = options.shell ?? process.env.SHELL ?? '/bin/zsh'
  const resolveShim = options.resolveShim ?? resolveCmdShim

  /** 校验候选:绝对路径 + `--version` 可解析(与 which 分支同一口径) */
  async function validate(
    command: string,
    timeoutMs = WHICH_TIMEOUT_MS,
    env?: NodeJS.ProcessEnv
  ): Promise<PathRuntime | null> {
    if (command === '' || !isAbsoluteFor(platform, command)) return null
    try {
      // win32 的 .cmd 无法被直接执行(Node 命令注入防护):解析 shim 后由 node 跑入口脚本;
      // 探测结果仍保留 .cmd 路径 —— 展示与 npm 全局前缀推导都以 shim 为准。
      let probeCommand = command
      let probeArgs = ['--version']
      if (platform === 'win32' && command.toLowerCase().endsWith('.cmd')) {
        const script = resolveShim(command)
        if (script === null) return null
        probeCommand = 'node'
        probeArgs = [script, '--version']
      }
      const versioned = await runWith(probeCommand, probeArgs, timeoutMs, env)
      if (versioned.code !== 0) return null
      const version = firstLine(versioned.stdout)
      if (!DSH_VERSION_PATTERN.test(version)) return null
      return { command, version }
    } catch {
      return null
    }
  }

  function enrichedEnv(command: string): NodeJS.ProcessEnv {
    // Windows 的 PATH 分隔符是分号;候选目录统一按对应平台目录形态拼接
    const separator = platform === 'win32' ? ';' : ':'
    const dirs = [
      platform === 'win32' ? winDirname(command) : posix.dirname(command),
      ...searchNodeDirs(home, listDir)
    ]
    const existing = process.env.PATH ?? ''
    return {
      ...process.env,
      PATH: [...new Set(dirs)].join(separator) + (existing ? `${separator}${existing}` : '')
    }
  }

  /**
   * 三层探测:① 常规 PATH ② 候选绝对路径 ③ 登录 shell 兜底。
   *
   * `probe()` 与 `probeLauncher()` **必须走同一套**:打包后从 Finder/Dock 启动时
   * 进程只继承 launchd 的最小 PATH(`/usr/bin:/bin:/usr/sbin:/sbin`),装在
   * `~/.local/bin` 的 dsh/dush/duush 永远 `which` 不到 —— 向导若只做第 ① 层,用户就会
   * 看到「未检测到 dsh、dush 或 duush」,而运行时获取却能成功。
   */
  async function probeFor(launcher: LocalLauncher): Promise<PathRuntime | null> {
    // ① 常规 PATH 探测(终端启动的场景:这里就命中)
    const which = platform === 'win32' ? 'where' : 'which'
    try {
      const located = await run(which, [launcher])
      if (located.code === 0) {
        const command = firstLine(located.stdout)
        const viaWhich = await validate(command, WHICH_TIMEOUT_MS, enrichedEnv(command))
        if (viaWhich) return viaWhich
      }
    } catch {
      // which/where 不存在(极端环境)也继续走候选探测
    }

    // ② 常见全局安装位置:GUI 启动时 PATH 残缺,这些路径 which 看不到
    for (const candidate of candidatePaths(platform, home, listDir, launcher)) {
      if (!exists(candidate)) continue
      const found = await validate(candidate, WHICH_TIMEOUT_MS, enrichedEnv(candidate))
      if (found) return found
    }

    // ③ 登录 shell 兜底:自定义 PATH(nvm/volta/asdf/自建 bin)只有登录环境才知道,
    //    而且 shell 里 dsh 与 node 都能解析。**在 shell 内一次跑完**路径与版本,
    //    避免「shell 里找得到、外面跑不动」的假阴性(node 不在 GUI PATH 上)。
    if (useLoginShell && platform !== 'win32') {
      try {
        const located = await runWith(
          shell,
          ['-lc', `command -v ${launcher}; ${launcher} --version`],
          SHELL_PROBE_TIMEOUT_MS
        )
        if (located.code === 0) {
          const lines = located.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
          const command = lines[0] ?? ''
          const version = lines[1] ?? ''
          if (isAbsoluteFor(platform, command) && DSH_VERSION_PATTERN.test(version)) {
            return { command, version }
          }
        }
      } catch {
        // 登录 shell 不可用/超时:按未探到处理
      }
    }

    return null
  }

  return {
    probeLauncher: (launcher) => probeFor(launcher),
    probe: () => probeFor('dsh')
  }
}

/**
 * 候选绝对路径(按「最可能命中」排序,去重)。
 *
 * 用户实测(macOS,GUI 启动):dsh 装在 `~/.local/bin/dsh`(npm 全局 symlink),
 * 而 Finder 启动的 app PATH 只有系统目录 → `which dsh` 永远失败。除 npm 全局外,
 * 这里覆盖 pnpm / nvm / volta / bun / homebrew 等常见落点;启动器名在 win32 下
 * 补 `.cmd`(npm 全局脚本形态)。
 */
function candidatePaths(
  platform: NodeJS.Platform,
  home: string,
  listDir: (path: string) => string[],
  launcher: LocalLauncher
): string[] {
  if (platform === 'win32') {
    return [
      `${home}\\.local\\bin\\${launcher}.cmd`,
      `${home}\\AppData\\Roaming\\npm\\${launcher}.cmd`,
      `${home}\\AppData\\Local\\pnpm\\${launcher}.cmd`
    ]
  }
  const candidates = [
    // npm 全局(--prefix ~/.local 或默认前缀)/ macOS 常见
    `${home}/.local/bin/${launcher}`,
    `${home}/.npm-global/bin/${launcher}`,
    // pnpm 全局(macOS 与 Linux 两处默认落点)
    `${home}/Library/pnpm/${launcher}`,
    `${home}/.local/share/pnpm/${launcher}`,
    // 其它版本管理器
    `${home}/.volta/bin/${launcher}`,
    `${home}/.bun/bin/${launcher}`,
    `${home}/.dnm/shims/${launcher}`,
    `${home}/.asdf/shims/${launcher}`,
    // 系统包管理器
    `/opt/homebrew/bin/${launcher}`,
    `/usr/local/bin/${launcher}`
  ]
  // nvm:多版本,逐个列目录(取全部,由 validate 决定谁可用)
  const nvmRoot = `${home}/.nvm/versions/node`
  for (const entry of listDir(nvmRoot).sort().reverse()) {
    candidates.push(`${nvmRoot}/${entry}/bin/${launcher}`)
  }
  return [...new Set(candidates)]
}

interface CommandResultLike {
  code: number
  stdout: string
  stderr: string
}

/** 取命令所在目录;win32 兼容反斜杠与盘符路径 */
function winDirname(command: string): string {
  const normalized = command.replace(/\//g, '\\')
  const index = normalized.lastIndexOf('\\')
  return index > 0 ? normalized.slice(0, index) : command
}

function firstLine(stdout: string): string {
  return (stdout.split('\n')[0] ?? '').trim()
}

function isAbsoluteFor(platform: NodeJS.Platform, p: string): boolean {
  if (platform === 'win32') {
    // 盘符路径(允许大小写盘符)或 UNC 路径
    return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
  }
  return posix.isAbsolute(p)
}
