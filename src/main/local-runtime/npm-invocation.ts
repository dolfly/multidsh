/**
 * npm 调用层：解析可执行的 npm 入口、装配子进程环境、流式运行 npm 并解析 fetch 输出。
 *
 * 供运行时安装器与插件管理器共用；本模块不感知安装目录与版本语义。
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { execFileResult } from './exec-file'
import type { CommandResult, CommandRunner } from './exec-file'
import { nodeModeExecutable } from '../node-mode'
import { killProcessGroup } from '../transport/spawn'
import { searchNodeDirs } from './node-dirs'

/**
 * 一次可执行的 npm 调用方式。
 *
 * Windows 不返回 .cmd 路径：其一，shim 损坏时报 "shim integrity check failed"；
 * 其二，Node ≥ 20.12 出于命令注入防护（CVE-2024-27980）禁止 spawn 直接执行
 * .cmd/.bat。因此 Windows 统一用 node.exe 直跑 npm-cli.js。
 */
export interface NpmInvocation {
  /** 直接可执行的程序：Unix 为 npm 入口脚本，Windows 为 node.exe */
  command: string
  /** 紧随程序的固定参数；Windows 下为 npm-cli.js 路径，其余为空 */
  prefixArgs: string[]
  /** 叠加到子进程环境的键；捆绑 npm 经应用自带 Node 运行时需 ELECTRON_RUN_AS_NODE=1。 */
  env?: NodeJS.ProcessEnv
}

function defaultExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function resolveNpmCliJs(): string | null {
  try {
    // npm-cli.js 是 npm 的入口脚本
    const resolved = require.resolve('npm/bin/npm-cli.js')
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : null
  } catch {
    // 找不到 npm 模块：走系统路径探测
    return null
  }
}

/** Windows：PATH 各目录里 node.exe 所在目录（供与 npm-cli.js 组合） */
function findWindowsNodeDir(exists: (path: string) => boolean): string | null {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir === '') continue
    if (exists(join(dir, 'node.exe'))) return dir
  }
  return null
}

