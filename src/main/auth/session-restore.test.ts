import { describe, expect, it, vi } from 'vitest'
import { createCookieJar } from './cookie-jar'
import { restoreSessionFromVault, sessionCookieHeader } from './session-restore'
import type { StoredSession, Vault } from '../vault/vault'

const NOW = 1_800_000_000_000

/** 最小 vault 假实现(只覆盖复用路径用到的三个方法) */
function fakeVault(over: { rememberSession?: boolean; session?: StoredSession | null }): {
  vault: Vault
  forgetSession: ReturnType<typeof vi.fn>
} {
  const forgetSession = vi.fn(async () => undefined)
  const vault = {
    getPolicy: () => ({
      rememberPassword: false,
      rememberSession: over.rememberSession ?? true
    }),
    getSession: () => over.session ?? null,
    forgetSession
  } as unknown as Vault
  return { vault, forgetSession }
}

const SESSION: StoredSession = {
  name: 'dsh_auth',
  value: 'sess-token',
  expiresAt: NOW + 86_400_000
}

const freshClient = (): { jar: ReturnType<typeof createCookieJar> } => ({
  jar: createCookieJar(() => NOW)
})

describe('session-restore（/重启静默复用登录态）', () => {
  it('勾选且记录未过期 → 会话被恢复到 Cookie 罐', async () => {
    const { vault } = fakeVault({ session: SESSION })
    const client = freshClient()
    expect(client.jar.get('dsh_auth')).toBeNull()

    const restored = await restoreSessionFromVault({ vault, now: () => NOW }, 'i1', client)
    expect(restored).toBe(true)
    expect(client.jar.get('dsh_auth')?.value).toBe('sess-token')
    // 恢复后探测才会走 hasSession() 的静默分支
    expect(client.jar.header()).toContain('dsh_auth=sess-token')
  })

  it('未勾选「记住登录态」→ 不复用(与写入侧对称的前置条件)', async () => {
    const { vault } = fakeVault({ rememberSession: false, session: SESSION })
    const client = freshClient()
    expect(await restoreSessionFromVault({ vault, now: () => NOW }, 'i1', client)).toBe(false)
    expect(client.jar.get('dsh_auth')).toBeNull()
  })

  it('无记录 → 不复用', async () => {
    const { vault } = fakeVault({ session: null })
    const client = freshClient()
    expect(await restoreSessionFromVault({ vault, now: () => NOW }, 'i1', client)).toBe(false)
  })

  it('已过期的会话:不复用,并顺手清掉 vault 条目(不留死数据)', async () => {
    const { vault, forgetSession } = fakeVault({
      session: { ...SESSION, expiresAt: NOW - 1000 }
    })
    const client = freshClient()
    expect(await restoreSessionFromVault({ vault, now: () => NOW }, 'i1', client)).toBe(false)
    expect(client.jar.get('dsh_auth')).toBeNull()
    expect(forgetSession).toHaveBeenCalledWith('i1')
  })

  it('罐里已有同名 Cookie → 不覆盖(内存态更新)', async () => {
    const { vault } = fakeVault({ session: SESSION })
    const client = freshClient()
    client.jar.store(['dsh_auth=fresher; Path=/'])
    expect(await restoreSessionFromVault({ vault, now: () => NOW }, 'i1', client)).toBe(true)
    expect(client.jar.get('dsh_auth')?.value).toBe('fresher')
  })

  it('空值会话不恢复', async () => {
    const { vault } = fakeVault({ session: { ...SESSION, value: '' } })
    const client = freshClient()
    expect(await restoreSessionFromVault({ vault, now: () => NOW }, 'i1', client)).toBe(false)
  })

  it('vault 抛错不外抛(复用登录态是尽力而为)', async () => {
    const vault = {
      getPolicy: () => {
        throw new Error('vault 文件损坏')
      }
    } as unknown as Vault
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(
      restoreSessionFromVault({ vault, now: () => NOW }, 'i1', freshClient())
    ).resolves.toBe(false)
    errorSpy.mockRestore()
  })

  it('Set-Cookie 头沿用网关属性(Path=/; HttpOnly; SameSite=Strict)', () => {
    const header = sessionCookieHeader({ ...SESSION, expiresAt: null })
    expect(header).toBe('dsh_auth=sess-token; Path=/; HttpOnly; SameSite=Strict')
  })

  it('Max-Age 用注入时钟计算(与过期判断同一时间源)', () => {
    // 注意:网关在 HTTPS 客户端请求下会追加 `; Secure`;这里刻意不写死「无 Secure」,
    // 因为 StoredSession 不携带属性,Secure 在恢复时确实会丢失(已知取舍,见本文件注释)
    const header = sessionCookieHeader({ ...SESSION, expiresAt: NOW + 3600_000 }, () => NOW)
    expect(header).toContain('Max-Age=3600')
  })
})
