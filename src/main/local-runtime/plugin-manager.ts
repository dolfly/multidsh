/**
 * 本机实例的 dsh 插件管理：列表、检查升级、安装（含安装前版本解析）、升级、卸载、包信息取数。
 *
 * 全部经 `dsh plugin --profile <p> <pnpm-args>` 转发（dsh 内部把 pnpm 参数原样透传，并自动
 * 维护 profile package.json 的 `dependencies` 与 `bundles` 数组）。DSH_HOME 与 profile 由
 * 主进程按实例推导，绝不采信渲染层路径；命令输出经 `redactLine` 脱敏。
 *
 * 安装源以枚举档位传入：URL 由主进程映射为 `--registry`，解析（view）与安装（add）必须同源，
 * 否则「看到的版本」与「装到的版本」可能来自不同 registry。
 *
 * 不 import Electron：dsh 可执行入口的解析复用安装器（隔离目录）与 PATH 探测，与启动同一判据。
 */
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path'
import { homedir } from 'node:os'
import type {
  LocalInstance,
  PluginCheckRecord,
  PluginCheckSnapshot,
  PluginEnableResult,
  PluginInfo,
  PluginInstallKind,
  PluginInstallOptions,
  PluginInstallPlan,
  PluginMutationResult,
  PluginPackageInfo,
  PluginRegistryOption,
  PluginUpdateCheck,
  PluginVersionSource
} from '@shared/contracts'
import { DEFAULT_PLUGIN_REGISTRY, pluginRegistryUrl } from '@shared/settings'
import { redactLine } from '@shared/redact'
import { execFileResult } from './exec-file'
import type { CommandResult, CommandRunner } from './exec-file'
import type { InstalledRuntime, RuntimeInstaller } from './runtime-installer'
import { planRuntimeSource, type PathProbe } from './runtime-source'
import { followsSystemDsh } from './dsh-source-policy'
import { compareDshVersions } from './version-compare'
import { InstanceStoreError } from '../registry/instance-store'
import { mergeLoginPath, resolveLoginPathOnce } from './login-path'
import { mergeShellEnv, resolveShellEnvOnce } from './shell-env'
import { dshPeerRange, evaluateDshPeers, githubUrlFrom, npmUrlFrom } from './peer-compatibility'
import { createPluginStateStore } from './plugin-state'
import type {
  AutoDisabledPlugin,
  PluginCheckState,
  PluginPublishedSnapshot,
  PluginStateStore
} from './plugin-state'
import { createProfileBundleStore } from './profile-bundles'
import { withBundledPnpmPath } from '../shell/bundled-pnpm'
import { userLayerDisablesHmr } from './profile-hmr'
import type { ProfileBundleStore } from './profile-bundles'
import { createPackageInfoFetchers } from './plugin-package-info'
import type { PackageInfoFetchers } from './plugin-package-info'
import { nodeModeExecutable } from '../node-mode'

/** 插件命令执行超时：pnpm 安装可能较慢，给足余量（与安装器同量级）。 */
const PLUGIN_COMMAND_TIMEOUT_MS = 10 * 60_000

/** 界面语言：与 app 的 Language 一致（system 已解析为 zh|en）。 */
export type PluginLocale = 'zh' | 'en'

interface PluginManifest {
  name?: string
  version?: string
  description?: string
  author?: unknown
  license?: string
  homepage?: string
  repository?: unknown
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  engines?: { node?: string }
  icon?: string
  dsh?: { bundle?: { patch?: string }; client?: unknown }
}

/** `dsh plugin list --json` 的顶层条目（只取用到的字段）。 */
interface ProfileListEntry {
  dependencies?: Record<
    string,
    { from?: string; version?: string; resolved?: string; path?: string }
  >
}

export interface PluginManagerOptions {
  installer: RuntimeInstaller
  /** 数据根目录：隔离空间实例的 DSH_HOME 落在 `<dataRoot>/homes/<id>`。 */
  dataRoot: string
  pathProbe?: PathProbe
  /** 随包分发 pnpm 启动器所在目录；提供时前置到插件命令 PATH，令 dsh 用自带 pnpm。 */
  pnpmBinDir?: string
  /** 用户主目录来源；公共空间实例的 DSH_HOME 为 `<home>/.dsh`。缺省 os.homedir。 */
  homeDir?: () => string
  /** 默认 profile（实例未指定时）。缺省 'web'。 */
  profile?: string
  /** 命令执行器（注入便于测试）；缺省 execFileResult。 */
  run?: CommandRunner
  /** package.json 读取（注入便于测试）；缺省读磁盘。 */
  readManifest?: (dir: string) => PluginManifest | null
  /** icon 文件读取为 base64（注入便于测试）；缺省读磁盘。 */
  readIcon?: (path: string) => string | null
  /** locale JSON 读取（注入便于测试）；缺省读磁盘并解析。 */
  readLocale?: (path: string) => { meta?: { title?: string; description?: string } } | null
  /** 真实 node 解析（注入便于测试）；缺省按脚本同目录探测。 */
  resolveNode?: (scriptPath: string) => string | null
  /** Electron 自带 Node 兜底调用（缺省 execPath + ELECTRON_RUN_AS_NODE=1）。 */
  nodeInvocation?: { command: string; args: string[]; env: NodeJS.ProcessEnv }
  /**
   * 是否把登录 shell 完整环境合并进插件命令；false 时仅合并登录 PATH（回退）。
   * 缺省 true；由设置项 inheritShellEnv 决定，读取函数注入以便运行中改设置即时生效。
   * 与本机实例启动同源——打包后 GUI 从 Finder/Dock 启动只继承 launchd 最小 PATH，
   * pnpm/node 目录不在其中，`dsh plugin` 转发 pnpm 会「pnpm not found」而失败。
   */
  inheritShellEnv?: () => boolean
  /** 登录 shell 完整环境解析（含 .zshrc/.bashrc export）；null=不可用。缺省进程内缓存的真实解析。 */
  shellEnv?: () => Promise<Map<string, string> | null>
  /** 登录环境 PATH 解析（登录 shell / Windows 注册表）；null=不可用时回退继承 PATH。缺省进程内缓存的真实解析。 */
  loginPath?: () => Promise<string | null>
  /** 检查状态持久化（注入便于测试）；缺省写 `<dataRoot>/plugin-state/<id>.json`。 */
  stateStore?: PluginStateStore
  /** profile 加载清单读写（注入便于测试）；缺省直接读写 profile 的 package.json。 */
  bundleStore?: ProfileBundleStore
  /** 更新内容与下载量取数（注入便于测试）；缺省走 npm 下载量接口与 GitHub Release/CHANGELOG。 */
  packageInfoFetchers?: PackageInfoFetchers
}

/** 插件信息与检查结果的单一定义在 @shared/contracts；此处再导出以保留既有导入路径。 */
export type { PluginInfo, PluginUpdateCheck }

