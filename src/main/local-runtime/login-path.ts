/**
 * 登录环境 PATH 解析与合并。
 *
 * GUI 启动的 hub 只继承 launchd/启动器给的最小 PATH，用户 shell 配置追加的工具目录
 * （Homebrew、版本管理器、自建 bin 等）不在其中。启动本机实例前把登录环境 PATH 合并进
 * 子进程 PATH，使实例内解析到的工具与用户终端一致。
 *
 * - macOS/Linux：登录 shell 导出（`$SHELL -lc`，自定义 PATH 只有登录环境知道）。
 * - Windows：注册表 User + Machine 的 `Path` 并展开 `%VAR%`（GUI 进程的 PATH 可能被
 *   启动器裁剪，注册表是权威来源）。
 *
 * 解析失败或超时回退继承 PATH；登录 shell / PowerShell 有启动开销，进程内只解析一次。
 */
import { execFileResult } from './exec-file'
import type { CommandRunner } from './exec-file'

/** 输出标记行：rc 文件可能向 stdout 打印噪声，按标记定位真实结果。 */
const MARKER = '__DSH_LOGIN_PATH__'

/** Windows 两段注册表值的分隔标记（Machine 段在前，User 段在后）。 */
const SPLIT_MARKER = '__DSH_LOGIN_PATH_SPLIT__'

const LOGIN_PATH_TIMEOUT_MS = 8_000

const REGISTRY_PATH_SCRIPT = `[Environment]::GetEnvironmentVariable('Path','Machine'); '${SPLIT_MARKER}'; [Environment]::GetEnvironmentVariable('Path','User')`

export interface LoginPathOptions {
  /** 命令执行器（注入便于测试）；缺省用 execFile，带超时。 */
  run?: CommandRunner
  platform?: NodeJS.Platform
  /** `%VAR%` 展开与登录 shell 名的环境来源；缺省 process.env。 */
  env?: NodeJS.ProcessEnv
  /** 登录 shell 可执行文件；缺省 env.SHELL ?? /bin/zsh（仅 macOS/Linux 用到）。 */
  shell?: string
}

/** 解析登录环境 PATH（平台对应分隔符拼接的原始串）；null=不可用（失败、超时、输出不完整）。 */
export async function resolveLoginPath(options: LoginPathOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const run = options.run ?? defaultRun
  try {
    const raw =
      platform === 'win32'
        ? await registryPath(run, env)
        : await loginShellPath(run, env, options.shell)
    return raw === '' ? null : raw
  } catch {
    return null
  }
}

/**
 * 合并登录环境 PATH：登录目录前置（对齐用户终端的解析结果），继承 PATH 的独有目录随后，
 * 去重保序（win32 大小写不敏感、统一分隔符形态比较）。login 为空时原样返回 base。
 */
export function mergeLoginPath(
  base: string,
  login: string | null,
  platform: NodeJS.Platform = process.platform
): string {
  if (login === null || login.trim() === '') return base
  const separator = platform === 'win32' ? ';' : ':'
  const keyOf = (dir: string): string =>
    platform === 'win32' ? dir.replace(/\//g, '\\').toLowerCase() : dir
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const raw of [...login.split(separator), ...base.split(separator)]) {
    const dir = platform === 'win32' ? raw.trim() : raw
    if (dir === '') continue
    const key = keyOf(dir)
    if (seen.has(key)) continue
    seen.add(key)
    dirs.push(dir)
  }
  return dirs.join(separator)
}

/**
 * 可失效的进程内缓存解析器：`()` 取值（首次解析后缓存，失败也缓存为 null），
 * `.invalidate()` 清掉缓存令下次取值重新解析。用于「用户装了新工具后无需重启 app
 * 即可让下次启动的实例解析到新 PATH」。
 */
export interface CachedResolver<T> {
  (): Promise<T>
  /** 清空缓存，下次调用重新解析。 */
  invalidate(): void
  /** 只读已缓存的解析结果；尚未解析（或已被失效）返回 undefined，不触发新解析。 */
  peek?(): Promise<T> | undefined
}

/** 进程内缓存的解析器：解析有启动开销，结果只在应用生命周期内有意义；失败同样缓存为 null。 */
export function createLoginPathResolver(
  probe: () => Promise<string | null>
): CachedResolver<string | null> {
  let cached: Promise<string | null> | null = null
  const resolver = (): Promise<string | null> => {
    cached ??= probe().catch(() => null)
    return cached
  }
  resolver.invalidate = (): void => {
    cached = null
  }
  resolver.peek = (): Promise<string | null> | undefined => cached ?? undefined
  return resolver
}

/** 缺省解析器（真实登录 shell / 注册表）；进程内只解析一次。 */
export const resolveLoginPathOnce = createLoginPathResolver(() => resolveLoginPath())

/** 登录 shell 导出 PATH：printf 打标记行，rc 噪声不影响提取。 */
async function loginShellPath(
  run: CommandRunner,
  env: NodeJS.ProcessEnv,
  shell?: string
): Promise<string | null> {
  const loginShell = shell ?? env['SHELL'] ?? '/bin/zsh'
  const result = await run(loginShell, ['-lc', `printf '%s\\n' '${MARKER}='"$PATH"`])
  if (result.code !== 0) return null
  for (const line of result.stdout.split('\n')) {
    const at = line.indexOf(`${MARKER}=`)
    if (at >= 0) return line.slice(at + MARKER.length + 1).trim()
  }
  return null
}

/** Windows：注册表 User + Machine 的 Path；单侧缺失只取非空一侧。 */
async function registryPath(run: CommandRunner, env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    REGISTRY_PATH_SCRIPT
  ])
  if (result.code !== 0) return null
  const at = result.stdout.indexOf(SPLIT_MARKER)
  if (at < 0) return null
  const machine = expandVars(result.stdout.slice(0, at), env)
  const user = expandVars(result.stdout.slice(at + SPLIT_MARKER.length), env)
  return [machine, user].filter((part) => part !== '').join(';')
}

/** 展开 `%VAR%`（注册表 REG_EXPAND_SZ 原值不带展开）；未知变量原样保留。 */
function expandVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.trim().replace(/%([^%]+)%/g, (whole, name: string) => lookupEnv(env, name) ?? whole)
}

/** 变量名大小写不敏感查找（Windows 环境变量语义）；已展开的值里不会再有 %VAR%。 */
function lookupEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name]
  if (direct !== undefined) return direct
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && key.toLowerCase() === lower) return value
  }
  return undefined
}

const defaultRun: CommandRunner = (command, args) =>
  // 启动失败与超时/信号终止 reject；执行失败（非零退出）由调用方看退出码
  execFileResult(command, args, { timeout: LOGIN_PATH_TIMEOUT_MS, maxBuffer: 1024 * 1024 })
