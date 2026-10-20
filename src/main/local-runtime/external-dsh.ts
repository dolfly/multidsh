/**
 *
 * 用户场景:用户自己常驻一个 dsh web(用 dsh / dush / duush 任一启动器拉起)
 *   dsh   --profile web --port 3080 --no-open
 *   dush  --profile web --port 3080 --no-open   (dush 包装器再 spawn dsh)
 *   duush --profile web --port 3080 --no-open
 * 于是「已经跑着的实例」既不被识别、也无法直接用视图打开。
 *
 * 三种启动器一视同仁:包装器(dush/duush)自己 spawn 一个 dsh 子进程去提供工作区,
 * **监听端口由那个 dsh 持有**,所以探测对象是 dsh 进程 —— 用 dush/duush 起也一样
 * 能被认出来(包装器本身不当可接管对象,见 isDshEntryToken)。
 *
 * 本模块只做**只读探测**:POSIX 下 `ps` 找 dsh 进程,再由 `lsof` 确认该 PID
 * 的监听端口;Windows 下 `Get-CimInstance` 找进程,再由 `netstat` 确认监听端口。
 *
 * **Hub 自己拉起的实例必须排除**:Hub spawn 的实例与用户手敲的 dsh 命令行完全同形
 * (同为 `dsh --profile web …`),命令行判定无法区分二者,只能靠进程树 —— Hub 主进程
 * 子树里的 dsh 全是 Hub 自己管的实例(启动器包装器与其再 spawn 的 dsh 两层都在其中)。
 *
 * 解析函数是纯函数(便于穷举测试),IO 全部可注入。
 */
import { execFile } from 'node:child_process'
import { isLoopbackHost } from '@shared/endpoint'
import { redactLine, redactSecret } from '@shared/redact'
import {
  collectDescendants,
  parseProcessTable,
  parseWindowsProcessTable,
  type ProcessEntry
} from './process-table'

/** 探测到的一个外部 dsh web 进程 */
export interface ExternalDshWeb {
  pid: number
  /** 父进程 pid;用于判定该进程是否由 Hub 自己拉起 */
  ppid: number
  /** 监听端口;null = 未能确定(无 --port 且 lsof 未给出) */
  port: number | null
  /** `--patch <file>` 的取值(如 ~/.dush/cordis.dush.patch.yml);null = 未使用 patch */
  patch: string | null
  /** 命令行(已折叠空白、截断并脱敏,仅供展示) */
  command: string
}

const PS_TIMEOUT_MS = 5_000
const LSOF_TIMEOUT_MS = 5_000
const WIN_PS_TIMEOUT_MS = 30_000
const NETSTAT_TIMEOUT_MS = 10_000
/** 展示用命令行的最大长度(避免 UI 被超长命令行撑破) */
const COMMAND_DISPLAY_MAX = 240
/**
 * 进程查询输出的字节上限。
 *
 * POSIX 的 `ps` 输出整棵进程表,Windows 的 CIM 查询还要带上完整命令行,
 * 两边都可能超出 Node 的默认 maxBuffer(1MB);超限时 execFile 会 kill 子进程并
 * 回调 error,扫描随之失败。Windows 侧尤其危险:全量进程表的命令行体积远大于
 * POSIX,1MB 会被正常机器的进程数轻易撑破。
 */
const PROCESS_TABLE_MAX_BUFFER = 16 * 1024 * 1024

/**
 * Windows 进程查询:输出 `<pid>\t<ppid>\t<command>` 行。
 *
 * 必须带出父进程 pid:排除 Hub 自己拉起的实例靠进程树,不靠命令行。
 * 命令行原样保留换行(`-e` 脚本等含换行的 argv 会把条目断成多行,
 * `dsh web` 落在无 pid 的续行上被解析器丢弃);输出前把换行/制表符折叠成空格。
 *
 * **不按命令行过滤**:祖先链必须完整 —— dush/duush 包装器的路径不含 "dsh",
 * 只回传含 dsh 的进程会让包装器这一层缺失,它的 dsh 子进程就接不回 Hub 主进程,
 * Hub 自己的实例反而会被当成外部实例上报。Get-CimInstance 本来就要取全表,
 * 过滤只发生在 PowerShell 侧,省不下查询成本,却会丢掉进程树。
 */
