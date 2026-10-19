/**
 * SSH host/port 语法的单一真源：校验（isValidSshHost，供 schema refine）与拆分
 * （splitSshHostPort，供 instance-store 使用）共用同一组正则，两者不会再各自维护而漂移。
 *
 * 本模块不 import electron。
 */

/**
 * SSH 主机合法性：
 * - 普通主机名 / 别名 / IPv4：不含冒号即可；
 * - 裸 IPv6：至少两个冒号且全为十六进制字符；
 * - `host[:port]` / `[v6][:port]`：端口必须落在 1–65535（非法端口组合显式拒绝，
 *   而不是把整串存进 host 字段）。
 */
const SSH_PORT_PATTERN = /^(\d+)$/

function parseSshPort(rawPort: string): number | null {
  if (!SSH_PORT_PATTERN.test(rawPort)) return null
  return inPortRange(rawPort) ? Number(rawPort) : null
}

/**
 * SSH host 语法的单一真源：校验（isValidSshHost）与拆分（splitSshHostPort）共用同一组正则，
 * 两者不会再各自维护而漂移。
 * - `PLAIN_HOST_PORT`：`host:port`（主机名/别名/IPv4 + 十进制端口）。
 * - `BRACKET_HOST_PORT`：`[v6]:port`（方括号 IPv6 + 端口）。
 * - `BRACKET_HOST`：`[v6]`（方括号 IPv6，无端口）。方括号内只允许十六进制/冒号/点分尾，
 *   非 IPv6 字面量（如 `[-flist]`）不匹配 → 被 isValidSshHost 拒绝，堵住 ssh-keyscan 选项注入面。
 */
const PLAIN_HOST_PORT = /^([A-Za-z0-9._-]+):(\d+)$/
const BRACKET_HOST_PORT = /^\[([0-9a-fA-F:.]+)\]:(\d+)$/
const BRACKET_HOST = /^\[([0-9a-fA-F:.]+)\]$/

export function isValidSshHost(host: string): boolean {
  const portOfPlain = PLAIN_HOST_PORT.exec(host)
  if (portOfPlain) return parseSshPort(portOfPlain[2] ?? '') !== null
  const portOfBracket = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(host)
  if (portOfBracket)
    return portOfBracket[2] === undefined || parseSshPort(portOfBracket[2]) !== null
  // 方括号只允许包裹 IPv6 字面量（仅十六进制/冒号/点分尾）。其余方括号内容一律拒绝：
  // ssh-keyscan 会先剥掉方括号再作为位置参数传入，`[-flist]` → `-flist` 会被当作选项解析
  // （argv 选项注入面），而顶层 `startsWith('-')` 守卫只看到 `[` 拦不住它。
  if (host.startsWith('[') || host.endsWith(']')) return false
  if (host.includes(':')) {
    // 裸 IPv6（含 IPv4-mapped 点分尾巴 `::ffff:192.168.1.5`）：至少两个冒号且字符集合法
    return /^[0-9a-fA-F:.]+$/.test(host) && (host.match(/:/g)?.length ?? 0) >= 2
  }
  return true
}

function inPortRange(rawPort: string | undefined): boolean {
  const port = Number(rawPort)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export interface SshHostPortSplit {
  host: string
  port: number
  /** 端口是否来自 host 内的 `:port` 组合形式；false 表示取 fallbackPort（调用方不应据此覆盖已有端口） */
  portEmbedded: boolean
}

/**
 * SSH `host[:port]` / `[v6][:port]` 组合形式拆分。
 * - 纯主机名 / 别名 / 裸 IPv6（含冒号但非 host:port 形态）原样返回，端口取 fallbackPort；
 * - 方括号形态一律剥离方括号（`[::1]` → `::1`、`[::1]:2222` → `::1` + 2222）；
 * - 字符类含 `.`，与 SSH_HOST_SCHEMA 的方括号分支保持一致（`[::ffff:192.168.1.1]`、
 *   `[192.0.2.1]:2222` 等点分形态也必须能拆分，否则端口会静默回退）。
 */
export function splitSshHostPort(host: string, fallbackPort: number): SshHostPortSplit {
  const plain = PLAIN_HOST_PORT.exec(host)
  if (plain) {
    const port = parseSshPort(plain[2] ?? '')
    if (port !== null) return { host: plain[1] ?? '', port, portEmbedded: true }
  }
  const bracketedWithPort = BRACKET_HOST_PORT.exec(host)
  if (bracketedWithPort) {
    const port = parseSshPort(bracketedWithPort[2] ?? '')
    if (port !== null) return { host: bracketedWithPort[1] ?? '', port, portEmbedded: true }
  }
  // 方括号无端口形态 `[::1]`：只归一化主机形态，端口由调用方决定
  const bracketedPlain = BRACKET_HOST.exec(host)
  if (bracketedPlain) {
    return { host: bracketedPlain[1] ?? '', port: fallbackPort, portEmbedded: false }
  }
  return { host, port: fallbackPort, portEmbedded: false }
}

/** 「关于」对话框的项目主页（主进程固定，渲染层无从指定其他 URL） */
export const HOMEPAGE_URL = 'https://github.com/xbzbing/dsh-hub-desktop'
