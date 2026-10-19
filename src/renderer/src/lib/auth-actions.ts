/**
 * 认证操作的可见性判定。保持为纯函数，便于测试。
 * 本地实例使用 BrowserAuth，且 authMode 为 `none` 的实例不显示认证操作。
 */
export function showAuthActions(record: { transport: string; authMode: string }): boolean {
  return record.transport !== 'local' && record.authMode !== 'none'
}