export const WIN_PROCESS_SCRIPT =
  'Get-CimInstance Win32_Process | ' +
  'ForEach-Object { [string]$_.ProcessId + [char]9 + [string]$_.ParentProcessId + [char]9 + ' +
  "($_.CommandLine -replace '[\\r\\n\\t]+', ' ') }"

/**
 * 判断一个命令行 token 是不是 dsh 入口脚本。
 *
 * 只认真正的 dsh:`…/dsh`、`…/dsh.js`、以及 npm 全局包的 `@deepseek-ai/dsh/lib/bin.js`。
 * 以「token 结尾」判定而非「包含」:`dsh-hub-desktop/out/main/index.js` 目录名带 dsh
 * 也不能被当成入口。
 *
 * **不认 dush / duush 包装器**:它们自己 spawn 一个 dsh 子进程去提供工作区,
 * 监听端口由那个 dsh 持有;包装器自己可能另开本地服务端口(登录、采集等),
 * 把它当可接管对象会把用户引到错误的端口上。dush/duush 因此是被间接支持的 ——
 * 它们拉起的那个 dsh 进程会被认出来。
 */
export function isDshEntryToken(token: string): boolean {
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

/**
 * 判断一行命令是不是「本机在跑的 dsh web」。
 *
 * 覆盖 dsh / dush / duush 三种启动器:三者最终都跑起一个 dsh 入口进程
 * (dush、duush 是包装器,再 spawn dsh),真正提供工作区的是这个 dsh 进程。
 */
export function isDshWebCommand(command: string): boolean {
  return findDshWebArgs(command) !== null
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

/**
 * 从进程表里挑出 dsh web 进程,并排除 Hub 自己拉起的那些。
 *
 * excludePids 由调用方给出(通常是 Hub 主进程的整棵子树);同一 pid 只上报一次。
 */
export function selectDshWebProcesses(
  entries: ProcessEntry[],
  excludePids: ReadonlySet<number> = new Set()
): ExternalDshWeb[] {
  const found: ExternalDshWeb[] = []
  const seen = new Set<number>()
  for (const entry of entries) {
    if (seen.has(entry.pid) || excludePids.has(entry.pid)) continue
    const args = findDshWebArgs(entry.command)
    if (args === null) continue
    seen.add(entry.pid)
    const argsText = args.join(' ')
    const command =
      entry.command.length > COMMAND_DISPLAY_MAX
        ? `${entry.command.slice(0, COMMAND_DISPLAY_MAX)}…`
        : entry.command
    found.push({
      pid: entry.pid,
      ppid: entry.ppid,
      port: portOf(argsText),
      patch: patchOf(argsText),
      // 命令行原样出到界面会带出用户自己写在参数里的凭据(dsh 的 token/cookie
      // 形态都在命令行上),这里统一脱敏后再交给界面。
      command: redactSecret(redactLine(command))
    })
  }
  return found
}

/**
 * 从多条监听行里为每个 PID 选定端口，优先回环绑定：一个 PID 可能有多条监听
 * （IPv4/IPv6 双栈、多端口）；接管固定连 `127.0.0.1:${port}`，回环优先使选择确定，
 * 而不是取 lsof/netstat 恰好先输出的那条。POSIX 与 Windows 解析共用它。
 * `isLoopbackHost`（@shared/endpoint）负责判定，含 `localhost` / `::1` / `127.x` / `*.localhost`。
 */
function createLoopbackPreferredPicker(): {
  offer: (pid: number, port: number, host: string) => void
  result: () => Map<number, number>
} {
  const ports = new Map<number, number>()
  const loopbackPids = new Set<number>()
  return {
    offer(pid, port, host) {
      // 回环绑定优先：已记录回环端口后不再被覆盖；首个回环端口覆盖此前的非回环记录。
      if (loopbackPids.has(pid)) return
      if (isLoopbackHost(host)) {
        ports.set(pid, port)
        loopbackPids.add(pid)
      } else if (!ports.has(pid)) {
        ports.set(pid, port)
      }
    },
    result: () => ports
  }
}

/**
 * 解析 `lsof -nP -iTCP -sTCP:LISTEN` 输出 → pid → 监听端口（回环优先）。
 * 行形如:`node 84758 <user> 21u IPv4 0x… 0t0 TCP localhost:3080 (LISTEN)`。
 */
export function parseListeningPorts(lsofOutput: string): Map<number, number> {
  const picker = createLoopbackPreferredPicker()
  for (const line of lsofOutput.split('\n')) {
    const match = /^\S+\s+(\d+)\s+.*\sTCP\s+(\S+):(\d+)\s+\(LISTEN\)/.exec(line.trim())
    if (!match) continue
    const pid = Number(match[1])
    const port = Number(match[3])
    if (!Number.isInteger(pid) || port < 1 || port > 65_535) continue
    picker.offer(pid, port, match[2] ?? '')
  }
  return picker.result()
}

/**
 * 解析 `netstat -ano -p tcp` 输出 → pid → TCP 监听端口（回环优先）。
 * 行形如:`  TCP    127.0.0.1:3080    0.0.0.0:0    LISTENING    84758`。
 * UDP 行没有状态列,IPv6 本地地址形如 `[::]:3080`,都按列位与状态过滤。
 */
export function parseWindowsListeningPorts(netstatOutput: string): Map<number, number> {
  const picker = createLoopbackPreferredPicker()
  for (const line of netstatOutput.split('\n')) {
    const columns = line.trim().split(/\s+/)
    if (columns.length < 4) continue
    const [proto, local, , state, pidText] = columns
    if ((proto ?? '').toUpperCase() !== 'TCP') continue
    if ((state ?? '').toUpperCase() !== 'LISTENING') continue
    const localAddr = local ?? ''
    const port = Number(/:(\d+)$/.exec(localAddr)?.[1])
    const pid = Number(pidText)
    if (!Number.isInteger(pid) || pid <= 0) continue
    if (!(port >= 1 && port <= 65_535)) continue
    picker.offer(pid, port, localAddr.replace(/:\d+$/, ''))
  }
  return picker.result()
}

export interface ExternalDshScannerOptions {
  /** 执行器注入(测试用);默认 execFile */
  run?: (command: string, args: string[]) => Promise<{ code: number; stdout: string }>
  platform?: NodeJS.Platform
  /**
   * Hub 主进程 pid。其子树内的 dsh 都是 Hub 自己拉起的实例,不上报为外部实例。
   *
   * **必填**:排除 Hub 托管实例全靠这条进程树规则,取值错了(比如 0)就会把
   * Hub 自己的实例报成外部实例,用户可以「接管」自己的实例 —— 那会让实例状态
   * 从 hub/path 变成 external,停止时不再终止进程。宁可让调用方显式表态。
   */
  hubPid: number
  /**
   * Hub 正在托管的实例所占用的端口。
   *
   * 进程树规则有一处覆盖不到:包装器进程先于它的 dsh 子进程退出时,dsh 的父 pid
   * 被 init 收养(变成 1),就脱离了 Hub 主进程的子树 —— 用户会看到「Hub 自己管的
   * 实例」出现在可接管列表里,接管后停止时不再终止它,进程泄漏。
   *
   * 按端口排除能补上这条缝:同一时刻一个端口只能被一个进程绑定,Hub 托管实例
   * 监听着的端口上不可能同时坐着另一个 dsh。相比 pid,端口也不受进程重启与
   * pid 复用影响。
   */
  managedPorts?: () => number[]
}

export interface ExternalDshScanner {
  /** 扫描当前用户可见的 dsh web 进程(只读;失败返回空数组) */
  scan(): Promise<ExternalDshWeb[]>
}

export function createExternalDshScanner(options: ExternalDshScannerOptions): ExternalDshScanner {
  const platform = options.platform ?? process.platform
  const hubPid = options.hubPid
  const run =
    options.run ??
    ((command: string, args: string[]) =>
      new Promise<{ code: number; stdout: string }>((resolve, reject) => {
        // ps 与 lsof 各自的上限不同:lsof 列出所有监听 socket,给更宽裕的超时;
        // Windows 的 PowerShell/CIM 查询冷启动慢,给最宽裕的超时
        const timeout =
          command === 'lsof'
            ? LSOF_TIMEOUT_MS
            : command === 'powershell.exe'
              ? WIN_PS_TIMEOUT_MS
              : command === 'netstat'
                ? NETSTAT_TIMEOUT_MS
                : PS_TIMEOUT_MS
        execFile(
          command,
          args,
          { timeout, maxBuffer: PROCESS_TABLE_MAX_BUFFER },
          (error: Error | null, stdout: string | Buffer) => {
            if (error) {
              reject(error)
              return
            }
            resolve({ code: 0, stdout: String(stdout) })
          }
        )
      }))

  return {
    async scan(): Promise<ExternalDshWeb[]> {
      // 排除集合 = Hub 主进程的整棵子树(见 collectDescendants)。
      const excludePids = (entries: ProcessEntry[]): Set<number> =>
        collectDescendants(hubPid, entries)
      // 端口定了之后还要再排一次:Hub 托管实例的端口不能作为可接管对象
      // (包装器先退出时 dsh 脱离进程树,只靠进程树排除会漏)。
      const excludeManagedPorts = (items: ExternalDshWeb[]): ExternalDshWeb[] => {
        const managed = new Set(options.managedPorts?.() ?? [])
        if (managed.size === 0) return items
        return items.filter((item) => item.port === null || !managed.has(item.port))
      }
      if (platform === 'win32') {
        let entries: ProcessEntry[]
        try {
          const ps = await run('powershell.exe', ['-NoProfile', '-Command', WIN_PROCESS_SCRIPT])
          entries = parseWindowsProcessTable(ps.stdout)
        } catch (error) {
          console.error('[external-dsh] 进程查询失败：', error)
          return []
        }
        const processes = selectDshWebProcesses(entries, excludePids(entries))
        if (processes.length === 0) return processes

        // 与 POSIX 分支同一口径:端口必须由该 PID 的监听 socket 确认,
        // 命令行 --port 仅作显示提示。
        try {
          const netstat = await run('netstat', ['-ano', '-p', 'tcp'])
          const ports = parseWindowsListeningPorts(netstat.stdout)
          return excludeManagedPorts(
            processes.map((item) => ({ ...item, port: ports.get(item.pid) ?? null }))
          )
        } catch (error) {
          console.error('[external-dsh] 端口查询失败：', error)
          return excludeManagedPorts(processes.map((item) => ({ ...item, port: null })))
        }
      }
      let entries: ProcessEntry[]
      try {
        const ps = await run('ps', ['-axo', 'pid=,ppid=,command='])
        entries = parseProcessTable(ps.stdout)
      } catch (error) {
        console.error('[external-dsh] 进程查询失败：', error)
        return []
      }
      const processes = selectDshWebProcesses(entries, excludePids(entries))
      if (processes.length === 0) return processes

      // 端口必须由该 PID 的监听 socket 确认。命令行 --port 仅作显示提示，不能证明
      // 进程仍成功绑定该端口，也不能证明该端口未被其他本机服务占用。
      try {
        const lsof = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
        const ports = parseListeningPorts(lsof.stdout)
        return excludeManagedPorts(
          processes.map((item) => ({ ...item, port: ports.get(item.pid) ?? null }))
        )
      } catch (error) {
        console.error('[external-dsh] 端口查询失败：', error)
        // lsof 不可用或超时时不返回可打开的端口，避免连接到未验证的本机服务。
        return excludeManagedPorts(processes.map((item) => ({ ...item, port: null })))
      }
    }
  }
}
