/**
 *
 * 策略：连接前用 `ssh-keyscan` 预取目标公钥 → 与 hub 私有 known_hosts 比对：
 * - 未见过 → 展示指纹请用户确认，确认后写入 hub 私有 known_hosts 再放行；
 * - 已见过且一致 → 直接放行；
 * - 已见过但不一致 → **拒绝连接**并告警（可能是重装/轮换，也可能是中间人）。
 * 私钥内容永不读取；只处理公钥与指纹。
 */
import { createHash } from 'node:crypto'
import type { HostKeyFingerprintInfo, HostKeyPromptPayload, SshInstance } from '@shared/contracts'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type HostKeyType = string

export interface HostKeyEntry {
  type: HostKeyType
  /** base64 公钥体 */
  blob: string
}

export type TrustVerdict = 'trusted' | 'unknown' | 'changed'

export interface HostTrustEvaluation {
  verdict: TrustVerdict
  /** 服务端当前出示的公钥（keyscan 结果） */
  scanned: HostKeyEntry[]
  /** 已信任但服务端不再出示的旧公钥（verdict=changed 时用于展示） */
  mismatched: HostKeyEntry[]
}

/** 去掉 IPv6 方括号（OpenSSH 的 known_hosts/keyscan 对 22 端口用裸 `::1`） */
export function bareHost(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '')
}

/** known_hosts 中的主机字段：非 22 端口用 `[host]:port`，22 端口用裸主机（IPv6 亦去括号） */
export function knownHostsHostField(host: string, port: number): string {
  const bare = bareHost(host)
  return port === 22 ? bare : `[${bare}]:${port}`
}

/** OpenSSH SHA256 指纹：`SHA256:` + base64(sha256(blob))，去掉 `=` 填充 */
export function publicKeyFingerprint(blob: string): string {
  try {
    const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64')
    return `SHA256:${digest.replace(/=+$/, '')}`
  } catch {
    return 'SHA256:<无法解析>'
  }
}

/** 公钥类型 → 展示名（用于 UI 可读性） */
export function keyTypeLabel(type: string): string {
  const map: Record<string, string> = {
    'ssh-ed25519': 'ED25519',
    'ssh-rsa': 'RSA',
    'ecdsa-sha2-nistp256': 'ECDSA 256',
    'ecdsa-sha2-nistp384': 'ECDSA 384',
    'ecdsa-sha2-nistp521': 'ECDSA 521',
    'ssh-dss': 'DSA',
    'sk-ssh-ed25519@openssh.com': 'ED25519-SK',
    'sk-ecdsa-sha2-nistp256@openssh.com': 'ECDSA-SK'
  }
  return map[type] ?? type
}

/** 解析 `ssh-keyscan` 输出：非注释行为 `<host-field> <type> <base64>` */
export function parseKeyscan(stdout: string): HostKeyEntry[] {
  const entries: HostKeyEntry[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const type = parts[1]
    const blob = parts[2]
    if (!type || !blob) continue
    if (!entries.some((entry) => entry.type === type && entry.blob === blob)) {
      entries.push({ type, blob })
    }
  }
  return entries
}

/** 解析 hub 私有 known_hosts 中该目标的条目（忽略注释/空行） */
export function parseKnownHosts(content: string, hostField: string): HostKeyEntry[] {
  const entries: HostKeyEntry[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const hosts = (parts[0] ?? '').split(',')
    if (!hosts.includes(hostField)) continue
    const type = parts[1]
    const blob = parts[2]
    if (type && blob) entries.push({ type, blob })
  }
  return entries
}

/**
 * 比对：任一 keyscan 公钥命中已信任集合即视为 trusted；
 * 否则若双方有同类型但不同值的公钥 → changed；否则 unknown（新主机/新算法）。
 */
export function evaluateHostTrust(
  trusted: HostKeyEntry[],
  scanned: HostKeyEntry[]
): HostTrustEvaluation {
  if (scanned.length === 0) {
    return { verdict: 'unknown', scanned, mismatched: [] }
  }
  const trustedSet = new Set(trusted.map((entry) => `${entry.type} ${entry.blob}`))
  if (scanned.some((entry) => trustedSet.has(`${entry.type} ${entry.blob}`))) {
    return { verdict: 'trusted', scanned, mismatched: [] }
  }
  if (trusted.length === 0) {
    return { verdict: 'unknown', scanned, mismatched: [] }
  }
  // 已信任但服务端不再出示（含同类型不同值、类型消失）——两者都应告警
  const mismatched = trusted.filter(
    (entry) =>
      !scanned.some((candidate) => candidate.type === entry.type && candidate.blob === entry.blob)
  )
  return { verdict: 'changed', scanned, mismatched }
}

/** 追加写入 known_hosts 的行（确认信任后调用） */
export function formatKnownHostsLines(hostField: string, keys: HostKeyEntry[]): string[] {
  return keys.map((entry) => `${hostField} ${entry.type} ${entry.blob}`)
}

export interface HostTrustProbe {
  /** 预取服务端公钥（ssh-keyscan） */
  scan(): Promise<HostKeyEntry[]>
  /** 读取 hub 私有 known_hosts 中该目标的既有条目 */
  readTrusted(): Promise<HostKeyEntry[]>
}

export interface HostTrustOptions {
  knownHostsPath: string
  keyscanCommand?: string
  timeoutMs?: number
}

