/**
 * 监听端口反查：pid → 该 pid 正在监听的 TCP 端口。
 *
 * POSIX 走 `lsof -nP -iTCP -sTCP:LISTEN`，Windows 走 `netstat -ano -p tcp`，
 * 两边输出格式不同，但语义一致 —— 这里只做解析，查询由调用方发起。
 *
 * 端口必须由该 PID 的**监听 socket**确认，不能用命令行里的 `--port` 代替：
 * 命令行只说明启动时的意图，不能证明进程仍成功绑定该端口，也不能证明该端口
 * 未被其他本机服务占用。
 */
import { isLoopbackHost } from '@shared/endpoint'

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
