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
 * 能被认出来(包装器本身不当可接管对象,见 dsh-command.ts 的入口判定)。
 *
 * 本模块只做**只读探测**:POSIX 下 `ps` 找 dsh 进程,再由 `lsof` 确认该 PID
 * 的监听端口;Windows 下 `Get-CimInstance` 找进程,再由 `netstat` 确认监听端口。
 *
 * **Hub 自己拉起的实例必须排除**:Hub spawn 的实例与用户手敲的 dsh 命令行完全同形
 * (同为 `dsh --profile web …`),命令行判定无法区分二者,只能靠进程树 —— Hub 主进程
 * 子树里的 dsh 全是 Hub 自己管的实例(启动器包装器与其再 spawn 的 dsh 两层都在其中)。
 *
 * 本文件只负责**编排**:取进程表 → 判定 → 排除 → 确认端口。各步骤的判定逻辑在
 * dsh-command.ts(命令行)、dsh-processes.ts(进程表挑选)、process-table.ts(进程树)、
 * listening-ports.ts(监听端口)四个纯函数模块里。
 */
import { execFile } from 'node:child_process'
import {
  collectDescendants,
  parseProcessTable,
  WIN_PROCESS_SCRIPT,
  type ProcessEntry
} from './process-table'
import { selectDshWebProcesses, type ExternalDshWeb } from './dsh-processes'
import { parseListeningPorts, parseWindowsListeningPorts } from './listening-ports'

export type { ExternalDshWeb } from './dsh-processes'

const PS_TIMEOUT_MS = 5_000
const LSOF_TIMEOUT_MS = 5_000
const WIN_PS_TIMEOUT_MS = 30_000
const NETSTAT_TIMEOUT_MS = 10_000
/**
 * 进程查询输出的字节上限。
 *
 * POSIX 的 `ps` 输出整棵进程表,Windows 的 CIM 查询还要带上完整命令行,
 * 两边都可能超出 Node 的默认 maxBuffer(1MB);超限时 execFile 会 kill 子进程并
 * 回调 error,扫描随之失败。Windows 侧尤其危险:全量进程表的命令行体积远大于
 * POSIX,1MB 会被正常机器的进程数轻易撑破。
 */
const PROCESS_TABLE_MAX_BUFFER = 16 * 1024 * 1024

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
          entries = parseProcessTable(ps.stdout)
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
