/**
 * 本机进程表快照：pid、父 pid 与命令行。
 *
 * 外部 dsh 探测需要父 pid：Hub 拉起的实例与用户自己敲的 dsh 命令行完全同形
 * （同为 `dsh --profile web …`），命令行判定无法区分两者，只能靠进程树 ——
 * Hub 自己 spawn 的实例都在 Hub 主进程的子树里。
 *
 * 解析函数是纯函数（便于穷举测试），IO 全部由调用方注入。
 */

/** 进程表里的一条记录 */
export interface ProcessEntry {
  pid: number
  /** 父进程 pid；父进程已退出时为 1（POSIX init / Windows System） */
  ppid: number
  /** 完整命令行（空白已折叠） */
  command: string
}

/**
 * Windows 进程查询：输出 `<pid>\t<ppid>\t<command>` 行。
 *
 * 必须带出父进程 pid：排除 Hub 自己拉起的实例靠进程树，不靠命令行。
 * 命令行原样保留换行（`-e` 脚本等含换行的 argv 会把条目断成多行，
 * `dsh web` 落在无 pid 的续行上被解析器丢弃）；输出前把换行/制表符折叠成空格。
 *
 * **不按命令行过滤**：祖先链必须完整 —— 只回传命令行里含特定关键字的进程会让
 * 中间那层缺失，它的子孙就接不回 Hub 主进程，Hub 自己的实例反而会被当成外部
 * 实例上报。Get-CimInstance 本来就要取全表，过滤只发生在 PowerShell 侧，
 * 省不下查询成本，却会丢掉进程树。
 */
export const WIN_PROCESS_SCRIPT =
  'Get-CimInstance Win32_Process | ' +
  'ForEach-Object { [string]$_.ProcessId + [char]9 + [string]$_.ParentProcessId + [char]9 + ' +
  "($_.CommandLine -replace '[\\r\\n\\t]+', ' ') }"

/**
 * 解析进程表输出。
 *
 * 行格式：`<pid> <ppid> <command...>`，字段之间是任意空白。
 * POSIX 的 `ps -axo pid=,ppid=,command=` 用空格分隔并右对齐补白，Windows 的 CIM
 * 脚本用制表符分隔 —— 两者都被同一行正则覆盖（`\s+` 同时匹配空格与制表符），
 * 命令行本身若含制表符也不会错位：分隔符只在前两个字段位置上匹配。
 *
 * 无法解析的行直接跳过；命令行缺失（Windows 上 `CommandLine` 为 NULL）的行同样
 * 跳过 —— 那类进程不是 dsh 入口，也不参与判定。
 */
export function parseProcessTable(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const rawLine of output.split('\n')) {
    const trimmed = rawLine.trim()
    if (trimmed === '') continue
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(trimmed)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    entries.push({ pid, ppid, command: (match[3] ?? '').replace(/\s+/g, ' ').trim() })
  }
  return entries
}

/**
 * 收集 rootPid 自身与它的全部后代 pid。
 *
 * 用于回答「这个进程是不是 Hub 自己拉起的」：Hub 主进程 spawn 的实例都在这棵子树里，
 * 包含启动器包装器（dush/duush）与其再 spawn 的 dsh 两层。
 *
 * 循环保护：父 pid 关系可能出现环（数据异常），已访问集合保证遍历必然终止。
 */
export function collectDescendants(rootPid: number, entries: ProcessEntry[]): Set<number> {
  const children = new Map<number, number[]>()
  for (const entry of entries) {
    const list = children.get(entry.ppid)
    if (list) list.push(entry.pid)
    else children.set(entry.ppid, [entry.pid])
  }
  const result = new Set<number>([rootPid])
  const queue: number[] = [rootPid]
  while (queue.length > 0) {
    const pid = queue.pop() as number
    for (const child of children.get(pid) ?? []) {
      if (result.has(child)) continue
      result.add(child)
      queue.push(child)
    }
  }
  return result
}