export interface ResolvedSshTarget {
  host: string
  port: number
}

/**
 * 从 OpenSSH 的有效配置中取得实际连接目标。SSH 别名可通过 HostName / Port 重写目标，
 * 而 StrictHostKeyChecking 会以该目标查询 known_hosts；因此 TOFU 也必须使用同一目标。
 */
export function parseResolvedSshTarget(
  stdout: string,
  fallback: ResolvedSshTarget
): ResolvedSshTarget {
  let host = fallback.host
  let port = fallback.port
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    const spaceIndex = line.indexOf(' ')
    if (spaceIndex === -1) continue
    const key = line.slice(0, spaceIndex).toLowerCase()
    const value = line.slice(spaceIndex + 1).trim()
    if (key === 'hostname' && value !== '') host = value
    if (key === 'port') {
      const parsed = Number(value)
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535) port = parsed
    }
  }
  return { host, port }
}

/**
 * 只读取 `ssh -G` 的文本配置，不读取私钥或启动网络会话。解析失败由调用方回退到实例输入。
 */
export async function resolveSshTarget(
  instance: Pick<SshInstance, 'host' | 'port' | 'username'>,
  sshCommand = 'ssh',
  timeoutMs = 6_000
): Promise<ResolvedSshTarget> {
  const args = [
    '-G',
    '-l',
    instance.username,
    ...(instance.port !== 22 ? ['-p', String(instance.port)] : []),
    instance.host
  ]
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(sshCommand, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, out) => {
      if (out && out.trim() !== '') resolve(out)
      else reject(error ?? new Error('ssh -G 未返回任何配置'))
    })
  })
  return parseResolvedSshTarget(stdout, { host: instance.host, port: instance.port })
}

export function createHostTrustProbe(
  host: string,
  port: number,
  options: HostTrustOptions
): HostTrustProbe {
  const keyscan = options.keyscanCommand ?? 'ssh-keyscan'
  const timeoutMs = options.timeoutMs ?? 8_000
  const hostField = knownHostsHostField(host, port)

  return {
    async scan(): Promise<HostKeyEntry[]> {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          keyscan,
          // ssh-keyscan 不接受方括号形式(实测 `getaddrinfo [::1]` 失败),统一传裸主机
          ['-p', String(port), '-T', '5', bareHost(host)],
          { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
          (error, out) => {
            // keyscan 常以非 0 退出（部分算法不可用）但仍输出可用公钥
            if (out && out.trim() !== '') resolve(out)
            else reject(error ?? new Error('ssh-keyscan 未返回任何公钥'))
          }
        )
      })
      return parseKeyscan(stdout)
    },
    async readTrusted(): Promise<HostKeyEntry[]> {
      try {
        const content = await readFile(options.knownHostsPath, 'utf8')
        return parseKnownHosts(content, hostField)
      } catch {
        return [] // 文件不存在 = 从未信任过任何主机
      }
    }
  }
}

/** 目标标签（UI 展示用） */
export function hostTargetLabel(host: string, port: number): string {
  return port === 22 ? host : `${host}:${port}`
}

/** 指纹条目（UI 展示用：类型 + SHA256 指纹）；类型本体在 shared/contracts（IPC 共享） */
export type HostKeyFingerprint = HostKeyFingerprintInfo

export function toFingerprints(keys: HostKeyEntry[]): HostKeyFingerprint[] {
  return keys.map((entry) => ({
    type: entry.type,
    typeLabel: keyTypeLabel(entry.type),
    fingerprint: publicKeyFingerprint(entry.blob)
  }))
}

/** 指纹确认请求（主进程 → UI；verdict=changed 时 UI 走红色警示变体）。
 *  通道载荷比它多一个 requestId,由 prompt broker 补齐。 */
export type HostKeyPrompt = Omit<HostKeyPromptPayload, 'requestId'>

/**
 * 把确认信任的公钥写入 hub 私有 known_hosts。
 * - `mode='append'`：追加（去重）。**仅用于 verdict=`unknown` 的首次 TOFU 确认**；
 * - `mode='replace'`：先删除该目标的旧行再写入。
 *
 * 都不放行、旧公钥一个字节都不改；唯一恢复途径是用户**显式**执行 `forgetHostKey`
 * （先删该主机旧行、keys 传空数组 = 只删不写），下次连接重新走首次 TOFU。
 *
 * 因此**不要**再按「changed + 高级确认 → 调用本函数 replace」去"修复"调用方 ——
 */
export async function recordHostTrust(
  knownHostsPath: string,
  hostField: string,
  keys: HostKeyEntry[],
  mode: 'append' | 'replace'
): Promise<void> {
  let existing = ''
  try {
    existing = await readFile(knownHostsPath, 'utf8')
  } catch {
    existing = ''
  }
  const lines = existing.split(/\r?\n/).filter((line) => line.trim() !== '')
  const kept =
    mode === 'replace'
      ? lines.filter((line) => !(line.split(/\s+/)[0] ?? '').split(',').includes(hostField))
      : lines
  const current = new Set(kept.map((line) => line.trim()))
  for (const line of formatKnownHostsLines(hostField, keys)) {
    if (!current.has(line)) {
      kept.push(line)
      current.add(line)
    }
  }
  await mkdir(dirname(knownHostsPath), { recursive: true })
  await writeFile(knownHostsPath, `${kept.join('\n')}\n`, { mode: 0o600 })
}
