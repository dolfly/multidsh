/**
 *
 * 全部显式传参，不依赖用户全局配置漂移；argv 以数组传入、不经 shell（无命令注入面）。
 * username / identityFile 作为 `-l` / `-i` 的参数被消费，不构成位置参数。
 *
 * 默认（22 / 未填）视为「交给 config 决定」，别名路径即可自然生效。
 */
import type { SshInstance } from '@shared/contracts'

export interface SshArgsOptions {
  controlPath: string
  /** 私有 known_hosts 路径；配合 TOFU 前置写入(StrictHostKeyChecking=yes,指纹变更一律拒绝),不污染用户 ~/.ssh */
  knownHostsPath: string
}

/** OpenSSH 会把 `-o Key=value` 的 value 当作配置行再次解析，路径空白必须转义。 */
function escapeOptionValue(value: string): string {
  return value.replace(/[\\\s]/g, (character) => `\\${character}`)
}

export function buildSshArgs(
  instance: SshInstance,
  localPort: number,
  options: SshArgsOptions
): string[] {
  const args = [
    // 只做转发，不开远程 shell
    '-N',
    // sshd 仅当用户显式选了非默认端口才传；默认交给 ~/.ssh/config（别名模式）
    ...(instance.port !== 22 ? ['-p', String(instance.port)] : []),
    '-l',
    instance.username,
    ...(instance.identityFile ? ['-i', instance.identityFile] : []),
    // 本地监听 <localPort> → 隧道远端 127.0.0.1:<remotePort>
    '-L',
    `${localPort}:127.0.0.1:${instance.remotePort}`
  ]

  const optionsList = [
    'ExitOnForwardFailure=yes', // 端口绑定失败立即退出（而不是挂起），便于看门狗归因
    'ServerAliveInterval=15', // 15s 心跳
    'ServerAliveCountMax=3', // 3 次失联判死 —— 比 TCP 超时快得多
    `ConnectTimeout=10`,
    'ControlMaster=auto', // 同一实例的并发连接复用一条 SSH 连接
    // ⚠️ 必须显式 ControlPersist=no：本机 ~/.ssh/config 常见 `ControlPersist yes`，
    // 前台，真正持隧道的是「未跟踪的 master」，停止/退出时回收不掉（实测孤儿）
    'ControlPersist=no',
    `ControlPath=${escapeOptionValue(options.controlPath)}`,
    // 写入 hub 私有 known_hosts),此处不再允许 ssh 自行接受未知主机
    'StrictHostKeyChecking=yes',
    `UserKnownHostsFile=${escapeOptionValue(options.knownHostsPath)}`
  ]
  for (const option of optionsList) args.push('-o', option)

  args.push(instance.host)
  return args
}
