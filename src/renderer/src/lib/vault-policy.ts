/**
 * 凭据卡片的策略推导。保持为纯函数，便于测试。
 * 策略快照到达前禁止提交，避免默认值覆盖已保存策略或删除凭据。
 */
import type { VaultPolicy, VaultStatusSnapshot } from '@shared/contracts'

/** 与主进程 DEFAULT_VAULT_POLICY 同口径：新实例默认保存密码和会话，用户可显式取消。 */
export const NO_POLICY: VaultPolicy = { rememberPassword: true, rememberSession: true }

/** 快照尚未到达:此时**禁止**任何提交(否则会以兜底值覆盖真实策略) */
export function policyReady(status: VaultStatusSnapshot | null): boolean {
  return status !== null
}

/** 某实例的有效策略;快照未到达时返回兜底值(仅供渲染,不可用于提交) */
export function effectivePolicy(
  status: VaultStatusSnapshot | null,
  instanceId: string
): VaultPolicy {
  return status?.policies[instanceId] ?? NO_POLICY
}

/** 是否可以在该快照下提交策略变更 */
export function canSubmitPolicy(status: VaultStatusSnapshot | null, busy: boolean): boolean {
  return policyReady(status) && !busy
}
