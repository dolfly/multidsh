/**
 * 本机进程表快照：pid、父 pid 与命令行。
 *
 * 外部 dsh 探测需要父 pid：Hub 拉起的实例与用户自己敲的 dsh 命令行完全同形
 * （同为 `dsh --profile web …`），命令行判定无法区分两者，只能靠进程树 ——
 * Hub 自己 spawn 的实例都在 Hub 主进程的子树里。
 *
 * 两个解析函数是纯函数（便于穷举测试），IO 全部由调用方注入。
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
 * 解析 `ps -axo pid=,ppid=,command=` 输出。
 * 行格式：`<pid> <ppid> <command...>`；无法解析的行直接跳过。
 */
export function parseProcessTable(psOutput: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const rawLine of psOutput.split('\n')) {
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
 * 解析 Windows CIM 输出（`Get-CimInstance Win32_Process`）。
 * 行格式：`<pid>\t<ppid>\t<command>`；制表符分隔避免命令行里的空格破坏字段边界。
 */
export function parseWindowsProcessTable(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const firstTab = line.indexOf('\t')
    if (firstTab < 0) continue
    const secondTab = line.indexOf('\t', firstTab + 1)
    if (secondTab < 0) continue
    const pid = Number(line.slice(0, firstTab))
    const ppid = Number(line.slice(firstTab + 1, secondTab))
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    const command = line
      .slice(secondTab + 1)
      .replace(/\s+/g, ' ')
      .trim()
    entries.push({ pid, ppid, command })
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