export interface PluginManager {
  list(instance: LocalInstance, locale?: PluginLocale): Promise<PluginInfo[]>
  check(instance: LocalInstance, name: string): Promise<PluginUpdateCheck>
  /**
   * 安装前解析版本：npm 裸名/disc-tag 查 registry 选出版本（不再把 `latest` 直接交给安装），
   * github/file 原样返回（不联网、无法判定兼容性）。
   */
  resolveInstall(
    instance: LocalInstance,
    spec: string,
    options?: PluginInstallOptions
  ): Promise<PluginInstallPlan>
  /**
   * 安装插件；`enable === false` 时安装后把它移出加载清单（保留 dependency，落到「已禁用」），
   * 缺省按 dsh 的默认启用行为。
   */
  install(
    instance: LocalInstance,
    spec: string,
    options?: PluginInstallOptions
  ): Promise<PluginMutationResult>
  /** 某版本的更新内容（GitHub Release → CHANGELOG → 无）与近 30 天下载量；取不到不是错误。 */
  packageInfo(instance: LocalInstance, name: string, version: string): Promise<PluginPackageInfo>
  upgrade(instance: LocalInstance, name: string, version: string): Promise<PluginMutationResult>
  remove(instance: LocalInstance, name: string): Promise<PluginMutationResult>
  /** 读取该实例的持久化检查状态（含在飞检查），供渲染层挂载时恢复标记。 */
  checkState(instance: LocalInstance): Promise<PluginCheckSnapshot>
  /** 启用/禁用插件（改 profile 的 bundles，保留 dependencies）；返回变更后的状态。 */
  setEnabled(instance: LocalInstance, name: string, enabled: boolean): Promise<PluginEnableResult>
  /**
   * dsh 运行时版本变更后的首次启动：核对已启用插件的 peer 是否兼容新版本，
   * 不兼容的自动禁用（移出 bundles）并返回明细。版本未变时为无操作。
   */
  reconcileRuntime(instance: LocalInstance, runtimeVersion: string): Promise<RuntimeReconcileResult>
}

/** 运行时变更后的核对结果。 */
export interface RuntimeReconcileResult {
  /** 本次是否真的做了核对（版本未变 / 无 profile 时为 false）。 */
  checked: boolean
  /** 因与新版 dsh 不兼容而被禁用的插件。 */
  disabled: AutoDisabledPlugin[]
}

/** 含 web-app bundle 的 profile 才有 HMR 服务（headless/SDK/ACP 显式关闭）。 */
const WEB_APP_BUNDLE = '@deepseek-ai/dsh-web-app'

/**
 * 运行中的 Host 是否具备 HMR（决定改动能否热生效）。
 *
 * 与 dsh 的 `change()` 同口径：`ownerContext.get('hmr') !== undefined ? applied : restart-required`。
 * hmr 服务由 base bundle 提供、仅在有 profileContext 时启用，headless/SDK/ACP 在自己的 patch 里
 * 显式关闭。这里按「profile 名或加载清单里出现 web-app」判定；判定不出时按「无 HMR」保守处理
 * （宁可提示重启，也不谎称已生效）。
 */
export function profileHasHmr(profile: string, bundles: readonly string[] | null): boolean {
  if (profile === 'web') return true
  return bundles !== null && bundles.includes(WEB_APP_BUNDLE)
}

/** dsh 语义下的生效结果：`applied` 已热生效；`restart-required` 需重启 Host。 */
export type PluginApplication = 'applied' | 'restart-required'

/** 非「替换已装包」的操作：有 HMR 即热生效，否则需重启。 */
function defaultApplication(hmr: boolean): PluginApplication {
  return hmr ? 'applied' : 'restart-required'
}

function defaultReadManifest(dir: string): PluginManifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PluginManifest
  } catch {
    return null
  }
}

function defaultReadIcon(path: string): string | null {
  try {
    return readFileSync(path).toString('base64')
  } catch {
    return null
  }
}

function defaultReadLocale(path: string): { meta?: { title?: string; description?: string } } | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as { meta?: { title?: string; description?: string } }
  } catch {
    return null
  }
}

/** author 字段可能是字符串或 `{ name, email }` 对象。 */
function authorName(author: unknown): string | null {
  if (typeof author === 'string') return author.trim() || null
  if (author && typeof author === 'object' && 'name' in author) {
    const name = String((author as { name: unknown }).name ?? '').trim()
    return name || null
  }
  return null
}

/** 安装来源判定：resolved 指向 registry → npm；from/version 指向 github / file。 */
function installSourceOf(entry: {
  from?: string
  version?: string
  resolved?: string
}): PluginInfo['installSource'] {
  const from = entry.from ?? ''
  const version = entry.version ?? ''
  const resolved = entry.resolved ?? ''
  if (/^(github:|git\+|git@)/.test(from) || /github\.com/.test(from) || /github\.com/.test(version)) {
    return 'github'
  }
  if (/^(file:|link:)/.test(from) || /^(file:|link:)/.test(version)) return 'file'
  if (resolved.includes('/') && /https?:\/\//.test(resolved)) return 'npm'
  // 无 resolved 但有普通语义化 version（本地 node_modules 已解析）：按 npm 处理。
  if (version !== '' && !version.includes('/')) return 'npm'
  return 'unknown'
}

/** SVG 文本 base64 → data-uri（图标恒为 svg，其它扩展一律忽略）。 */
function svgDataUri(base64: string | null): string | null {
  return base64 === null ? null : `data:image/svg+xml;base64,${base64}`
}

/** spec 形态分类：github/file 交给 pnpm 按原样安装，不做 registry 版本解析。 */
function classifyPluginSpec(spec: string): PluginInstallKind {
  if (/^(github:|git\+https:\/\/|git@)/.test(spec)) return 'github'
  if (/^file:/.test(spec)) return 'file'
  return 'npm'
}

/** 拆 npm spec 为包名与可选的版本/标签段；scoped 包名的首个 `@` 属于包名。 */
function splitNpmSpec(spec: string): { name: string; requested: string | null } {
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@')
  if (at < 0) return { name: spec, requested: null }
  const requested = spec.slice(at + 1)
  return { name: spec.slice(0, at), requested: requested === '' ? null : requested }
}

/** 版本段形态：数字开头或含点 = 精确版本；其余（latest/next/beta…）按 dist-tag 处理。 */
function isVersionLiteral(requested: string): boolean {
  return /^\d/.test(requested) || requested.includes('.')
}

/** 候选版本里的最大者（数字感知）；空集合返回 null。 */
function maxVersion(versions: readonly string[]): string | null {
  return [...versions].sort(compareDshVersions).at(-1) ?? null
}

/**
 * 选出不带版本段的 npm spec 要安装的版本：dist-tags.latest 与最大稳定版取较大者
 * （dist-tag 滞后时不装旧版），全为预发布时取最大预发布；候选为空回落 dist-tag latest 字段。
 * versions 数组不保证按版本序排列，因此必须用 compareDshVersions 求最大而不是取末位。
 */
function pickTargetVersion(
  versions: readonly string[],
  latest: string | null,
  fallback: string | null
): string | null {
  const stable = versions.filter((version) => !version.includes('-'))
  const candidates = stable.length > 0 ? [latest, maxVersion(stable)] : [...versions]
  const best = maxVersion(candidates.filter((item): item is string => typeof item === 'string' && item !== ''))
  return best ?? fallback
}

/** 已装插件列表里同名插件的版本（列表用 '—' 表示版本未知）。 */
function installedVersionOf(plugins: readonly PluginInfo[], name: string): string | null {
  const version = plugins.find((plugin) => plugin.name === name)?.version
  return version === undefined || version === '—' ? null : version
}

/** registry 未收录（与 check 同判据）：pnpm view 对未发布的包/不存在的版本返回 404。 */
function isRegistryNotFound(error: unknown): boolean {
  return error instanceof InstanceStoreError && /404|Not Found|ERR_PNPM_FETCH_404/i.test(error.message)
}

/** 解析 view 的 JSON 输出；输出不可解析时给不出计划，按内部错误报错。 */
function parseViewMeta(stdout: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || '{}')
  } catch {
    throw new InstanceStoreError('internal', '无法解析插件版本信息输出')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InstanceStoreError('internal', '无法解析插件版本信息输出')
  }
  return parsed as Record<string, unknown>
}

