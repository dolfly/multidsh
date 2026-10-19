/**
 * SSH 相关契约：密钥预览、主机指纹确认与 askpass 提示载荷。
 *
 * 本模块不 import electron。
 */
// ===== SSH 密钥预览 / 主机指纹确认 / askpass =====

/**
 * SSH 通道：
 * - `keyPreview`：向导/详情页只读展示「将使用哪个密钥」与 agent 状态（绝不含私钥内容）；
 * - `hostKeyDecision`(主→渲染) + `hostKeyReply`(渲染→主)：TOFU 指纹确认（首次/变化双变体）；
 * - `hostKeyForget`(渲染→主)：**显式、破坏性**的恢复动作「忘记该主机指纹」。连接时指纹变化
 *   一律拒绝且不自动清理，只有走完本动作后下一次连接才重新走首次 TOFU；
 * - `askpassRequest`(主→渲染) + `askpassReply`(渲染→主)：SSH 口令/密钥口令弹窗，
 *   口令只经 IPC 瞬时传递，不落盘、不入日志、不进审计。
 */
export const SSH_IPC = {
  keyPreview: 'ssh:keyPreview',
  hostKeyDecision: 'ssh:hostKeyDecision',
  hostKeyReply: 'ssh:hostKeyReply',
  hostKeyForget: 'ssh:hostKeyForget',
  askpassRequest: 'ssh:askpassRequest',
  askpassReply: 'ssh:askpassReply'
} as const

export type SshAgentStatus = 'ready' | 'empty' | 'unavailable'

export interface SshAgentKeyInfo {
  type: string
  typeLabel: string
  /** 公钥体（只读展示，不含任何私钥信息） */
  blob: string
  comment: string | null
  fingerprint: string
}

export interface SshKeyPreviewResult {
  target: string
  resolved: { user: string; host: string; port: number }
  identityFiles: string[]
  agent: { status: SshAgentStatus; keys: SshAgentKeyInfo[] }
  explicitIdentityFile: string | null
}

export interface HostKeyFingerprintInfo {
  type: string
  typeLabel: string
  fingerprint: string
}

/** 指纹确认请求（主 → 渲染）；verdict=changed 时 UI 走红色警示且默认拒绝 */
export interface HostKeyPromptPayload {
  requestId: string
  instanceId: string
  /** 目标标签（host 或 host:port） */
  target: string
  verdict: 'unknown' | 'changed'
  fingerprints: HostKeyFingerprintInfo[]
  previousFingerprints: HostKeyFingerprintInfo[]
}

export type HostKeyDecision = 'trust' | 'reject'

/**
 * 「忘记该主机指纹」输入（渲染 → 主）。
 *
 * 删除已保存的指纹后，下一次连接会重新按首次连接核对新指纹。
 * 该操作不属于连接确认流程，且只能由用户单独发起。
 */
export interface SshHostKeyForgetInput {
  instanceId: string
}

/** askpass 口令请求（主 → 渲染）；secret 只经 IPC 瞬时传递 */
export interface AskpassPromptPayload {
  requestId: string
  instanceId: string
  prompt: string
}
