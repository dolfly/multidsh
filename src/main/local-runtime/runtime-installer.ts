/**
 * dsh 运行时安装器。
 *
 * 按版本把 `@deepseek-ai/dsh` 装进隔离目录 `runtimes/dsh-<version>/`，版本间零干扰；
 * 安装中写 `installing.json` 支持断点恢复；列表来自 npm registry。
 */
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DSH_VERSION_PATTERN } from '@shared/contracts'
import { redactLine, redactSecret } from '@shared/redact'
import type { CommandResult, CommandRunner } from './exec-file'
import {
  DSH_PACKAGE_NAME,
  npmChildEnv,
  npmFetchInfo,
  resolveNpmInvocation,
  runCommand,
  spawnNpm,
  tailLines,
  type BundledNpm,
  type NpmInvocation,
  type NpmRunner
} from './npm-invocation'
import { compareDshVersions } from './version-compare'

export * from './npm-invocation'

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
      // http 级日志的 stderr 含全部 fetch 行，只保留尾部的结论性输出。
      // stderr 是自由文本，可能带 npmToken=xxx 形态的凭据或带查询串的 registry 地址：
      // 这段说明会经 IPC 到达界面，两类形态都要打掉。
      const tail = redactSecret(redactLine(tailLines(result.stderr, 20)))
      throw new Error(
        `安装 ${DSH_PACKAGE_NAME}@${version} 失败（exit ${result.code}）：${tail || '无 stderr'}`
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