/** 取 peerDependencies；字段缺失或形态异常按空处理（无约束）。 */
function peerMapOf(meta: Record<string, unknown>): Record<string, string> {
  const peers = meta.peerDependencies
  return typeof peers === 'object' && peers !== null && !Array.isArray(peers)
    ? (peers as Record<string, string>)
    : {}
}

/** 取字符串数组字段（versions）；空串与非字符串项忽略。 */
function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
}

/** 取对象字段（dist-tags / repository 等）；形态不符按空对象。 */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 发布时间映射里该版本的时刻；缺失或非字符串按 null。 */
function publishedAtOf(timeMap: Record<string, string> | null, version: string): string | null {
  const at = timeMap?.[version]
  return typeof at === 'string' && at !== '' ? at : null
}

export function createPluginManager(options: PluginManagerOptions): PluginManager {
  const run = options.run ?? ((command, args, opts) => execFileResult(command, args, {
    env: opts?.env,
    timeout: PLUGIN_COMMAND_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  }))
  const readManifest = options.readManifest ?? defaultReadManifest
  const readIcon = options.readIcon ?? defaultReadIcon
  const readLocale = options.readLocale ?? defaultReadLocale
  const homeDir = options.homeDir ?? homedir
  const defaultProfile = options.profile ?? 'web'
  const resolveNode = options.resolveNode ?? defaultResolveNode
  const nodeInvocation =
    options.nodeInvocation ??
    { command: nodeModeExecutable(), args: [], env: { ELECTRON_RUN_AS_NODE: '1' } }
  const inheritShellEnv = options.inheritShellEnv ?? ((): boolean => true)
  const shellEnv = options.shellEnv ?? resolveShellEnvOnce
  const loginPath = options.loginPath ?? resolveLoginPathOnce
  const stateStore = options.stateStore ?? createPluginStateStore(options.dataRoot)
  const bundleStore = options.bundleStore ?? createProfileBundleStore()
  const packageInfoFetchers = options.packageInfoFetchers ?? createPackageInfoFetchers()

  /**
   * 在飞检查的插件名（实例 id → 名字集合）。检查在后台跑到结束（用户切走也不中止），
   * 渲染层回来时据此重新显示「检查中…」。
   */
  const inFlightChecks = new Map<string, Set<string>>()

  /** 实例的 DSH_HOME 与 profile（与启动路径同一推导）。 */
  function homeAndProfile(instance: LocalInstance): { home: string; profile: string } {
    const home = instance.useDefaultSpace
      ? join(homeDir(), '.dsh')
      : join(options.dataRoot, 'homes', instance.id)
    return { home, profile: instance.profile ?? defaultProfile }
  }

  /** 标记某插件开始检查；返回结束标记函数（务必在 finally 调用）。 */
  function markChecking(instanceId: string, name: string): () => void {
    const set = inFlightChecks.get(instanceId) ?? new Set<string>()
    set.add(name)
    inFlightChecks.set(instanceId, set)
    return () => {
      set.delete(name)
      if (set.size === 0) inFlightChecks.delete(instanceId)
    }
  }

  /**
   * 启用前按「将执行命令的 dsh 版本」评估插件 peer 兼容性；不兼容时先授予精确版本豁免
   * （`dsh plugin allow-version <name>@<version> --dsh-version <runtime> --accept-risk`），
   * 否则 dsh 会在启动/热更新时拒绝加载该插件。
   *
   * 两个版本都必须与 dsh 自己的判据一致：`--dsh-version` 取实际执行命令的副本
   * （resolveDshEntry，dsh 按自身版本校验），插件版本取 manifest 的 `version`
   * （dsh 加载时按 manifest 身份 `name@version` 匹配豁免；列表里的版本在 file:/link:
   * 安装下可能是路径）。授予失败抛错（调用方不改加载清单）；兼容返回 null。
   */
  async function grantEnableExemption(
    instance: LocalInstance,
    profileDir: string,
    name: string,
    listedVersion: string,
    resolved: { entry: string; version: string }
  ): Promise<{ pluginVersion: string; dshVersion: string } | null> {
    // 与 reconcileRuntime 同源：读 profile 顶层 node_modules 里插件自身的 manifest。
    const manifest = readManifest(join(profileDir, 'node_modules', ...name.split('/')))
    const peers = manifest?.peerDependencies ?? {}
    if (Object.keys(evaluateDshPeers(peers, resolved.version)).length === 0) return null
    const pluginVersion = manifest?.version ?? listedVersion
    await runPlugin(
      instance,
      ['allow-version', `${name}@${pluginVersion}`, '--dsh-version', resolved.version, '--accept-risk'],
      resolved
    )
    return { pluginVersion, dshVersion: resolved.version }
  }

  /** 状态落盘失败不影响本次检查/改动结果：只是重启后看不到标记。 */
  async function writeState(instanceId: string, state: PluginCheckState): Promise<void> {
    await stateStore.write(instanceId, state).catch((error: unknown) => {
      console.error('[plugin] 写入插件检查状态失败：', error)
    })
  }

  /**
   * 把一次检查结果并入持久化状态：
   * - 有新版则记下候选信息，已是最新则删掉该项（标记「直到用户再次检查或升级才变」由此保证）；
   * - 取到已装版本的发布时间则写入版本快照（发布后不变，之后一直复用，下次检查再刷新）；
   *   registry 未收录该版本时（published 为 null）保留原快照，显示端只在版本号一致时才读它。
   */
  async function persistCheck(
    instanceId: string,
    name: string,
    record: PluginCheckRecord | null,
    published: PluginPublishedSnapshot | null
  ): Promise<void> {
    const state = await stateStore.read(instanceId)
    const updates = { ...state.updates }
    if (record === null) delete updates[name]
    else updates[name] = record
    const snapshots = { ...state.published }
    if (published !== null) snapshots[name] = published
    await writeState(instanceId, {
      ...state,
      lastCheckedAt: new Date().toISOString(),
      updates,
      published: snapshots
    })
  }

  /** 该插件的检查痕迹随升级/卸载失效：可升级标记与发布时间快照一并丢弃（不刷新「上次检查」时刻）。 */
  async function dropCheck(instanceId: string, name: string): Promise<void> {
    const state = await stateStore.read(instanceId)
    const updates = { ...state.updates }
    delete updates[name]
    const snapshots = { ...state.published }
    delete snapshots[name]
    await writeState(instanceId, { ...state, updates, published: snapshots })
  }

  /**
   * 升级完成后同步该插件的检查痕迹：清掉可升级标记（已装版本已是目标版本），并把新版本的
   * 发布时间落成快照，无需用户再次检查即可显示发布时间。取不到发布时间（如离线）时清掉
   * 旧版本的陈旧快照，由下次检查补齐（不刷新「上次检查」时刻）。
   */
  async function syncCheckAfterUpgrade(
    instance: LocalInstance,
    name: string,
    resolved: { entry: string; version: string }
  ): Promise<void> {
    const published = await resolveInstalledPublished(instance, name, resolved).catch(() => null)
    const state = await stateStore.read(instance.id)
    const updates = { ...state.updates }
    delete updates[name]
    const snapshots = { ...state.published }
    if (published !== null) snapshots[name] = published
    else delete snapshots[name]
    await writeState(instance.id, { ...state, updates, published: snapshots })
  }

  /**
   * 取该插件已装版本在注册表里的发布时间快照；读不到已装版本或 registry 未收录该版本时返回 null。
   * 与 check 同口径：发布时间取 view 的 time 映射中「已装版本」那一项。
   */
  async function resolveInstalledPublished(
    instance: LocalInstance,
    name: string,
    resolved: { entry: string; version: string }
  ): Promise<PluginPublishedSnapshot | null> {
    const plugins = await listPlugins(instance, 'zh', resolved)
    const installed = plugins.find((plugin) => plugin.name === name)?.version
    if (installed === undefined || installed === '—') return null
    const result = await runPlugin(
      instance,
      ['view', name, 'time', '--json'],
      resolved,
      DEFAULT_PLUGIN_REGISTRY
    )
    const at = publishedTimeMap(result.stdout)?.[installed]
    return typeof at === 'string' && at !== '' ? { version: installed, at } : null
  }

  /**
   * 运行中的 Host 是否有 HMR：先看 profile 与 home 两层 patch 是否显式关闭（用户自己写的配置，
   * 见 profile-hmr），否则按 profile 名 / web-app bundle 的启发式判断。
   */
  async function hmrAvailable(
    instance: LocalInstance,
    profileDir: string,
    bundles: readonly string[] | null
  ): Promise<boolean> {
    const { home, profile } = homeAndProfile(instance)
    if (await userLayerDisablesHmr(profileDir, home)) return false
    return profileHasHmr(profile, bundles)
  }

  /**
   * 解析插件命令要用的 dsh 入口及其版本。判据与启动路径共用 dsh-source-policy：
   * 公共空间 + 自定义启动器（dush/duush）固定跟随系统 dsh（PATH 实测），其余走 planRuntimeSource。
   *
   * 版本必须与真正执行命令的副本一致：dsh 的插件安装闸按自身版本判定 peer，若检查阶段用注册表
   * 版本、执行阶段却落到另一个 hub 副本，就会出现「检查说可升级、安装被 dsh 拒绝」。
   */
  async function resolveDshEntry(
    instance: LocalInstance
  ): Promise<{ entry: string; version: string }> {
    const followSystemDsh = followsSystemDsh(instance.useDefaultSpace, instance.launcher)
    const [installed, pathRuntime] = await Promise.all([
      // 跟随系统 dsh 时 hub 副本不参与决策（与启动路径一致：不装副本、不理会固定版本）。
      followSystemDsh
        ? Promise.resolve([] as InstalledRuntime[])
        : options.installer.listInstalled().catch(() => [] as InstalledRuntime[]),
      options.pathProbe ? options.pathProbe.probe().catch(() => null) : Promise.resolve(null)
    ])
    const plan = followSystemDsh
      ? pathRuntime === null
        ? null
        : { kind: 'path' as const, command: pathRuntime.command, version: pathRuntime.version }
      : planRuntimeSource({
          desiredVersion: instance.dshVersion,
          hubInstalled: installed.map((item) => item.version),
          pathRuntime
        })
    if (plan?.kind === 'path') return { entry: plan.command, version: plan.version }
    if (plan?.kind === 'hub') {
      const hit = installed.find((item) => item.version === plan.version)
      if (hit) return { entry: hit.entry, version: hit.version }
    }
    // download（固定版本未安装）或系统 dsh 未探到：插件命令不触发运行时下载，
    // 回落 hub 已装的最新副本（与实例的 hub 归属一致，判定宁可拦下不误放行），再回落 PATH 实测。
    const newest = [...installed].sort((a, b) => compareDshVersions(a.version, b.version)).at(-1)
    if (newest !== undefined) return { entry: newest.entry, version: newest.version }
    if (pathRuntime !== null) return { entry: pathRuntime.command, version: pathRuntime.version }
    throw new InstanceStoreError('invalid-state', '未找到可用的 dsh：hub 隔离目录与 PATH 上都没有已安装的运行时')
  }

  /**
   * 解析子进程的基础环境：默认合并登录 shell 完整环境（含 .zshrc/.bashrc export），
   * 关闭开关 / 解析失败时回退到仅合并登录 PATH。与本机实例启动同源——保证打包后 GUI
   * 启动也能解析到 pnpm/node（`dsh plugin` 转发 pnpm 需要它们在 PATH 上）。
   */
  async function resolveBaseEnv(): Promise<NodeJS.ProcessEnv> {
    const shellEnvMap = inheritShellEnv() ? await shellEnv().catch(() => null) : null
    if (shellEnvMap !== null) return mergeShellEnv(process.env, shellEnvMap)
    const loginEnvPath = await loginPath().catch(() => null)
    return { ...process.env, PATH: mergeLoginPath(process.env.PATH ?? '', loginEnvPath) }
  }

  /**
   * 构造并执行一次插件命令；非零退出抛 invalid-state（消息为脱敏后的 stderr 尾部）。
   * dsh 拒绝安装（不兼容闸、pnpm 失败等）时，这段说明是用户唯一能看到的失败原因，
   * 必须透出而不是收敛成「内部错误」。
   *
   * registry 由主进程按档位映射后追加 `--registry <url>`：dsh 把余下参数逐字转给 profile 内的
   * pnpm，因此 view（解析）与 add（安装）能落在同一个源上。
   */
  async function runPlugin(
    instance: LocalInstance,
    args: string[],
    resolved: { entry: string; version: string },
    registry?: PluginRegistryOption | null
  ): Promise<CommandResult> {
    const { home, profile } = homeAndProfile(instance)
    const fullArgs = registry === undefined || registry === null ? args : [...args, '--registry', pluginRegistryUrl(registry)]
    const pluginArgs = ['plugin', '--profile', profile, ...fullArgs]
    const node = resolveNode(resolved.entry)
    // 登录 shell 完整环境 / 仅登录 PATH（见 resolveBaseEnv）：打包后 GUI 启动缺 pnpm/node 目录，
    // dsh plugin 转发 pnpm 会失败；node 目录始终前置，dsh 自己 spawn 的 pnpm 也解析到同一个 node。
    const baseEnv = await resolveBaseEnv()
    const basePath = baseEnv.PATH ?? ''
    const nodePath = node !== null ? dirname(node) : null
    // node 目录前置；随包 pnpm 启动器目录按平台并入：Windows 前置（系统 pnpm 全局 shim 已损坏，
    // 自带 pnpm 必须胜出），其余平台后置兜底（系统 pnpm 与用户既有 profile 的 store 大版本匹配，
    // 优先用它，避免 pnpm 10 操作 pnpm 12 建的 profile 触发 ERR_PNPM_UNEXPECTED_STORE）。
    const nodeAndBase = nodePath !== null ? `${nodePath}${delimiter}${basePath}` : basePath
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      PATH: withBundledPnpmPath(nodeAndBase, options.pnpmBinDir),
      DSH_HOME: home,
      // pnpm v12 全局命令默认走「上下文感知 shim」（globalShims）：转发 pnpm 时该 shim 会做
      // 签名完整性校验并二次派发，nvm 等按需切换 node 的 Windows 环境下校验失败
      // （shim integrity check failed）。插件命令把 pnpm 当普通工具直接调用，设 PNPM_SHIM_BYPASS=1
      // 绕过 shim 派发（与启动路径一致；无 shim 的环境下为无副作用的空操作）。
      PNPM_SHIM_BYPASS: '1'
    }
    const invocation =
      node !== null
        ? { command: node, args: [...nodeInvocation.args, resolved.entry, ...pluginArgs], env }
        : resolved.entry.endsWith('.js')
          ? {
              command: nodeInvocation.command,
              args: [...nodeInvocation.args, resolved.entry, ...pluginArgs],
              env: { ...env, ...nodeInvocation.env, DSH_HOME: home }
            }
          : { command: resolved.entry, args: pluginArgs, env }
    const result = await run(invocation.command, invocation.args, { env: invocation.env })
    if (result.code !== 0) {
      const tail = redactLine(result.stderr.trim()).split('\n').slice(-8).join('\n')
      throw new InstanceStoreError(
        'invalid-state',
        `dsh plugin ${fullArgs.join(' ')} 失败（exit ${result.code}）：${tail || '无 stderr'}`
      )
    }
    return result
  }

  /**
   * 查 `name@version` 的 peer 与发布时间：用户显式版本走这里，解析出的目标版本与首次查询的
   * 版本不一致时也用它补一次（否则 peer 与发布时间会是另一个版本的口径）。
   * registry 未收录该版本按 not-found 报错；输出不可解析按 internal。
   */
  async function viewVersionMeta(
    instance: LocalInstance,
    name: string,
    version: string,
    resolved: { entry: string; version: string },
    registry: PluginRegistryOption
  ): Promise<{ peers: Record<string, string>; publishedAt: string | null }> {
    let result: CommandResult
    try {
      result = await runPlugin(
        instance,
        ['view', `${name}@${version}`, 'peerDependencies', 'time', '--json'],
        resolved,
        registry
      )
    } catch (error) {
      if (isRegistryNotFound(error)) throw new InstanceStoreError('not-found', `版本不存在：${name}@${version}`)
      throw error
    }
    return {
      peers: peerMapOf(parseViewMeta(result.stdout)),
      publishedAt: publishedAtOf(publishedTimeMap(result.stdout), version)
    }
  }

  /** 与 check 同口径：全部 dsh peer 都满足运行时版本才算兼容。 */
  function peersCompatible(peers: Record<string, string>, dshVersion: string): boolean {
    return Object.keys(evaluateDshPeers(peers, dshVersion)).length === 0
  }

  /**
   * 从 registry 元数据推导插件仓库地址（渲染层不传 URL）：`view <name>@<version> repository homepage`。
   * 命令失败与解析失败都按「没有仓库」处理：确认区只需降级到 npm 包页，不需要错误。
   */
  async function resolveRepositoryUrl(
    instance: LocalInstance,
    name: string,
    version: string,
    resolved: { entry: string; version: string }
  ): Promise<string | null> {
    try {
      const result = await runPlugin(
        instance,
        ['view', `${name}@${version}`, 'repository', 'homepage', '--json'],
        resolved,
        DEFAULT_PLUGIN_REGISTRY
      )
      const parsed: unknown = JSON.parse(result.stdout || '{}')
      const meta = recordOf(parsed)
      return githubUrlFrom(meta.repository ?? meta.homepage ?? null)
    } catch {
      return null
    }
  }

  /**
   * 从安装路径读 package.json 装配 PluginInfo。
   * 优先用 profile 顶层 node_modules/<name>（pnpm 布局下 scoped 包的可靠位置），
   * 回退 list --json 给出的 entry.path（可能指向 .pnpm 虚拟 store，scoped 包读不到）。
   * locale：读 <dir>/locale/<lang>.json 的 meta，本地化标题与简介覆盖 package.json 的英文原值。
   */
  function infoFromPath(
    name: string,
    entry: { from?: string; version?: string; resolved?: string; path?: string },
    profileNodeModules: string,
    locale: PluginLocale,
    bundles: readonly string[] | null
  ): PluginInfo {
    const topLevelDir = join(profileNodeModules, ...name.split('/'))
    const manifestDir = readManifest(topLevelDir) !== null ? topLevelDir : (entry.path ?? topLevelDir)
    const manifest = readManifest(manifestDir) ?? {}
    const dsh = manifest.dsh ?? {}
    const iconBase64 =
      typeof manifest.icon === 'string' ? readIcon(resolvePath(manifestDir, manifest.icon)) : null
    // locale/<lang>.json 的 meta：title 本地化插件名，description 本地化简介；缺失回落 package.json。
    const localeMeta = readLocale(join(manifestDir, 'locale', `${locale}.json`))?.meta
    const localizedTitle = localeMeta?.title?.trim() || null
    const localizedDescription = localeMeta?.description?.trim() || manifest.description?.trim() || null
    return {
      name,
      version: entry.version ?? manifest.version ?? '—',
      title: localizedTitle,
      description: localizedDescription,
      author: authorName(manifest.author),
      license: manifest.license?.trim() || null,
      npmUrl: npmUrlFrom(name),
      githubUrl: githubUrlFrom(manifest.repository ?? manifest.homepage ?? null),
      iconDataUri: svgDataUri(iconBase64),
      dependencies: Object.keys(manifest.dependencies ?? {}),
      dshPeer: dshPeerRange(manifest.peerDependencies),
      nodeEngine: manifest.engines?.node ?? null,
      hasHostSide: typeof dsh.bundle?.patch === 'string' && dsh.bundle.patch !== '',
      hasClientSide: dsh.client !== undefined && dsh.client !== null,
      installSource: installSourceOf(entry),
      // 只有含 host 半（dsh.bundle.patch）的插件才由 bundles 决定加载与否；
      // 纯 client 插件随宿主 bundle 加载，无法单独禁用 → null。
      enabled:
        typeof dsh.bundle?.patch === 'string' && dsh.bundle.patch !== ''
          ? bundles === null || bundles.includes(name)
          : null,
      // 发布时间来自 registry，由 list() 用检查快照回填（这里只给出默认值）。
      publishedAt: null
    }
  }

  /** 判定一个包名当前是否含 host 半（改动后决定是否提醒重启）。 */
  async function hostSideOf(
    instance: LocalInstance,
    name: string,
    resolved: { entry: string; version: string }
  ): Promise<boolean> {
    const plugins = await listPlugins(instance, 'zh', resolved)
    return plugins.find((plugin) => plugin.name === name)?.hasHostSide ?? false
  }

  async function listPlugins(
    instance: LocalInstance,
    locale: PluginLocale,
    resolved: { entry: string; version: string }
  ): Promise<PluginInfo[]> {
    const result = await runPlugin(instance, ['list', '--json'], resolved)
    let parsed: unknown
    try {
      parsed = JSON.parse(result.stdout || '[]')
    } catch {
      throw new Error('无法解析插件列表输出')
    }
    const first = Array.isArray(parsed) ? (parsed[0] as ProfileListEntry | undefined) : undefined
    const deps = first?.dependencies ?? {}
    // profile 顶层 node_modules：list --json 的 path 字段在 pnpm 布局下可能指向 .pnpm 虚拟 store，
    // scoped 包（@scope/name）在其中的 <scope>/<name> 子目录不存在；顶层软链才是可靠读取位置。
    const { home, profile } = homeAndProfile(instance)
    const profileNodeModules = join(home, 'profiles', profile, 'node_modules')
    // 加载清单决定「启用/禁用」状态；清单读不到（profile 尚未初始化）时按「未知」处理，
    // 由 infoFromPath 视作启用，避免把全部插件误显示为已禁用。
    const bundles = (await bundleStore.read(join(home, 'profiles', profile)))?.bundles ?? null
    return Object.entries(deps)
      .map(([name, entry]) => infoFromPath(name, entry, profileNodeModules, locale, bundles))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 按 profile 加载清单对齐单个插件的启用态（setEnabled 与「安装后不启用」共用同一条路径）：
   * 校验确属本 profile 的依赖 → 判 host 半 → 记原索引 → 写 bundles → 清自动禁用标记 → 算生效方式。
   * 启用前先按将执行命令的 dsh 版本评估兼容性并授予精确版本豁免（见 grantEnableExemption）。
   *
   * `known` 复用调用方已解析的运行时与插件列表（安装后对齐启用态时避免重复起进程）。
   */
  async function applyEnabled(
    instance: LocalInstance,
    profileDir: string,
    name: string,
    enabled: boolean,
    known?: { resolved?: { entry: string; version: string }; plugins?: PluginInfo[] }
  ): Promise<PluginEnableResult> {
    const profileBundles = await bundleStore.read(profileDir)
    const bundles = profileBundles?.bundles ?? []
    if (profileBundles !== null && !profileBundles.dependencies.includes(name)) {
      throw new InstanceStoreError('not-found', `插件未安装：${name}`)
    }
    const resolved = known?.resolved ?? (await resolveDshEntry(instance))
    const plugins = known?.plugins ?? (await listPlugins(instance, 'zh', resolved))
    const target = plugins.find((plugin) => plugin.name === name)
    // 只有含 host 半的插件由 bundles 控制；纯 client 插件随宿主 bundle 加载，禁不掉。
    if (target === undefined || !target.hasHostSide) {
      throw new InstanceStoreError('invalid-input', '该插件不含 host 半，无法单独禁用')
    }
    const exemption = enabled
      ? await grantEnableExemption(instance, profileDir, name, target.version, resolved)
      : null

    const state = await stateStore.read(instance.id)
    const bundleIndex = { ...state.bundleIndex }
    let insertAt: number | undefined
    if (enabled) {
      insertAt = bundleIndex[name]
    } else {
      const at = bundles.indexOf(name)
      if (at >= 0) bundleIndex[name] = at
    }
    await bundleStore.setEnabled(profileDir, name, enabled, insertAt)
    // 手动重新启用后不再是「待处理」的自动禁用项：状态与界面提示条同步清除该插件。
    const autoDisabled = enabled
      ? state.autoDisabled.filter((item) => item.name !== name)
      : state.autoDisabled
    await stateStore
      .write(instance.id, { ...state, bundleIndex, autoDisabled })
      .catch((error: unknown) => console.error('[plugin] 写入插件检查状态失败：', error))
    // 启用/禁用走 dsh 的默认规则：有 HMR 即热生效，否则需重启。
    const hmr = await hmrAvailable(instance, profileDir, bundles)
    return { name, enabled, application: defaultApplication(hmr), exemptionGranted: exemption }
  }

  return {
    async list(instance, locale = 'zh'): Promise<PluginInfo[]> {
      const plugins = await listPlugins(instance, locale, await resolveDshEntry(instance))
      const state = await stateStore.read(instance.id)
      // 回填已装版本的发布时间：只认版本号与当前已装版本一致的快照——升级换版本后旧快照不再匹配，
      // 该字段回到「未获取」，直到下次检查写入新版本的发布时间。
      return plugins.map((plugin) => {
        const snapshot = state.published[plugin.name]
        return { ...plugin, publishedAt: snapshot?.version === plugin.version ? snapshot.at : null }
      })
    },

    async check(instance, name): Promise<PluginUpdateCheck> {
      const done = markChecking(instance.id, name)
      try {
        const resolved = await resolveDshEntry(instance)
        const plugins = await listPlugins(instance, 'zh', resolved)
        const current = plugins.find((plugin) => plugin.name === name)
        if (!current) throw new Error(`插件未安装：${name}`)
        // view 联网取 latest 的版本、dsh peer 与各版本发布时间（time 是「版本 → 发布时刻」映射，
        // 已装版本的发布时间取自已装版本那一项，latest 的那项不用）。固定按默认安装源，与安装同源。
        let result: CommandResult
        try {
          result = await runPlugin(
            instance,
            ['view', name, 'version', 'peerDependencies', 'time', '--json'],
            resolved,
            DEFAULT_PLUGIN_REGISTRY
          )
        } catch (error) {
          // 插件未发布到 npm registry（如本地 file:/link: 安装但未发布）：pnpm view 会 404，
          // 给出明确文案说明原因，而非透出裸 pnpm stderr。
          if (isRegistryNotFound(error)) {
            throw new InstanceStoreError(
              'not-found',
              `无法检查更新：插件 ${name} 未发布到 npm registry（本地安装的包不在 registry 中）`
            )
          }
          throw error
        }
        let meta: {
          version?: string
          peerDependencies?: Record<string, string>
        }
        try {
          meta = JSON.parse(result.stdout || '{}')
        } catch {
          throw new Error('无法解析插件版本信息输出')
        }
        const latest = meta.version ?? current.version
        const peers = meta.peerDependencies ?? {}
        // 展示用的 dsh 兼容范围：主包优先，否则取 dsh 子包的（锁步）公共范围——
        // 只读主包会在只声明子包的插件上显示成空「dsh —」。
        const dshPeer = dshPeerRange(peers)
        // 按**实际执行命令的** dsh 版本判定，与安装闸同口径：注册表字段可能与真正运行的副本不一致。
        const dshVersion = resolved.version
        // 与 dsh 加载器同口径：主包与全部 @deepseek-ai/dsh-* 子包 peer 都要满足运行时版本，
        // 任一不满足即不兼容（0.24.1 的子包锁 ^0.2.0-rc.1，实例 0.1.7-rc.2 会被拦）。
        const compatible = peersCompatible(peers, dshVersion)
        // 按版本序判定：已装版本高于候选（如手动装了更新版）不算「有更新」。
        const hasUpdate = compareDshVersions(current.version, latest) < 0
        const published = publishedTimeMap(result.stdout)?.[current.version]
        const publishedAt = typeof published === 'string' && published !== '' ? published : null
        // 落盘：有新版留下标记，已是最新清掉该项（标记只在再次检查或升级时变化）；
        // 发布时间按「已装版本」存快照，未收录该版本时保留原快照。
        await persistCheck(
          instance.id,
          name,
          hasUpdate ? { current: current.version, latest, compatible, dshPeer, dshVersion } : null,
          publishedAt !== null ? { version: current.version, at: publishedAt } : null
        )
        return { name, current: current.version, latest, hasUpdate, compatible, dshPeer, dshVersion, publishedAt }
      } finally {
        done()
      }
    },

    async checkState(instance): Promise<PluginCheckSnapshot> {
      const state = await stateStore.read(instance.id)
      return {
        lastCheckedAt: state.lastCheckedAt,
        updates: state.updates,
        checking: [...(inFlightChecks.get(instance.id) ?? [])],
        autoDisabled: state.autoDisabled
      }
    },

    async setEnabled(instance, name, enabled): Promise<PluginEnableResult> {
      const { home, profile } = homeAndProfile(instance)
      return applyEnabled(instance, join(home, 'profiles', profile), name, enabled)
    },

    async reconcileRuntime(instance, runtimeVersion): Promise<RuntimeReconcileResult> {
      const state = await stateStore.read(instance.id)
      if (state.runtimeVersion === runtimeVersion) return { checked: false, disabled: [] }

      const { home, profile } = homeAndProfile(instance)
      const profileDir = join(home, 'profiles', profile)
      const profileBundles = await bundleStore.read(profileDir)
      // profile 尚未初始化（实例从未真正启动过）：只记下版本，不做判定。
      if (profileBundles === null) {
        await stateStore
          .write(instance.id, { ...state, runtimeVersion, autoDisabled: [] })
          .catch((error: unknown) => console.error('[plugin] 写入插件检查状态失败：', error))
        return { checked: false, disabled: [] }
      }

      const profileNodeModules = join(profileDir, 'node_modules')
      const bundleIndex = { ...state.bundleIndex }
      const disabled: AutoDisabledPlugin[] = []
      for (const name of profileBundles.dependencies) {
        if (!profileBundles.bundles.includes(name)) continue
        const manifestDir = join(profileNodeModules, ...name.split('/'))
        const manifest = readManifest(manifestDir)
        const patch = manifest?.dsh?.bundle?.patch
        // 只核对由 bundles 加载的 host 半插件（纯 client 插件不由清单控制）。
        if (manifest === null || typeof patch !== 'string' || patch === '') continue
        const peers = manifest.peerDependencies ?? {}
        if (Object.keys(evaluateDshPeers(peers, runtimeVersion)).length === 0) continue
        const at = profileBundles.bundles.indexOf(name)
        if (at >= 0) bundleIndex[name] = at
        try {
          await bundleStore.setEnabled(profileDir, name, false)
        } catch (error) {
          // 单个插件写失败（例如锁竞争）不影响其它插件，也不阻断实例启动。
          console.error('[plugin] 自动禁用不兼容插件失败：', name, error)
          continue
        }
        disabled.push({ name, version: manifest.version ?? '—', dshVersion: runtimeVersion })
      }

      await stateStore
        .write(instance.id, { ...state, runtimeVersion, bundleIndex, autoDisabled: disabled })
        .catch((error: unknown) => console.error('[plugin] 写入插件检查状态失败：', error))
      return { checked: true, disabled }
    },

    async resolveInstall(instance, spec, options = {}): Promise<PluginInstallPlan> {
      const input = spec.trim()
      const kind = classifyPluginSpec(input)
      // github/file：不联网也不读盘，目标版本与兼容性都无从判定（null），只规范化展示来源。
      if (kind !== 'npm') {
        return {
          installSpec: input,
          input,
          kind,
          packageName: null,
          targetVersion: null,
          latestVersion: null,
          versionSource: 'none',
          publishedAt: null,
          dshPeer: null,
          dshVersion: null,
          compatible: null,
          installedVersion: null
        }
      }

      const registry = options.registry ?? DEFAULT_PLUGIN_REGISTRY
      const resolved = await resolveDshEntry(instance)
      const { name, requested } = splitNpmSpec(input)
      const installedVersion = installedVersionOf(await listPlugins(instance, 'zh', resolved), name)

      // 用户显式指定了精确版本：只查该版本的 peer 与发布时间（同时校验它确实存在）。
      if (requested !== null && isVersionLiteral(requested)) {
        const { peers, publishedAt } = await viewVersionMeta(
          instance,
          name,
          requested,
          resolved,
          registry
        )
        return {
          installSpec: `${name}@${requested}`,
          input,
          kind: 'npm',
          packageName: name,
          targetVersion: requested,
          latestVersion: null,
          versionSource: 'requested',
          publishedAt,
          dshPeer: dshPeerRange(peers),
          dshVersion: resolved.version,
          compatible: peersCompatible(peers, resolved.version),
          installedVersion
        }
      }

      // 裸名或 dist-tag：一次查询拿版本集合、dist-tags、peer 与发布时间（多字段时 time 嵌套在
      // `time` 键下，publishedTimeMap 兼容两种形状）。
      let result: CommandResult
      try {
        result = await runPlugin(
          instance,
          ['view', name, 'version', 'versions', 'dist-tags', 'peerDependencies', 'time', '--json'],
          resolved,
          registry
        )
      } catch (error) {
        if (isRegistryNotFound(error)) {
          throw new InstanceStoreError('not-found', `无法解析版本：插件 ${name} 未发布到 npm registry`)
        }
        throw error
      }
      const meta = parseViewMeta(result.stdout)
      const distTags = recordOf(meta['dist-tags'])
      const latestVersion =
        typeof distTags.latest === 'string' && distTags.latest !== '' ? distTags.latest : null
      const viewed = typeof meta.version === 'string' && meta.version !== '' ? meta.version : null

      let target: string
      let versionSource: PluginVersionSource
      if (requested !== null && requested !== 'latest') {
        // 具名 dist-tag（next / beta…）：装该标签指向的版本，用户要的就是这个渠道。
        const tagged = distTags[requested]
        if (typeof tagged !== 'string' || tagged === '') {
          throw new InstanceStoreError('not-found', `registry 没有标签 ${requested}：${name}`)
        }
        target = tagged
        versionSource = 'requested'
      } else {
        // 未指定版本，或写的就是 `latest`：`latest` 只是「最新」的惯用写法，与裸名同口径
        // 取「dist-tag latest 与最大稳定版的较大者」——dist-tag 滞后时不能装到旧版。
        const picked = pickTargetVersion(stringArrayOf(meta.versions), latestVersion, viewed)
        if (picked === null) throw new InstanceStoreError('internal', '无法解析插件版本信息输出')
        target = picked
        versionSource = requested === null ? 'resolved-latest' : 'requested'
      }

      // peer 与发布时间必须是目标版本的口径：与本次查询返回的版本不一致时补一次查询。
      let peers = peerMapOf(meta)
      let publishedAt = publishedAtOf(publishedTimeMap(result.stdout), target)
      if (target !== viewed) {
        const detail = await viewVersionMeta(instance, name, target, resolved, registry)
        peers = detail.peers
        publishedAt = detail.publishedAt
      }

      return {
        installSpec: `${name}@${target}`,
        input,
        kind: 'npm',
        packageName: name,
        targetVersion: target,
        latestVersion,
        versionSource,
        publishedAt,
        dshPeer: dshPeerRange(peers),
        dshVersion: resolved.version,
        compatible: peersCompatible(peers, resolved.version),
        installedVersion
      }
    },

    async packageInfo(instance, name, version): Promise<PluginPackageInfo> {
      const resolved = await resolveDshEntry(instance)
      const fallbackPageUrl = npmUrlFrom(name)
      // 仓库地址与下载量互不依赖，并发取；两者取不到都按「没有」处理，不影响安装确认。
      const [downloads, repoUrl] = await Promise.all([
        packageInfoFetchers.fetchDownloads(name),
        resolveRepositoryUrl(instance, name, version, resolved)
      ])
      const releaseNotes =
        repoUrl === null
          ? { text: null, source: 'none' as const, pageUrl: fallbackPageUrl, truncated: false }
          : await packageInfoFetchers.fetchReleaseNotes({ repoUrl, version, fallbackPageUrl })
      return { downloads, releaseNotes }
    },

    async install(instance, spec, options = {}): Promise<PluginMutationResult> {
      const registry = options.registry ?? DEFAULT_PLUGIN_REGISTRY
      const { home, profile } = homeAndProfile(instance)
      const profileDir = join(home, 'profiles', profile)
      const before = await bundleStore.read(profileDir)
      // 安装前该包名已在 dependencies 里 = 替换/升级/重装已装包：dsh 对此无条件要求重启
      // （Node 模块缓存无法为已加载的包载入新模块代），只有全新包名才能 HMR 即装即用。
      const replaced = before !== null && before.dependencies.some((name) => specMatchesName(spec, name))

      const resolved = await resolveDshEntry(instance)
      await runPlugin(instance, ['add', spec], resolved, registry)
      const plugins = await listPlugins(instance, 'zh', resolved)
      const hasHostSide = plugins.some((plugin) => plugin.hasHostSide && specMatchesName(spec, plugin.name))
      // 「安装后启用」缺省勾选，与 dsh 默认行为一致；取消时按真实包名把包移出加载清单
      // （add 已把包写进 bundles），保留 dependency → 列表显示「已禁用」。
      // 纯 client 插件不由清单控制，标识不出可禁用的包，无需额外动作。
      const installed = plugins.find((plugin) => specMatchesName(spec, plugin.name))
      if (options.enable === false && installed !== undefined && installed.hasHostSide) {
        await applyEnabled(instance, profileDir, installed.name, false, { resolved, plugins })
      }
      const after = await bundleStore.read(profileDir)
      const hmr = await hmrAvailable(instance, profileDir, after?.bundles ?? before?.bundles ?? null)
      return {
        hasHostSide,
        application: replaced ? 'restart-required' : defaultApplication(hmr)
      }
    },

    async upgrade(instance, name, version): Promise<PluginMutationResult> {
      const resolved = await resolveDshEntry(instance)
      const hadHostSide = await hostSideOf(instance, name, resolved)
      // 升级与 check 同源：固定按默认安装源追加 --registry。
      await runPlugin(instance, ['add', `${name}@${version}`], resolved, DEFAULT_PLUGIN_REGISTRY)
      // 升级换了版本：清掉可升级标记，并同步落下新版本的发布时间快照（无需再次检查即可显示）。
      await syncCheckAfterUpgrade(instance, name, resolved)
      // 升级必然替换已装包 → 与 dsh 同口径：即使有 HMR 也要重启才能换掉已加载的模块代。
      return {
        hasHostSide: hadHostSide || (await hostSideOf(instance, name, resolved)),
        application: 'restart-required'
      }
    },

    async remove(instance, name): Promise<PluginMutationResult> {
      const { home, profile } = homeAndProfile(instance)
      const profileDir = join(home, 'profiles', profile)
      const before = await bundleStore.read(profileDir)
      const resolved = await resolveDshEntry(instance)
      // 卸载前先判 host 半（卸载后包已不在，读不到元数据）。
      const hasHostSide = await hostSideOf(instance, name, resolved)
      await runPlugin(instance, ['remove', name], resolved)
      // 卸载后该插件的检查痕迹（可升级标记、发布时间快照）不再有意义。
      await dropCheck(instance.id, name)
      // 卸载走 dsh 的默认规则（无「替换已装包」特例）：有 HMR 即热卸载，否则需重启。
      const hmr = await hmrAvailable(instance, profileDir, before?.bundles ?? null)
      return { hasHostSide, application: defaultApplication(hmr) }
    }
  }
}

