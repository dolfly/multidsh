/**
 *
 * 的事件枚举,由调用方(主进程)在状态回推的单点漏斗里调用。放在这里而非内联,
 *
 * **只输出白名单字段**:`{instanceId, event, result}` —— 不携带 message/凭据。
 * `result` 取状态机已有的**错误码**(如 `invalid-credentials`),不含用户输入。
 */
import type { AuthPhase, InstanceRuntimeStatus } from '@shared/contracts'
import type { AuditEntry } from './audit-log'

/** 映射所需的最小认证状态面(与 AuthState 结构兼容,便于直接传入) */
export interface AuthStateLike {
  phase: AuthPhase
  lockedForMs: number
  lastErrorCode: string | null
}

/** 处于「需要用户重新提供凭据」的阶段 */
const CREDENTIAL_PHASES: readonly AuthPhase[] = ['needs-auth', 'await-credentials']

/**
 * 认证状态迁移 → 审计事件(可能 0 或 1 条)。
 *
 * - `connected`(首次进入)              → `login-success`
 * - 曾在 `connected` 掉回需要凭据      → `session-revoked`(会话失效)
 * - 锁定时长 > 0                       → `lockout`(带上游错误码)
 * - 错误码为限流                       → `rate-limited`
 * - 其它在「已有历史状态」上的失败      → `login-failed`
 *
 * `prev === null` 表示首次观测(应用启动/首次探测):此时仅记录**成功**,
 * 不把一次探测失败记成「登录失败」(那会污染审计:用户从未尝试登录)。
 */
export function mapAuthTransition(
  instanceId: string,
  prev: AuthStateLike | null,
  next: AuthStateLike
): AuditEntry[] {
  const entry = (event: AuditEntry['event'], result?: string): AuditEntry[] => [
    { instanceId, event, ...(result === undefined ? {} : { result }) }
  ]

  if (next.phase === 'connected') {
    return prev?.phase === 'connected' ? [] : entry('login-success', 'ok')
  }

  // 曾在 connected,现在又需要凭据 = 会话被撤销/失效
  if (prev?.phase === 'connected' && CREDENTIAL_PHASES.includes(next.phase)) {
    return entry('session-revoked', next.lastErrorCode ?? 'unauthenticated')
  }

  // 只记录进入锁定边沿；倒计时刷新不应重复污染审计。
  if (next.lockedForMs > 0 && (prev?.lockedForMs ?? 0) <= 0) {
    return entry('lockout', next.lastErrorCode ?? 'locked')
  }

  // 锁定倒计时期间只保留首个 lockout 事件。
  if (next.lockedForMs > 0) return []

  if (next.lastErrorCode === 'rate-limited') {
    return entry('rate-limited', 'rate-limited')
  }

  // 首次观测(prev === null)不算登录失败:那只是一次探测
  if (prev === null) return []
  if (CREDENTIAL_PHASES.includes(next.phase) || next.phase === 'await-otp') {
    return next.lastErrorCode === null ? [] : entry('login-failed', next.lastErrorCode)
  }

  return []
}

/** 映射所需的最小运行时状态面 */
export interface RuntimeStatusLike {
  status: InstanceRuntimeStatus
  detail?: string
}

/**
 * 运行时状态迁移 → 审计事件。
 * - 进入 `running`            → `connect`
 * - 从 `running` 离开          → `disconnect`
 * - 进入 `error` 且归因为隧道 → `ssh-exit`
 * - 从 `error` 回到 `starting`/`running` → `ssh-reconnect`
 *
 * `detail` 是**人读诊断文案**(不进审计):审计只记枚举与错误码。
 */
export function mapRuntimeTransition(
  instanceId: string,
  prev: RuntimeStatusLike | null,
  next: RuntimeStatusLike
): AuditEntry[] {
  const entry = (event: AuditEntry['event'], result?: string): AuditEntry[] => [
    { instanceId, event, ...(result === undefined ? {} : { result }) }
  ]

  if (next.status === 'running') {
    return prev?.status === 'running' ? [] : entry('connect', 'ok')
  }

  if (next.status === 'starting' && prev !== null && prev.status !== 'starting') {
    // 仅在「曾失败/曾停止后重新拉起」时记为重连
    return prev.status === 'stopped' || prev.status === 'error' ? entry('ssh-reconnect', 'ok') : []
  }

  if (next.status === 'error') {
    return prev?.status === 'error' ? [] : entry('ssh-exit', 'error')
  }

  if (next.status === 'stopped' && prev?.status === 'running') {
    return entry('disconnect', 'ok')
  }

  return []
}
