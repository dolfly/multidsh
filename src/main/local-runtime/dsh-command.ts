/**
 * dsh 命令行形态判定：这一行命令是不是一次 **dsh web profile 启动**。
 *
 * 只回答「命令行长什么样」，不碰进程表、不碰端口 —— 进程表与端口的判定在
 * `dsh-processes.ts` 与 `listening-ports.ts`。全部是纯函数，便于穷举测试。
 *
 * 认得的形态：
 * - `dsh web …` —— 旧形态，web 是位置参数；
 * - `dsh --profile web …` / `dsh --profile=web …` —— 当前形态；
 * - 入口可以是 `…/dsh`、`…/dsh.js`、`…/@deepseek-ai/dsh/lib/bin.js`。
 *
 * **不认 dush / duush 包装器**：它们自己 spawn 一个 dsh 子进程去提供工作区，
 * 监听端口由那个 dsh 持有；包装器自己可能另开本地服务端口（登录、采集等），
 * 把它当可接管对象会把用户引到错误的端口上。dush/duush 因此是被间接支持的 ——
 * 它们拉起的那个 dsh 进程会被认出来。
 */

/**
 * 判断一个命令行 token 是不是 dsh 入口脚本。
 *
 * 只认真正的 dsh:`…/dsh`、`…/dsh.js`、以及 npm 全局包的 `@deepseek-ai/dsh/lib/bin.js`。
 * 以「token 结尾」判定而非「包含」:`dsh-hub-desktop/out/main/index.js` 目录名带 dsh
 * 也不能被当成入口。
 */
function isDshEntryToken(token: string): boolean {
  const normalized = token.replace(/\\/g, '/')
  if (normalized.endsWith('@deepseek-ai/dsh/lib/bin.js')) return true
  return normalized.endsWith('/dsh') || normalized.endsWith('/dsh.js')
}

/**
 * 裸名 token(`dsh` / `dsh.js`,无路径分隔符)是否可作 dsh 入口。
 *
 * 只有紧跟在 node 可执行文件之后才算:`node dsh --profile web` 是入口,
 * 而 `npm run dsh -- --profile web` 里的 `dsh` 是脚本名,不是入口。
 */
function isBareDshToken(token: string, previous: string | undefined): boolean {
  if (token !== 'dsh' && token !== 'dsh.js') return false
  if (previous === undefined) return false
  const base = previous.replace(/\\/g, '/').split('/').pop() ?? ''
  return base === 'node' || base === 'node.exe'
}

/**
 * 排除 shell / grep 包装行:它们把 `dsh web` 当参数,直接匹配会误报。
 *
 * 按**词**判定而非子串:`--patch /tmp/my-grep.yml` 里的 "grep" 不是 grep 命令,
 * 不能因此把真的 dsh 进程排除掉。
 */
function isShellWrapper(tokens: string[]): boolean {
  const first = tokens[0]?.replace(/\\/g, '/').split('/').pop() ?? ''
  if (['bash', 'sh', 'zsh', 'fish', 'ps', 'grep', 'pgrep', 'rg'].includes(first)) return true
  // 绝对路径形态的包装器(/usr/bin/pgrep -f …/dsh web):命令词出现在中间位置。
  // 只看 dsh 入口之前的那一段:入口之后的 token 是 dsh 自己的参数,
  // `--patch /home/u/grep` 这类取值不能把整个进程误判成 grep 包装行。
  const entryIndex = tokens.findIndex((token) => isDshEntryToken(token))
  const head = entryIndex < 0 ? tokens : tokens.slice(0, entryIndex)
  return head.some((token) => {
    const base = token.replace(/\\/g, '/').split('/').pop() ?? ''
    return base === 'grep' || base === 'pgrep'
  })
}

/**
 * 从 dsh 入口之后的参数里判定这是不是一次 **web profile 启动**。
 *
 * 形态:
 * - `dsh web …` —— 旧形态,web 是位置参数;
 * - `dsh --profile web …` / `dsh --profile=web …` —— 当前形态;
 * - `dsh plugin --profile web …` —— 插件管理命令,不提供工作区,必须排除
 *   (Hub 自己执行插件命令也走这个形态)。
 */
function isWebProfileArgs(args: string[]): boolean {
  if (args[0] === 'plugin') return false
  if (args[0] === 'web') return true
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (arg === '--profile') return (args[i + 1] ?? '').toLowerCase() === 'web'
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length).toLowerCase() === 'web'
  }
  return false
}

/**
 * 定位命令行里的 dsh web 调用:返回 dsh 入口之后的参数。
 * 不是 dsh web 调用(不是 dsh 入口 / 非 web profile / 插件管理命令)返回 null。
 */
export function findDshWebArgs(command: string): string[] | null {
  const tokens = command.split(/\s+/).filter((token) => token !== '')
  if (isShellWrapper(tokens)) return null
  let entryIndex = -1
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? ''
    if (isDshEntryToken(token)) {
      entryIndex = i
      break
    }
    if (isBareDshToken(token, i > 0 ? tokens[i - 1] : undefined)) {
      entryIndex = i
      break
    }
  }
  if (entryIndex < 0) return null
  const args = tokens.slice(entryIndex + 1)
  return isWebProfileArgs(args) ? args : null
}

/** 取 `--patch <v>` / `--patch=<v>` 的值;没有返回 null */
export function patchOf(command: string): string | null {
  const spaced = /(?:^|\s)--patch(?:=|\s+)(\S+)/.exec(command)
  const raw = spaced?.[1]
  if (raw) return raw
  return null
}

/** 取 `--port <v>` / `--port=<v>` 的值;没有/非法返回 null(端口还会由 lsof 兜底) */
export function portOf(command: string): number | null {
  const spaced = /(?:^|\s)--port(?:=|\s+)(\d{1,5})(?:\s|$)/.exec(command)
  const raw = spaced?.[1]
  if (!raw) return null
  const port = Number(raw)
  return port >= 1 && port <= 65_535 ? port : null
}