/**
 * 解析 `dsh plugin view … time --json` 的输出为「版本 → 发布时刻」映射；解析失败或不是对象返回 null。
 * 输出形状随查询字段而变：多字段查询（check）嵌套在 `time` 键下，仅查 time 时是裸映射
 * （额外含 created/modified 两项，按键取版本值时天然跳过）。
 */
function publishedTimeMap(stdout: string): Record<string, string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || '{}')
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const nested = (parsed as { time?: unknown }).time
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, string>
  }
  return parsed as Record<string, string>
}

/** spec 是否指向给定包名（近似：spec 前缀去掉 @version / 协议后与包名相等或以其结尾）。 */
function specMatchesName(spec: string, name: string): boolean {
  const trimmed = spec.trim()
  if (trimmed === name) return true
  // name@version：剥掉版本段（保留 scoped 前缀的 @）。
  const at = trimmed.lastIndexOf('@')
  if (at > 0 && trimmed.slice(0, at) === name) return true
  // github:owner/repo 或 file:path：无法从 spec 精确得包名，宽松匹配结尾。
  return trimmed.endsWith(name)
}

/** 脚本同目录探测真实 node；找不到返回 null（由调用方回退 Electron 兜底）。 */
function defaultResolveNode(scriptPath: string): string | null {
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const sameDir = join(dirname(scriptPath), nodeName)
  return existsSync(sameDir) ? sameDir : null
}
