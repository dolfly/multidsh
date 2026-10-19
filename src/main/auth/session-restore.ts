/**
 *
 * 流程:应用启动 → 实例的 AuthClient 被惰性创建 → 若该实例勾选了「记住登录态」
 * 且 vault 里有未过期的会话 Cookie,就把它**按 `Set-Cookie` 形态**喂给 Cookie 罐
 * (复用网关真实解析路径,而不是绕过解析直接塞 Map)。
 * 之后 `probeAndRestore` 走 `hasSession()` 分支:带 Cookie 打 settings,
 * 200 即静默恢复到 `connected` —— 用户无需重新登录。
 *
 * 安全与正确性约定:
 * 1. **仅在策略允许时复用**，与写入侧保持对称；
 * 2. 已过期的会话直接丢弃并顺手清掉 vault 条目(不留死数据,也避免每次启动白试一次);
 * 3. 罐里已有同名 Cookie 时不覆盖(内存态比落盘态新);
 * 4. 失败不抛:复用登录态是尽力而为,失败就回到「需要登录」,不影响启动。
 */
import type { AuthClient } from './auth-client'
import type { StoredSession, Vault } from '../vault/vault'

export interface SessionRestoreDeps {
  vault: Vault
  /** 注入时钟(测试);会话过期判断用 */
  now?: () => number
}

/**
 * 把会话记录转成 `Set-Cookie` 头。
 * Cookie 属性与注入侧保持一致:网关的 `dsh_auth` 是 `Path=/; HttpOnly; SameSite=Strict`
 * (无 Secure —— 纯 HTTP/LAN 场景),这里刻意沿用,避免两条路径属性分叉。
 */
export function sessionCookieHeader(
  session: StoredSession,
  now: () => number = () => Date.now()
): string {
  const parts = [`${session.name}=${session.value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict']
  if (session.expiresAt !== null) {
    const maxAgeSeconds = Math.floor((session.expiresAt - now()) / 1000)
    if (maxAgeSeconds > 0) parts.push(`Max-Age=${maxAgeSeconds}`)
  }
  return parts.join('; ')
}

/**
 * 按策略把 vault 里的会话恢复到实例的 Cookie 罐。
 * @returns 是否真的恢复了(未勾选 / 无记录 / 已过期 / 罐里已有 都返回 false)
 */
export async function restoreSessionFromVault(
  deps: SessionRestoreDeps,
  instanceId: string,
  client: Pick<AuthClient, 'jar'>
): Promise<boolean> {
  const now = deps.now ?? (() => Date.now())
  try {
    if (!deps.vault.getPolicy(instanceId).rememberSession) return false
    const stored = deps.vault.getSession(instanceId)
    if (!stored || stored.value === '') return false

    if (stored.expiresAt !== null && stored.expiresAt <= now()) {
      // 过期会话:清掉,避免每次启动都白试一次
      await deps.vault.forgetSession(instanceId)
      return false
    }

    // 内存态比落盘态新:已有同名 Cookie 就不覆盖
    if (client.jar.get(stored.name) !== null) return true

    client.jar.store([sessionCookieHeader(stored, now)])
    return client.jar.get(stored.name) !== null
  } catch (error) {
    console.error('[session-restore] 复用已记住的登录态失败：', error)
    return false
  }
}
