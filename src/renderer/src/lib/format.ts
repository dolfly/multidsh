/**
 * 展示层工具：状态、类型映射和格式化。
 * 认证相关状态（auth/interrupted/locked）也在此映射。
 */
import type { InstanceRecord, InstanceRuntimeStatus, Transport } from '@shared/contracts'
import type { MessageKey } from '@shared/i18n/messages'
import type { IconName } from './icons'

export type DisplayStatus =
  'idle' | 'connecting' | 'auth' | 'connected' | 'interrupted' | 'error' | 'locked' | 'installing'

export interface DisplayStatusInfo {
  chipClass: string
  dotClass: string
  icon: IconName
  /** 文案 key(由调用方经 store 的 t() 渲染) */
  labelKey: MessageKey
}

export const STATUS_INFO: Record<DisplayStatus, DisplayStatusInfo> = {
  idle: { labelKey: 'state.idle', chipClass: 'c-idle', dotClass: '', icon: 'wifi' },
  connecting: {
    labelKey: 'state.connecting',
    chipClass: 'c-info',
    dotClass: 's-connecting',
    icon: 'refresh'
  },
  auth: { labelKey: 'state.auth', chipClass: 'c-warn', dotClass: 's-auth', icon: 'key' },
  connected: {
    labelKey: 'state.connected',
    chipClass: 'c-ok',
    dotClass: 's-connected',
    icon: 'check'
  },
  interrupted: {
    labelKey: 'state.interrupted',
    chipClass: 'c-warn',
    dotClass: 's-interrupted',
    icon: 'wifi'
  },
  error: { labelKey: 'state.error', chipClass: 'c-err', dotClass: 's-error', icon: 'alert' },
  locked: { labelKey: 'state.locked', chipClass: 'c-err', dotClass: 's-locked', icon: 'lock' },
  installing: {
    labelKey: 'state.installing',
    chipClass: 'c-info',
    dotClass: 's-connecting',
    icon: 'refresh'
  }
}

/** 将运行时状态映射为展示状态。 */
export function toDisplayStatus(
  status?: InstanceRuntimeStatus,
  workspaceConnected = true
): DisplayStatus {
  if (status === 'running' && !workspaceConnected) return 'idle'
  switch (status) {
    case 'starting':
      return 'connecting'
    case 'installing':
      return 'installing'
    case 'running':
      return 'connected'
    case 'error':
      return 'error'
    default:
      return 'idle'
  }
}

/**
 * 运行时状态 → 展示信息（圆点 / 胶囊 / 文案由**同一次映射**给出）。
 *
 * 列表和侧边栏共用此映射，确保圆点、胶囊和文案反映同一状态。
 */
export function toStatusInfo(
  status?: InstanceRuntimeStatus,
  workspaceConnected = true
): DisplayStatusInfo {
  return STATUS_INFO[toDisplayStatus(status, workspaceConnected)]
}

/**
 * 展示层类型标签只保存文案 key，文案由调用方翻译。
 */
export const TYPE_INFO: Record<Transport, { labelKey: MessageKey; icon: IconName }> = {
  local: { labelKey: 'transport.local', icon: 'local' },
  ssh: { labelKey: 'transport.ssh', icon: 'ssh' },
  http: { labelKey: 'transport.http', icon: 'remote' }
}

export function addressOf(record: InstanceRecord): string {
  switch (record.transport) {
    case 'local':
      return `127.0.0.1:${record.port ?? '—'}`
    case 'ssh':
      return `${record.host}:${record.remotePort}`
    case 'http':
      return record.endpointUrl
  }
}

/** 标题栏只展示可扫描的 endpoint 主机/端口，避免路径和认证探测详情占满空间。 */
export function compactWorkspaceAddress(address: string): string {
  try {
    const url = new URL(address)
    return url.host || address
  } catch {
    return address.length > 64 ? `${address.slice(0, 61)}…` : address
  }
}

/**
 * 日志时间戳 → `yyyy-MM-dd HH:mm:ss`（本地时区，月/日/时分秒补零）。
 * 固定格式便于日志逐行对齐扫读；不用区域化格式以免随系统语言与 locale 漂移。
 */
export function fmtLogTime(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}
