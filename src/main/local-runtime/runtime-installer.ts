/**
 * dsh 运行时安装器。
 *
 * 按版本把 `@deepseek-ai/dsh` 装进隔离目录 `runtimes/dsh-<version>/`，版本间零干扰；
 * 安装中写 `installing.json` 支持断点恢复；列表来自 npm registry。
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { DSH_VERSION_PATTERN } from '@shared/contracts'
import { nodeModeExecutable } from '../node-mode'
import { execFileResult } from './exec-file'
import type { CommandResult, CommandRunner } from './exec-file'
import { killProcessGroup } from '../transport/spawn'
import { searchNodeDirs } from './node-dirs'
import { compareDshVersions } from './version-compare'

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
function npmChildEnv(npm: NpmInvocation, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
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
function tailLines(text: string, max: number): string {
  const lines = text.trim().split('\n')
  return lines.slice(-max).join('\n')
}

export interface InstalledRuntime {
  version: string
  /** runtimes/dsh-<version> */
  dir: string
  /** node <entry> —— 即 dsh 的 bin.js */
  entry: string
  /** 安装完成时间（ISO）；来自目录 mtime */
  installedAt: string
}

export interface InstallProgress {
  /** installing = 下载包体与收尾；不提供百分比——npm 没有可用的总量与进度。 */
  phase: 'installing'
  version: string
  detail?: string
}

export interface RuntimeInstallerOptions {
  /** <dataRoot>/runtimes */
  runtimesDir: string
  /** npm 缓存目录（放在应用数据目录内，避免污染/受限的用户级缓存） */
  cacheDir: string
  registry?: string
  /** 动态获取 registry（每次安装时读取最新设置）；优先级高于静态 registry。 */
  getRegistry?: () => string | undefined
  run?: CommandRunner
  /** 流式运行 npm（注入便于测试）；默认 spawnNpm。 */
  runNpm?: NpmRunner
  /** npm 调用方式解析（注入便于测试）；默认按平台探测系统 npm。 */
  resolveNpm?: () => Promise<NpmInvocation | null>
  /**
   * 随包分发的 npm（打包产物不依赖系统 Node/npm）；提供时最优先，
   * 经应用自带 Node 运行 npm-cli.js。默认 resolveNpm 会把它前置到探测链。
   */
  bundledNpm?: BundledNpm
  /** 文件存在性检查（注入便于测试）；默认使用 fs.statSync */
  exists?: (path: string) => boolean
  /** 只读元数据（versions 列表）内存缓存时长；0 = 关闭缓存。默认 60s（注入便于测试）。 */
  metadataTtlMs?: number
}

export interface RuntimeInstaller {
  listAvailableVersions(): Promise<string[]>
  resolveDefaultVersion(): Promise<string>
  listInstalled(): Promise<InstalledRuntime[]>
  isInstalled(version: string): Promise<boolean>
  install(version: string): Promise<InstalledRuntime>
  /**
   * 原子「检查并安装」：同一版本只会安装一次 —— 并发调用（多实例同时首次启动）
   * 会在队列里串行，后来者直接复用已完成的安装结果。
   */
  ensureInstalled(
    version: string,
    onProgress?: (progress: InstallProgress) => void
  ): Promise<InstalledRuntime>
  resolveEntry(version: string): string
  /** 安装中断标记（installing.json）是否残留 */
  hasIncompleteInstall(version: string): Promise<boolean>
  /** npm registry 上的最大版本（dist-tags.latest 可能滞后于新发布，按版本比较取最大）。 */
  resolveLatestVersion(): Promise<string>
  /**
   * 解析系统 dsh 可执行文件所属的 npm 全局 prefix（解析符号链接后再判定布局）；
   * 非 npm 全局安装（pnpm/brew 脚本/本地依赖）返回 null。
   */
  resolveGlobalPrefix(command: string): Promise<string | null>
  /**
   * 把 npm 全局安装的系统 dsh 原位升级到指定版本（`npm install -g --prefix <prefix>`）。
   * 只写入 prefix 自身的 lib/node_modules，不动 hub 隔离目录与其它安装。
   */
  installGlobal(
    prefix: string,
    version: string,
    onProgress?: (progress: InstallProgress) => void
  ): Promise<void>
  /**
   * 应用退出时调用：终止在飞的 npm 安装子进程，避免退出后仍在后台下载。
   * **一次性、不可逆**：内部 AbortController 一旦 abort 便永久失效，此后所有安装/查询都会立即
   * 以「已取消」失败。仅供退出路径调用，不是可反复使用的幂等清理。
   */
  dispose(): void
}

