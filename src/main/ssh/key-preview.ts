/**
 *
 * 只读元信息：`ssh -G <目标>` 解析实际生效的 IdentityFile（覆盖 config 别名 / 默认路径 /
 * 指定 -i），`ssh-add -L` 列 agent 可用公钥。**绝不读取私钥内容**，预览只为可解释性。
 */
import { execFile } from 'node:child_process'
import type {
  SshAgentKeyInfo,
  SshAgentStatus,
  SshInstance,
  SshKeyPreviewResult
} from '@shared/contracts'
import { keyTypeLabel, publicKeyFingerprint } from './host-trust'

/** IPC 共享类型的别名（类型本体在 shared/contracts） */
export type AgentStatus = SshAgentStatus
export type AgentKey = SshAgentKeyInfo
export type SshKeyPreview = SshKeyPreviewResult

/**
 * 解析 `ssh -G` 输出。返回全部 identityfile（优先级顺序）与生效的 user/hostname/port。
 * 注意：`ssh -G` 会打印大量默认值，这里只挑关注的键。
 */
export function parseSshG(stdout: string): {
  user: string | null
  host: string | null
  port: number | null
  identityFiles: string[]
} {
  let user: string | null = null
  let host: string | null = null
  let port: number | null = null
  const identityFiles: string[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const spaceIndex = line.indexOf(' ')
    if (spaceIndex === -1) continue
    const key = line.slice(0, spaceIndex).toLowerCase()
    const value = line.slice(spaceIndex + 1).trim()
    if (key === 'identityfile' && value !== '') identityFiles.push(value)
    else if (key === 'user' && user === null) user = value
    else if (key === 'hostname' && host === null) host = value
    else if (key === 'port' && port === null) {
      const parsed = Number(value)
      if (Number.isInteger(parsed) && parsed > 0) port = parsed
    }
  }
  return { user, host, port, identityFiles }
}

/**
 * 解析 `ssh-add -L` 的「状态 + 公钥列表」。
 * exit 0 且有多行公钥 = ready；exit 0 且 "The agent has no identities." = empty；
 * 其他（连接不上 agent）= unavailable。
 */
export function parseAgentKeys(
  stdout: string,
  stderr: string,
  exitCode: number | null
): { status: AgentStatus; keys: AgentKey[] } {
  const keys: AgentKey[] = []
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('The agent has no identities')) continue
    const parts = line.split(/\s+/)
    const type = parts[0]
    const blob = parts[1]
    if (!type || !blob || (!type.startsWith('ssh-') && !type.includes('@openssh.com'))) continue
    keys.push({
      type,
      typeLabel: keyTypeLabel(type),
      blob,
      comment: parts.slice(2).join(' ') || null,
      fingerprint: publicKeyFingerprint(blob)
    })
  }
  if (keys.length > 0) return { status: 'ready', keys }
  if (exitCode === 0) return { status: 'empty', keys: [] }
  const reason = stderr.trim()
  if (reason !== '') return { status: 'unavailable', keys: [] }
  return { status: exitCode === 0 ? 'empty' : 'unavailable', keys: [] }
}

export interface KeyPreviewOptions {
  sshCommand?: string
  sshAddCommand?: string
  timeoutMs?: number
}

/**
 * 解析某实例的密钥预览。
 * `ssh -G` 目标使用实例的 host（别名原样传入，由 ssh 自己展开 config）；
 * 显式 identityFile 会同时反映在 ssh -G 输出与 explicitIdentityFile 字段。
 */
export async function resolveSshKeyPreview(
  instance: Pick<SshInstance, 'host' | 'port' | 'username' | 'identityFile'>,
  options: KeyPreviewOptions = {}
): Promise<SshKeyPreview> {
  const ssh = options.sshCommand ?? 'ssh'
  const sshAdd = options.sshAddCommand ?? 'ssh-add'
  const timeoutMs = options.timeoutMs ?? 6_000

  const gArgs = [
    '-G',
    ...(instance.identityFile ? ['-i', instance.identityFile] : []),
    ...(instance.username ? ['-l', instance.username] : []),
    ...(instance.port !== 22 ? ['-p', String(instance.port)] : []),
    instance.host
  ]
  const gOutput = await new Promise<string>((resolve, reject) => {
    execFile(ssh, gArgs, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (stdout && stdout.trim() !== '') resolve(stdout)
      else reject(error ?? new Error('ssh -G 未返回任何配置'))
    })
  })
  const parsedG = parseSshG(gOutput)
  const identityFiles = instance.identityFile
    ? [instance.identityFile, ...parsedG.identityFiles.filter((f) => f !== instance.identityFile)]
    : parsedG.identityFiles

  const agent = await new Promise<{ status: AgentStatus; keys: AgentKey[] }>((resolve) => {
    execFile(
      sshAdd,
      ['-L'],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? ((error as { code?: number }).code ?? 1) : 0
        resolve(parseAgentKeys(stdout ?? '', stderr ?? '', code))
      }
    )
  })

  return {
    target: instance.host,
    resolved: {
      user: parsedG.user ?? instance.username,
      host: parsedG.host ?? instance.host,
      port: parsedG.port ?? instance.port
    },
    identityFiles,
    agent,
    explicitIdentityFile: instance.identityFile
  }
}
