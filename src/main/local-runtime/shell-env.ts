/**
 * 本机实例的登录 shell 环境解析与合并。
 *
 * GUI 启动（Finder/Dock/launchd）的 hub 只继承最小环境，用户 shell 配置文件里 export
 * 的变量（代理、token、工具配置等）不在其中。启动本机实例前用当前用户的登录 shell 把它
 * 解析完全部启动文件后的最终环境导出，合并进子进程环境，使实例内的环境与用户终端一致。
 *
 * - 登录 shell 取 `os.userInfo().shell`（passwd 权威来源），回退 `$SHELL`。
 * - 只支持 zsh 与 bash（basename 判定）；其它 shell 返回 null，由调用方回退到仅解析 PATH。
 * - `-l -i` 同时 source 登录与交互启动文件（`.zshrc`/`.bashrc` 仅交互 shell 加载）。
 * - hub 自行注入或管理的键（DSH_HOME 等）不接受 shell 环境覆盖。
 * - 解析失败或超时返回 null；登录 shell 有启动开销，进程内只解析一次。
 */
import { userInfo } from 'node:os'
import { basename } from 'node:path'
import { execFileResult } from './exec-file'
import type { CommandRunner } from './exec-file'
import { mergeLoginPath, type CachedResolver } from './login-path'

/** 仅这些 shell 支持 `-l -i -c` 与 POSIX `export` 语义；其它 shell（fish/nu）回退仅 PATH。 */
const SUPPORTED_SHELLS = new Set(['zsh', 'bash'])

/**
 * 本机实例启动段由 hub 自行注入或删除的键，不接受登录 shell 环境覆盖：这些键的最终值在
 * 合并之后显式写入（DSH_HOME、DSH_BIN）、删除（dush/duush 的 DUSH_PATCH_FILE）或必须保持
 * 未设置（真实 node 路径下的 ELECTRON_RUN_AS_NODE），若允许 shell 环境带进来会造成中间态
 * 混乱（loader 重复加载、DSH_HOME 指向用户全局目录、真实 node 误吃降级开关）。
 */
export const PROTECTED_KEYS = new Set([
  'DSH_HOME',
  'DSH_BIN',
  'DUSH_PATCH_FILE',
  'ELECTRON_RUN_AS_NODE'
])

/** 登录 shell 启动有开销（rc 噪声、插件、compinit），限制等待上限；超时按未解析处理。 */
const SHELL_ENV_TIMEOUT_MS = 8_000

/** env 输出可能较大（大量导出变量）；与 login-path 一致取 1MB。 */
const SHELL_ENV_MAX_BUFFER = 1024 * 1024

export interface ShellEnvOptions {
  /** 命令执行器（注入便于测试）；缺省用 execFile，带超时。 */
  run?: CommandRunner
  platform?: NodeJS.Platform
  /** 登录 shell 可执行文件；缺省 os.userInfo().shell ?? $SHELL ?? /bin/zsh。 */
  shell?: string
}

/** 当前用户的登录 shell：passwd 数据库权威，回退 $SHELL，再回退 /bin/zsh。 */
function resolveLoginShell(): string {
  try {
    const info = userInfo()
    if (typeof info.shell === 'string' && info.shell !== '') return info.shell
  } catch {
    // 某些无 passwd 记录的环境 userInfo 会抛，回退环境变量
  }
  return process.env['SHELL'] ?? '/bin/zsh'
}

/**
 * 用当前用户的登录 shell 解析其完整环境；null=不可用（非 zsh/bash、失败、超时、无输出）。
 *
 * `env -0` 是外部程序，输出 `KEY=VALUE\0...`，与 shell 语法无关；`\0` 分隔避免值含换行或
 * 等号被截断。`env` 交给 shell 自行在 PATH 中解析，兼容 env 不在 /usr/bin 的系统。
 */
export async function resolveShellEnv(
  options: ShellEnvOptions = {}
): Promise<Map<string, string> | null> {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') return null
  const shell = options.shell ?? resolveLoginShell()
  if (!SUPPORTED_SHELLS.has(basename(shell))) return null
  const run = options.run ?? defaultRun
  try {
    const result = await run(shell, ['-l', '-i', '-c', 'env -0'])
    if (result.code !== 0) return null
    return parseNullDelimitedEnv(result.stdout)
  } catch {
    return null
  }
}

/** 解析 `env -0` 的 `KEY=VALUE\0...` 输出；跳过无 `=` 或空 key 的段。 */
function parseNullDelimitedEnv(stdout: string): Map<string, string> | null {
  const map = new Map<string, string>()
  for (const segment of stdout.split('\0')) {
    if (segment === '') continue
    const at = segment.indexOf('=')
    if (at <= 0) continue
    map.set(segment.slice(0, at), segment.slice(at + 1))
  }
  return map.size > 0 ? map : null
}

/**
 * 把登录 shell 环境合并进 base：shell 值覆盖或新增（代表用户意图），受保护键跳过，
 * PATH 走 `mergeLoginPath`（登录目录前置、去重保序）而非整体替换。shellEnv 为 null 时原样返回 base。
 */
export function mergeShellEnv(
  base: NodeJS.ProcessEnv,
  shellEnv: Map<string, string> | null,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  if (shellEnv === null) return { ...base }
  const merged: NodeJS.ProcessEnv = { ...base }
  for (const [key, value] of shellEnv) {
    if (PROTECTED_KEYS.has(key)) continue
    if (key === 'PATH') continue
    merged[key] = value
  }
  const shellPath = shellEnv.get('PATH')
  if (shellPath !== undefined) {
    merged.PATH = mergeLoginPath(base.PATH ?? '', shellPath, platform)
  }
  return merged
}

/**
 * 进程内缓存的解析器：解析有启动开销，结果只在应用生命周期内有意义；失败同样缓存为 null。
 * `.invalidate()` 清掉缓存令下次取值重新解析（用户装了新工具后无需重启 app 即可生效）。
 */
export function createShellEnvResolver(
  probe: () => Promise<Map<string, string> | null>
): CachedResolver<Map<string, string> | null> {
  let cached: Promise<Map<string, string> | null> | null = null
  const resolver = (): Promise<Map<string, string> | null> => {
    cached ??= probe().catch(() => null)
    return cached
  }
  resolver.invalidate = (): void => {
    cached = null
  }
  resolver.peek = (): Promise<Map<string, string> | null> | undefined => cached ?? undefined
  return resolver
}

/** 缺省解析器（真实登录 shell）；进程内只解析一次。 */
export const resolveShellEnvOnce = createShellEnvResolver(() => resolveShellEnv())

const defaultRun: CommandRunner = (command, args) =>
  execFileResult(command, args, {
    timeout: SHELL_ENV_TIMEOUT_MS,
    maxBuffer: SHELL_ENV_MAX_BUFFER
  })