/** Windows：node.exe 可能所在的目录，PATH 优先，常见安装位置兜底 */
function windowsNodeDirs(): string[] {
  const dirs = (process.env.PATH ?? '').split(';').filter((dir) => dir !== '')
  return [
    ...dirs,
    join(process.env['ProgramFiles'] || 'C:\\Program Files', 'nodejs'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs')
  ]
}

/** 列目录；目录不存在或不可读时返回空数组（候选探测只关心能列出的项）。 */
function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * 应用自带的 npm 调用方式：用当前进程的 Node（Electron 主进程即 `process.execPath` +
 * `ELECTRON_RUN_AS_NODE=1`）直跑随包分发的 `npm-cli.js`。
 *
 * 打包产物不能假设目标机装了 Node/npm：Windows 常见「PATH 与常见安装位置均未找到 npm」
 * 正是此因。捆绑的 npm-cli.js 让运行时安装与系统环境彻底解耦，系统 npm 仅作兜底。
 */
export interface BundledNpm {
  /** 随包分发的 npm-cli.js 绝对路径（存在性由调用方保证）。 */
  npmCliJs: string
  /** 运行它的 Node 可执行文件；缺省用 `process.execPath`。 */
  nodeCommand?: string
  /** 让 Electron 本体退化为纯 Node 执行脚本的环境；缺省 `ELECTRON_RUN_AS_NODE=1`。 */
  env?: NodeJS.ProcessEnv
}

function bundledNpmInvocation(bundled: BundledNpm): NpmInvocation {
  return {
    command: bundled.nodeCommand ?? nodeModeExecutable(),
    prefixArgs: [bundled.npmCliJs],
    env: bundled.env ?? { ELECTRON_RUN_AS_NODE: '1' }
  }
}

/**
 * 解析可用的 npm 调用方式，按优先级尝试：
 * 0. 随包分发的 npm-cli.js（经应用自带 Node 运行；打包产物不依赖系统 Node/npm）
 * 1. node_modules 里的 npm-cli.js（开发环境 / npm 作为依赖存在时）
 * 2. PATH 与常见安装位置中 node.exe + 自带 npm-cli.js 的组合（仅 Windows）
 * 3. 系统 PATH 上的 npm（which 定位，仅 Unix）
 * 4. 常见全局安装位置（GUI 启动时 PATH 可能残缺）
 * 返回 null 表示所有方式均不可用。
 */
export async function resolveNpmInvocation(
  run: CommandRunner = runCommand,
  exists: (path: string) => boolean = defaultExists,
  bundled: BundledNpm | null = null
): Promise<NpmInvocation | null> {
  // 捆绑 npm 优先且平台无关：脚本随包分发，存在即用，彻底不依赖系统 Node/npm。
  if (bundled !== null && exists(bundled.npmCliJs)) return bundledNpmInvocation(bundled)

  const npmCliJs = resolveNpmCliJs()

  if (process.platform === 'win32') {
    // ① 开发环境解析到的 npm-cli.js 配 PATH 上的 node.exe
    if (npmCliJs) {
      const nodeDir = findWindowsNodeDir(exists)
      if (nodeDir) return { command: join(nodeDir, 'node.exe'), prefixArgs: [npmCliJs] }
    }
    // ② node.exe 与其自带 npm-cli.js 同在的目录
    for (const dir of windowsNodeDirs()) {
      const nodeExe = join(dir, 'node.exe')
      const bundledCli = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      if (exists(nodeExe) && exists(bundledCli))
        return { command: nodeExe, prefixArgs: [bundledCli] }
    }
    return null
  }

  // Unix：npm 入口脚本带 shebang，可直接执行
  if (npmCliJs) return { command: npmCliJs, prefixArgs: [] }

  // PATH 上与 node 同目录的 npm
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const npmInSameDir = join(dir, 'npm')
    if (exists(join(dir, 'node')) && exists(npmInSameDir))
      return { command: npmInSameDir, prefixArgs: [] }
  }

  // 系统 PATH 上的 which
  try {
    const result = await run('which', ['npm'])
    if (result.code === 0) {
      const first = result.stdout.split('\n')[0]?.trim()
      if (first && first.length > 0) return { command: first, prefixArgs: [] }
    }
  } catch {
    // which 不存在：继续尝试候选路径
  }

  // 常见全局安装位置（GUI 启动时 PATH 可能残缺，which 探不到）；
  // 其余落点（homebrew、pnpm、bun、nvm 逐版本）复用 node 探测的同一份清单。
  const home = homedir()
  const candidates = [
    '/usr/local/bin/npm',
    '/usr/bin/npm',
    join(home, '.nvm', 'current', 'bin', 'npm'),
    join(home, '.local', 'bin', 'npm'),
    join(home, '.volta', 'bin', 'npm'),
    ...searchNodeDirs(home, defaultListDir).map((dir) => join(dir, 'npm'))
  ]
  for (const candidate of [...new Set(candidates)]) {
    if (exists(candidate)) return { command: candidate, prefixArgs: [] }
  }

  return null
}

/**
 * npm 子进程的 env：把 npm 自身目录与常见 node 落点前置到 PATH。
 * GUI 启动（Finder/Dock）只继承 launchd 最小 PATH，node 目录常不在其中，
 * npm 入口脚本的 `#!/usr/bin/env node` 会以 `env: node: No such file or directory` 失败。
 *
 * 捆绑 npm 经应用自带 Node 运行（`npm.command` 即 Electron/Node 本体），其 `npm.env`
 * （ELECTRON_RUN_AS_NODE=1）在此叠加，让 Electron 退化为纯 Node 执行 npm-cli.js。
 */
export function npmChildEnv(npm: NpmInvocation, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dirs = [dirname(npm.command), ...searchNodeDirs(homedir(), defaultListDir)]
  const path = [...new Set([...dirs, ...(process.env.PATH ?? '').split(delimiter)])].join(delimiter)
  return { ...process.env, PATH: path, ...npm.env, ...extra }
}

export const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'

export type { CommandResult, CommandRunner }

/** npm 查询与安装的统一执行超时；超时即 kill 并按失败上报。 */
export const COMMAND_TIMEOUT_MS = 15 * 60_000

export const runCommand: CommandRunner = (command, args, options = {}) =>
  execFileResult(command, args, {
    env: { ...process.env, ...options.env },
    maxBuffer: 16 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS
  })

/** 流式运行 npm：stderr 逐行回调供进度解析；启动失败、超时或被信号终止都 reject。 */
export type NpmRunner = (
  npm: NpmInvocation,
  args: string[],
  options: { env: NodeJS.ProcessEnv; onStderrLine?: (line: string) => void; signal?: AbortSignal }
) => Promise<CommandResult>

/** spawnNpm 内部使用的 spawn 依赖（默认 node:child_process 的 spawn）；测试借此确定性驱动 kill/退出路径。 */
export type SpawnNpmImpl = typeof spawn