const INSTALLING_MARKER = 'installing.json'

export function runtimeDirFor(runtimesDir: string, version: string): string {
  assertVersion(version)
  return join(runtimesDir, `dsh-${version}`)
}

export function runtimeEntryFor(runtimesDir: string, version: string): string {
  return join(
    runtimeDirFor(runtimesDir, version),
    'node_modules',
    DSH_PACKAGE_NAME,
    'lib',
    'bin.js'
  )
}

function assertVersion(version: string): void {
  if (!DSH_VERSION_PATTERN.test(version)) {
    throw new Error(`非法版本号：${version}`)
  }
}

/**
 * 从 dsh 入口的**真实路径**推导它所属的 npm 全局 prefix；非 npm 全局安装返回 null。
 *
 * 只认 npm 全局布局：POSIX 为 `<prefix>/lib/node_modules/@deepseek-ai/dsh/...`，
 * Windows 为 `<prefix>/node_modules/@deepseek-ai/dsh/...`。pnpm 虚拟存储
 * （`.pnpm/.../node_modules/@deepseek-ai/dsh`）、本地 node_modules、shim 脚本
 * 都不落在该布局下 → 返回 null，交由调用方给出「无法代管升级」的失败原因。
 */
export function globalPrefixFor(
  realPath: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const normalized = realPath.replace(/\\/g, '/')
  const index = normalized.indexOf(`/node_modules/${DSH_PACKAGE_NAME}/`)
  if (index <= 0) return null
  const root = normalized.slice(0, index)
  if (platform === 'win32') return root
  // POSIX 下必须正好是 <prefix>/lib：多一段或少一段都说明不是 npm 全局安装，不做猜测。
  if (!root.endsWith('/lib') || root.length === '/lib'.length) return null
  return root.slice(0, -'/lib'.length)
}

/** npm 全局安装里 dsh 入口的绝对路径（POSIX 多一层 lib），与 `globalPrefixFor` 互为逆运算。 */
export function globalRuntimeEntry(
  prefix: string,
  platform: NodeJS.Platform = process.platform
): string {
  const nodeModules =
    platform === 'win32' ? join(prefix, 'node_modules') : join(prefix, 'lib', 'node_modules')
  return join(nodeModules, ...DSH_PACKAGE_NAME.split('/'), 'lib', 'bin.js')
}

