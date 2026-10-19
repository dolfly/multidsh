/**
 * 认证通道：探测、登录、静默复用已存密码与登出；同时装配供主进程在 IPC 之外
 * 触发探测的 AuthProbeController。登录记忆只在本次注册的闭包内，不跨 registerIpc 共享。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { AUTH_IPC, type AuthStateSnapshot, type IpcResult } from '@shared/contracts'
import { InstanceStoreError } from '../registry/instance-store'
import type { AuthRegistry } from '../auth/auth-registry'
import type { Vault } from '../vault/vault'
import type { AuditEntry } from '../audit/audit-log'
import { parseId, probeWithStoredPassword, type IpcWrap, type StoredLoginMemory } from './ipc-utils'

export interface AuthHandlerDeps {
  auth: AuthRegistry
  vault: Vault
  clearPartitionSession?: (instanceId: string) => Promise<void>
  audit?: (entry: AuditEntry) => void
}

/** 主进程在 IPC 之外触发一次认证探测（含已存密码静默登录）的控制器。 */
export interface AuthProbeController {
  probe(instanceId: string): Promise<AuthStateSnapshot | null>
}

export function registerAuthHandlers(deps: AuthHandlerDeps, wrap: IpcWrap): AuthProbeController {
  const memory: StoredLoginMemory = {
    storedLoginAttempted: new Set<string>(),
    logoutSuppressed: new Set<string>()
  }

  const probe = (instanceId: string): Promise<AuthStateSnapshot | null> =>
    probeWithStoredPassword(deps, memory, instanceId)

  /**
   * 写 vault 的「安静」包装:凭据记忆是**尽力而为**的附加动作,
   * 失败(磁盘满/钥匙串不可用)绝不能把一次成功的登录变成错误。
   */
  async function rememberQuietly(instanceId: string, password: string): Promise<void> {
    // 未勾选「记住密码」：不写入也不是错误（默认策略即不勾选）
    if (!deps.vault.getPolicy(instanceId).rememberPassword) return
    try {
      await deps.vault.rememberPassword(instanceId, password)
    } catch (error) {
      console.error('[register] 记住密码失败(登录已成功)：', error)
    }
  }

  /**
   * 主进程自行读取。门禁:策略允许记住密码且 vault 里确有该实例的密码,
   * 否则 invalid-input(渲染层无从绕过:通道只收实例 id 与可选 OTP)。
   */
  function loginWithStored(instanceId: string, otp?: string): Promise<AuthStateSnapshot | null> {
    if (!deps.vault.getPolicy(instanceId).rememberPassword) {
      throw new InstanceStoreError('invalid-input', '未勾选「记住密码」，没有已保存的密码可用')
    }
    const stored = deps.vault.getPassword(instanceId)
    if (stored === null) {
      throw new InstanceStoreError('invalid-input', '保险库中没有该实例的已存密码')
    }
    return deps.auth.login(instanceId, stored, otp)
  }

  // Try one silent login when probing finds a stored password and an authentication state.
  ipcMain.handle(
    AUTH_IPC.probe,
    (_event, id: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
      wrap(async () => probe(parseId(id)))
  )

  ipcMain.handle(
    AUTH_IPC.login,
    (
      _event,
      id: unknown,
      password: unknown,
      otp: unknown
    ): Promise<IpcResult<AuthStateSnapshot | null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const pwd = z.string().min(1).max(1024).parse(password)
        // 验证码/备份码域:网关 TOTP 位数**可配**(`otpDigits`,默认 6,合法 4-10),
        // 备份码长度也可配(`backupCodeLength`,默认 8,合法 6-12)。
        // 完全无法登录(合法验证码被 zod 拒掉)。
        const code = z
          .string()
          .trim()
          .min(4)
          .max(12)
          .nullable()
          .parse(otp ?? null)
        const state = await deps.auth.login(instanceId, pwd, code ?? undefined)
        // 失败绝不写(否则一次错误输入会把错密码存进钥匙串);未勾选时 vault 自身也会拒绝。
        if (state?.phase === 'connected' && deps.vault.getPolicy(instanceId).rememberPassword) {
          await rememberQuietly(instanceId, pwd)
          deps.audit?.({ instanceId, event: 'vault-write', result: 'password' })
        }
        // A successful manual login allows future silent login attempts.
        if (state?.phase === 'connected') memory.logoutSuppressed.delete(instanceId)
        return state
      })
  )

  // 策略允许且 vault 里确有密码，否则 invalid-input；密码不跨 IPC。
  ipcMain.handle(
    AUTH_IPC.loginStored,
    (_event, id: unknown, otp: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        // OTP 域与 auth:login 同口径:otpDigits 可配(合法 4-10)、备份码 6-12,下界 4
        const code = z
          .string()
          .trim()
          .min(4)
          .max(12)
          .nullable()
          .parse(otp ?? null)
        const snapshot = await loginWithStored(instanceId, code ?? undefined)
        // 与 auth:login 同口径:用户以已存密码显式登录成功 = 重新表态,解除登出压制
        if (snapshot?.phase === 'connected') memory.logoutSuppressed.delete(instanceId)
        return snapshot
      })
  )

  ipcMain.handle(
    AUTH_IPC.logout,
    (_event, id: unknown): Promise<IpcResult<AuthStateSnapshot | null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        // 登出窗口：期间并发探测不得从 vault 恢复会话、不得静默登录、不回写会话；
        // 分区 Cookie 与 vault 会话清理完成后窗口才结束。
        deps.auth.beginLogout(instanceId)
        try {
          const snapshot = await deps.auth.logout(instanceId)
          // 「登出 → 任何探测」会立刻用已存密码复活会话。手动登录成功才解除。
          memory.logoutSuppressed.add(instanceId)
          // 清理是尽力而为：单步失败不拖垮后续步骤（否则 vault 遗忘与两条审计都会被跳过），
          // 但失败必须留痕——console 记原因，审计把 cookie-cleared 如实标 failed。
          let cookieCleared = true
          try {
            await deps.clearPartitionSession?.(instanceId)
          } catch (error) {
            cookieCleared = false
            console.error('[ipc] 登出时清理分区会话失败：', instanceId, error)
          }
          // 登出时忘掉 vault 中的会话:否则重启后 restoreSessionFromVault 会恢复已失效的登录态
          await deps.vault.forgetSession(instanceId).catch(() => undefined)
          deps.audit?.({ instanceId, event: 'session-revoked', result: 'logout' })
          deps.audit?.({
            instanceId,
            event: 'cookie-cleared',
            result: cookieCleared ? 'logout' : 'failed'
          })
          return snapshot
        } finally {
          deps.auth.endLogout(instanceId)
        }
      })
  )

  return { probe }
}