export const spawnNpm = (
  npm: NpmInvocation,
  args: string[],
  options: { env: NodeJS.ProcessEnv; onStderrLine?: (line: string) => void; signal?: AbortSignal },
  spawnImpl: SpawnNpmImpl = spawn
): Promise<CommandResult> =>
  new Promise<CommandResult>((resolve, reject) => {
    // detached：npm 会 spawn 生命周期脚本 / node-gyp / git 等子进程；detached 让它们自成进程组，
    // 超时或退出中止时可经 killProcessGroup（负 pid）整组带走，而不是只杀 npm 本体留下孤儿。
    const child = spawnImpl(npm.command, [...npm.prefixArgs, ...args], {
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      // windowsHide：Windows 下不弹出控制台窗口（node.exe 属控制台子系统程序，默认会闪窗）。
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let pendingLine = ''
    let timeoutError: Error | null = null
    let abortError: Error | null = null
    let forceKill: ReturnType<typeof setTimeout> | null = null
    // 生产安装全部走本函数：卡死的 npm 会占住安装/启动串行队列直至应用无法退出，
    // 与 runCommand 同一 deadline，到点杀整组（含 npm spawn 的生命周期脚本子进程）并以超时失败上报。
    const timer = setTimeout(() => {
      timeoutError = new Error(`npm 执行超时（${COMMAND_TIMEOUT_MS} ms），已终止`)
      killProcessGroup(child, 'SIGTERM')
      forceKill = setTimeout(() => killProcessGroup(child, 'SIGKILL'), 5_000)
      forceKill.unref?.()
    }, COMMAND_TIMEOUT_MS)
    timer.unref?.()
    // 退出信号（stopAll）到达时终止在飞安装整组，避免退出后仍占着安装队列继续下载/装包。
    const onAbort = (): void => {
      abortError = new Error('npm 执行已取消（应用退出）')
      killProcessGroup(child, 'SIGTERM')
      forceKill ??= setTimeout(() => killProcessGroup(child, 'SIGKILL'), 3_000)
      forceKill.unref?.()
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    const cancelTimers = (): void => {
      clearTimeout(timer)
      if (forceKill) clearTimeout(forceKill)
      options.signal?.removeEventListener('abort', onAbort)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = String(chunk)
      stderr += text
      const lines = (pendingLine + text).split(/\r?\n/)
      pendingLine = lines.pop() ?? ''
      for (const line of lines) options.onStderrLine?.(line)
    })
    child.on('error', (error) => {
      cancelTimers()
      reject(error)
    })
    child.on('close', (code, signal) => {
      cancelTimers()
      if (pendingLine !== '') options.onStderrLine?.(pendingLine)
      if (abortError) {
        reject(abortError)
        return
      }
      if (timeoutError) {
        reject(timeoutError)
        return
      }
      if (signal != null) {
        reject(new Error(`npm 执行被信号终止（${signal}）`))
        return
      }
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })

/** npm 单条 http 日志的解析结果。 */
export interface NpmFetchInfo {
  /** 相对路径（去掉 registry 主机与查询串）：包名（元数据）或 `<...>/<file>.tgz`（包体）。 */
  path: string
  /** tarball = 真正的包体；packument = 仅元数据。 */
  kind: 'tarball' | 'packument'
}

/**
 * 解析 npm `--loglevel http` 的一行日志，只认「下载了某个包体/元数据」两类完成行：
 * - 网络下载：`npm http fetch GET 200 <url> <耗时> (cache miss)`
 * - 缓存命中：`npm http cache [<name>@]<url> <耗时> (cache hit)`
 *
 * 缓存命中同样计入——否则重复安装/修复时会因为「没走网络」而数不到已就绪的包。
 * 包体判定用「URL 路径以 .tgz 结尾」而不是 `/-/`：镜像 registry（如 npmmirror）的
 * tarball 路径形如 `/packages/<name>/<ver>/<file>.tgz`，并不含 `/-/`。
 */
export function npmFetchInfo(line: string): NpmFetchInfo | null {
  if (!/^npm http (?:fetch GET \d+|cache)\b/.test(line)) return null
  const url = /(https?:\/\/\S+)/.exec(line)?.[1]
  if (url === undefined) return null
  const path = url.replace(/https?:\/\/[^/]+\//, '').split('?')[0] ?? ''
  if (path === '') return null
  return { path, kind: path.endsWith('.tgz') ? 'tarball' : 'packument' }
}

/** 取文本最后 max 行——npm 失败的结论性输出在日志末尾。 */
export function tailLines(text: string, max: number): string {
  const lines = text.trim().split('\n')
  return lines.slice(-max).join('\n')
}