export function createRuntimeInstaller(options: RuntimeInstallerOptions): RuntimeInstaller {
  const run = options.run ?? runCommand
  const runNpm = options.runNpm ?? spawnNpm
  const resolveNpm =
    options.resolveNpm ??
    (() => resolveNpmInvocation(run, options.exists, options.bundledNpm ?? null))

  /** 解析当前生效的 registry：动态回调优先，其次静态配置。 */
  function currentRegistry(): string | undefined {
    return options.getRegistry?.() ?? options.registry
  }
  function registryArgs(): string[] {
    const r = currentRegistry()
    return r ? ['--registry', r] : []
  }

  // 同名目录的安装必须串行(双实例并发启动会撞同一 runtimes/dsh-<v> 目录)
  let installChain: Promise<unknown> = Promise.resolve()
  function enqueueSerial<T>(task: () => Promise<T>): Promise<T> {
    const next = installChain.then(task, task)
    installChain = next.catch(() => undefined)
    return next
  }

  // 退出信号：stopAll 经 dispose() 触发，终止在飞的 npm 子进程，避免应用退出后安装仍在跑。
  const abortController = new AbortController()

  // 只读元数据（versions/dist-tags）走独立串行链：不排在长安装后面 —— 否则安装进行中
  // 触发的「检查更新 / 版本列表」要等安装结束才返回。cacache 支持并发读写，读不依赖安装完成。
  let metadataChain: Promise<unknown> = Promise.resolve()
  function enqueueMetadata<T>(task: () => Promise<T>): Promise<T> {
    const next = metadataChain.then(task, task)
    metadataChain = next.catch(() => undefined)
    return next
  }

  /** versions 列表内存缓存：同一 registry 在 TTL 内直接复用（切镜像自动失效）。 */
  const metadataTtlMs = options.metadataTtlMs ?? 60_000
  let versionsCache: { registry: string; at: number; versions: string[] } | null = null
  async function cachedVersions(): Promise<string[]> {
    const registry = currentRegistry() ?? ''
    const hit = versionsCache
    if (hit && hit.registry === registry && Date.now() - hit.at < metadataTtlMs) {
      return [...hit.versions]
    }
    const versions = await unsafeListAvailableVersions()
    versionsCache = { registry, at: Date.now(), versions }
    return [...versions]
  }

  // 缓存 npm 调用方式解析结果(只解析一次,避免重复探测)
  let resolvedNpm: NpmInvocation | null = null
  let npmResolved = false

  async function getNpmInvocation(): Promise<NpmInvocation> {
    if (!npmResolved) {
      resolvedNpm = await resolveNpm()
      npmResolved = true
    }
    if (resolvedNpm === null) {
      throw new Error('npm 不可用：系统 PATH 和常见安装位置均未找到 npm')
    }
    return resolvedNpm
  }

  async function npmView(args: string[]): Promise<CommandResult> {
    // 所有 npm 调用统一走应用私有 cache：用户级 ~/.npm 可能有权限问题(如 root 残留)，
    // 且避免污染用户缓存；view 类只读查询由调用方经元数据链(见 enqueueMetadata)串行执行。
    const npm = await getNpmInvocation()
    return run(
      npm.command,
      [
        ...npm.prefixArgs,
        'view',
        DSH_PACKAGE_NAME,
        ...args,
        '--cache',
        options.cacheDir,
        ...registryArgs()
      ],
      { env: npmChildEnv(npm, { npm_config_cache: options.cacheDir }) }
    )
  }

  /** 内部实现(不入队):供已持有队列的任务调用,避免嵌套自锁 */
  async function unsafeListAvailableVersions(): Promise<string[]> {
    const result = await npmView(['versions', '--json'])
    if (result.code !== 0) {
      throw new Error(`读取可用版本失败：${result.stderr.trim() || `exit ${result.code}`}`)
    }
    const parsed: unknown = JSON.parse(result.stdout || '[]')
    const list = Array.isArray(parsed) ? parsed : []
    return list
      .filter((item): item is string => typeof item === 'string')
      .filter((v) => !v.includes('/'))
  }

  async function unsafeResolveDefaultVersion(): Promise<string> {
    const result = await npmView(['dist-tags', '--json'])
    if (result.code === 0) {
      const tags: unknown = JSON.parse(result.stdout || '{}')
      const latest =
        tags && typeof tags === 'object' ? (tags as Record<string, unknown>)['latest'] : undefined
      if (typeof latest === 'string' && DSH_VERSION_PATTERN.test(latest)) return latest
    }
    const versions = await cachedVersions()
    if (versions.length === 0) throw new Error('registry 中没有可用的 dsh 版本')
    return versions[versions.length - 1] as string
  }

  /**
   * 执行一次 `npm install`：带进度回调时逐行解析 npm 日志给出下载记录，否则走 execFile 汇总
   * （便于测试 mock）。非零退出抛错，只保留 stderr 尾部的结论性输出。
   *
   * 只报「已下载多少个包 + 当前包」：npm 不提供可用的总量与进度，任何百分比都是编造的，
   * 所以这里不做百分比，界面只展示这条下载记录。
   */
  async function runNpmInstall(
    npm: NpmInvocation,
    installArgs: string[],
    version: string,
    onProgress?: (progress: InstallProgress) => void
  ): Promise<void> {
    const env = npmChildEnv(npm, { npm_config_cache: options.cacheDir })
    let result: CommandResult
    if (onProgress) {
      // 进度分支：逐行解析 npm 日志，只统计**包体**下载（含缓存命中），给出下载记录。
      const downloadedPaths = new Set<string>()
      let lastDetail = ''
      result = await runNpm(npm, installArgs, {
        env,
        signal: abortController.signal,
        onStderrLine: (line) => {
          const info = npmFetchInfo(line)
          // 元数据请求不代表包已就绪；同名包体重复日志只算一次。
          if (info === null || info.kind !== 'tarball' || downloadedPaths.has(info.path)) return
          downloadedPaths.add(info.path)
          const detail = `下载依赖 (${downloadedPaths.size})：${info.path}`
          if (detail !== lastDetail) {
            lastDetail = detail
            onProgress({ phase: 'installing', version, detail })
          }
        }
      })
    } else {
      // 无进度回调走 execFile 汇总（便于测试 mock）
      result = await run(npm.command, [...npm.prefixArgs, ...installArgs], { env })
    }
    if (result.code !== 0) {
      // http 级日志的 stderr 含全部 fetch 行，只保留尾部的结论性输出
      throw new Error(
        `安装 ${DSH_PACKAGE_NAME}@${version} 失败（exit ${result.code}）：${tailLines(result.stderr, 20) || '无 stderr'}`
      )
    }
    onProgress?.({ phase: 'installing', version, detail: '校验安装结果' })
  }

  return {
    listAvailableVersions(): Promise<string[]> {
      return enqueueMetadata(cachedVersions)
    },

    resolveDefaultVersion(): Promise<string> {
      return enqueueMetadata(() => unsafeResolveDefaultVersion())
    },

    resolveLatestVersion(): Promise<string> {
      return enqueueMetadata(async () => {
        const versions = await cachedVersions()
        if (versions.length === 0) throw new Error('registry 中没有可用的 dsh 版本')
        // dist-tags.latest 可能滞后于 alpha/next 渠道的新发布，取版本列表最大值。
        return [...versions].sort(compareDshVersions).at(-1) ?? versions[versions.length - 1]!
      })
    },

    async listInstalled(): Promise<InstalledRuntime[]> {
      let names: string[]
      try {
        names = await readdir(options.runtimesDir)
      } catch {
        return []
      }
      const installed: InstalledRuntime[] = []
      for (const name of names) {
        if (!name.startsWith('dsh-')) continue
        const version = name.slice('dsh-'.length)
        if (!DSH_VERSION_PATTERN.test(version)) continue
        if (await this.hasIncompleteInstall(version)) continue
        const stats = await stat(join(options.runtimesDir, name)).catch(() => null)
        installed.push({
          version,
          dir: runtimeDirFor(options.runtimesDir, version),
          entry: runtimeEntryFor(options.runtimesDir, version),
          installedAt: (stats?.mtime ?? new Date(0)).toISOString()
        })
      }
      return installed.sort((a, b) => a.version.localeCompare(b.version))
    },

    isInstalled(version: string): Promise<boolean> {
      // 走同一串行队列:等待可能在飞的安装结束,避免误判「未安装」而重复安装
      return enqueueSerial(() => unsafeIsInstalled(version))
    },

    resolveEntry(version: string): string {
      return runtimeEntryFor(options.runtimesDir, version)
    },

    hasIncompleteInstall(version: string): Promise<boolean> {
      assertVersion(version)
      return hasIncompleteInstallMarker(version)
    },

    install(version: string): Promise<InstalledRuntime> {
      return enqueueSerial(() => doInstall(version))
    },

    ensureInstalled(
      version: string,
      onProgress?: (progress: InstallProgress) => void
    ): Promise<InstalledRuntime> {
      return enqueueSerial(async () => {
        assertVersion(version)
        if (!(await unsafeIsInstalled(version))) return doInstall(version, onProgress)
        const dir = runtimeDirFor(options.runtimesDir, version)
        const stats = await stat(dir)
        return {
          version,
          dir,
          entry: runtimeEntryFor(options.runtimesDir, version),
          installedAt: stats.mtime.toISOString()
        }
      })
    },

    async resolveGlobalPrefix(command: string): Promise<string | null> {
      try {
        // 先解析符号链接：npm/pnpm 全局 bin 都是 symlink，真实路径才暴露安装布局。
        return globalPrefixFor(await realpath(command))
      } catch {
        return null
      }
    },

    installGlobal(
      prefix: string,
      version: string,
      onProgress?: (progress: InstallProgress) => void
    ): Promise<void> {
      return enqueueSerial(async () => {
        assertVersion(version)
        const npm = await getNpmInvocation()
        onProgress?.({
          phase: 'installing',
          version,
          detail: `全局安装 ${DSH_PACKAGE_NAME}@${version}（${prefix}）`
        })
        const installArgs = [
          'install',
          '-g',
          '--prefix',
          prefix,
          '--no-audit',
          '--no-fund',
          '--loglevel',
          'http',
          '--cache',
          options.cacheDir,
          `${DSH_PACKAGE_NAME}@${version}`,
          ...registryArgs()
        ]
        await runNpmInstall(npm, installArgs, version, onProgress)
        const entry = globalRuntimeEntry(prefix)
        try {
          await stat(entry)
        } catch {
          throw new Error(`全局升级完成但未找到 dsh 入口：${entry}`)
        }
        onProgress?.({ phase: 'installing', version, detail: '安装完成' })
      })
    },

    dispose(): void {
      abortController.abort()
    }
  }

  async function unsafeIsInstalled(version: string): Promise<boolean> {
    assertVersion(version)
    if (await hasIncompleteInstallMarker(version)) return false
    try {
      await stat(runtimeEntryFor(options.runtimesDir, version))
      return true
    } catch {
      return false
    }
  }

  async function hasIncompleteInstallMarker(version: string): Promise<boolean> {
    try {
      await stat(join(runtimeDirFor(options.runtimesDir, version), INSTALLING_MARKER))
      return true
    } catch {
      return false
    }
  }

  async function doInstall(
    version: string,
    onProgress?: (progress: InstallProgress) => void
  ): Promise<InstalledRuntime> {
    assertVersion(version)
    const dir = runtimeDirFor(options.runtimesDir, version)
    const markerPath = join(dir, INSTALLING_MARKER)

    await mkdir(options.runtimesDir, { recursive: true })
    await mkdir(dir, { recursive: true })
    await writeFile(
      markerPath,
      JSON.stringify({ version, startedAt: new Date().toISOString(), pid: process.pid }, null, 2),
      'utf8'
    )
    onProgress?.({
      phase: 'installing',
      version,
      detail: `安装 ${DSH_PACKAGE_NAME}@${version}`
    })

    const npm = await getNpmInvocation()
    const installArgs = [
      'install',
      '--prefix',
      dir,
      '--no-audit',
      '--no-fund',
      '--loglevel',
      'http',
      '--cache',
      options.cacheDir,
      `${DSH_PACKAGE_NAME}@${version}`,
      ...registryArgs()
    ]
    await runNpmInstall(npm, installArgs, version, onProgress)
    const entry = runtimeEntryFor(options.runtimesDir, version)
    await stat(entry)
    await rm(markerPath, { force: true })
    onProgress?.({ phase: 'installing', version, detail: '安装完成' })
    const stats = await stat(dir)
    return { version, dir, entry, installedAt: stats.mtime.toISOString() }
  }
}

/** 读取安装标记（诊断用） */
export async function readInstallingMarker(
  runtimesDir: string,
  version: string
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(runtimeDirFor(runtimesDir, version), INSTALLING_MARKER), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}
