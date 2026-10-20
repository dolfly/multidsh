import type { LocalLauncher } from '@shared/local-launch'
import type { ExternalDshWebSnapshot } from '@shared/contracts'

/** 向导表单：三种传输的字段合并存放，未使用字段保持默认值。 */
export interface WizardForm {
  name: string
  version: string
  profile: string
  port: string
  launcher: LocalLauncher
  useDefaultSpace: boolean
  registry: string
  host: string
  username: string
  sshPort: string
  remotePort: string
  endpointUrl: string
  externalAccess: string
}

export const EMPTY_FORM: WizardForm = {
  name: '',
  version: '',
  profile: '',
  port: '',
  launcher: 'dsh',
  useDefaultSpace: false,
  registry: '',
  host: '',
  username: '',
  sshPort: '22',
  remotePort: '3080',
  endpointUrl: '',
  externalAccess: ''
}

/**
 * 探测到的本机已运行 dsh web（可接管）：端口已确定的那些。
 *
 * 独立于 IPC 快照类型 `ExternalDshWebSnapshot`：快照的 `port` 可为 null（端口
 * 未能确定），而这里只收录端口已确定的条目。两者不变量不同，用类型守卫连接，
 * 不做交叉类型 —— 交叉类型会让 `port` 看起来恒为非空，实际却要处处防 null。
 */
export interface ExternalWorkspace {
  pid: number
  port: number
  patch: string | null
  command: string
}

/** IPC 快照 → 可接管的外部实例：端口已确定才算。 */
export function isAdoptableExternal(
  item: ExternalDshWebSnapshot
): item is ExternalDshWebSnapshot & ExternalWorkspace {
  return item.port !== null
}

export type WizardTransport = 'local' | 'ssh' | 'http'
