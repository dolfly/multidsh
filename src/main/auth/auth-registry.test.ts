import { describe, expect, it, vi } from 'vitest'
import { createAuthRegistry } from './auth-registry'
import type { AuthClient } from './auth-client'
import type { AuthState } from './gateway-state'
import { initialState } from './gateway-state'

function fakeClient(): AuthClient {
  const jar = {
    get: () => null,
    header: () => null,
    store: () => undefined,
    clear: () => undefined,
    describe: () => []
  }
  return {
    instanceId: 'i1',
    jar: jar as unknown as AuthClient['jar'],
    backoff: {
      canAttempt: () => true,
      recordRateLimited: vi.fn(),
      recordSuccess: vi.fn(),
      state: () => ({ blocked: false, remainingMs: 0, reason: null }),
      now: () => 0
    },
    state: () => initialState(),
    probeAndRestore: vi.fn(async () => ({
      mode: 'gateway' as const,
      gatewayEvidence: 'login-page' as const,
      evidence: 'x',
      status: 302,
      at: 'now'
    })),
    login: vi.fn(async () => initialState()),
    logout: vi.fn(async () => initialState()),
    hasSession: () => false,
    tick: () => initialState()
  }
}

describe('auth-registry（每实例客户端）', () => {
  it('惰性创建:同一实例复用同一客户端;端点缺失返回 null', async () => {
    const factory = vi.fn(() => fakeClient())
    const registry = createAuthRegistry({
      resolveEndpoint: async (id) => (id === 'known' ? 'https://gw/dsh' : null),
      factory
    })
    expect(await registry.client('known')).not.toBeNull()
    expect(await registry.client('known')).not.toBeNull()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(await registry.client('missing')).toBeNull()
  })

  it('登录成功经注册表 onLoginSucceeded 透传(带 instanceId)；未成功不触发', async () => {
    const calls: string[] = []
    let succeeded = false
    const registry = createAuthRegistry({
      resolveEndpoint: async () => 'https://gw/dsh',
      factory: (clientOptions) => {
        const client = fakeClient()
        client.login = vi.fn(async () => {
          // 模拟真实客户端:仅在登录成功时回调
          if (succeeded) clientOptions.onLoginSucceeded?.()
          return {
            ...initialState(),
            phase: (succeeded ? 'connected' : 'needs-auth') as AuthState['phase']
          }
        })
        return client
      },
      onLoginSucceeded: (id) => calls.push(id)
    })
    await registry.login('i1', 'pw')
    expect(calls).toEqual([])
    succeeded = true
    await registry.login('i1', 'pw')
    expect(calls).toEqual(['i1'])
  })

  it('客户端状态变化经注册表 onState 广播(带 instanceId)', async () => {
    const seen: Array<[string, string]> = []
    let emit: ((state: AuthState) => void) | null = null
    const registry = createAuthRegistry({
      resolveEndpoint: async () => 'https://gw/dsh',
      factory: (clientOptions) => {
        emit = clientOptions.onState ?? null
        return fakeClient()
      },
      onState: (id, state) => seen.push([id, state.phase])
    })
    await registry.client('i1')
    expect(emit).not.toBeNull()
    // 客户端内部状态推进会经注册表透传出去(旧断言在建客户端前就断言为空,无判别力)
    emit!(initialState())
    expect(seen).toEqual([['i1', initialState().phase]])
  })

  it('并发闸已接线:maxConcurrentAuth=1 时两个实例的登录串行', async () => {
    let concurrent = 0
    let peak = 0
    const factory = (): AuthClient => ({
      ...fakeClient(),
      login: async () => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await new Promise((resolve) => setTimeout(resolve, 5))
        concurrent -= 1
        return initialState()
      }
    })
    const registry = createAuthRegistry({
      resolveEndpoint: async () => 'https://gw/dsh',
      factory,
      maxConcurrentAuth: 1
    })
    await Promise.all([registry.login('i1', 'pw'), registry.login('i2', 'pw')])
    expect(peak).toBe(1)
  })

  it('forget 后重新创建;logout 清除客户端', async () => {
    const factory = vi.fn(() => fakeClient())
    const registry = createAuthRegistry({ resolveEndpoint: async () => 'https://gw/dsh', factory })
    await registry.client('i1')
    registry.forget('i1')
    await registry.client('i1')
    expect(factory).toHaveBeenCalledTimes(2)
    await registry.logout('i1')
    expect(registry.stateOf('i1')).toBeNull()
  })

  it('probe/login/submit 在端点缺失时返回 null(不抛)', async () => {
    const registry = createAuthRegistry({
      resolveEndpoint: async () => null,
      factory: () => fakeClient()
    })
    expect(await registry.probe('x')).toBeNull()
    expect(await registry.login('x', 'pw')).toBeNull()
  })

  it('sessionCookie 无会话返回 null', async () => {
    const registry = createAuthRegistry({
      resolveEndpoint: async () => 'https://gw',
      factory: () => fakeClient()
    })
    await registry.client('i1')
    expect(registry.sessionCookie('i1')).toBeNull()
  })

  it('restore 钩子在返回客户端之前被 await(重启静默复用的顺序前提)', async () => {
    const order: string[] = []
    const registry = createAuthRegistry({
      resolveEndpoint: async () => 'https://gw/dsh',
      factory: () => fakeClient(),
      restore: async (instanceId) => {
        order.push(`restore:${instanceId}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push('restore-done')
      }
    })
    await registry.client('i1')
    order.push('client-returned')
    expect(order).toEqual(['restore:i1', 'restore-done', 'client-returned'])
  })

  it('restore 抛错既不影响客户端创建,也不阻断后续调用', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const registry = createAuthRegistry({
      resolveEndpoint: async () => 'https://gw/dsh',
      factory: () => fakeClient(),
      restore: () => {
        throw new Error('vault 不可用')
      }
    })
    await expect(registry.client('i1')).resolves.not.toBeNull()
    expect(await registry.client('i1')).not.toBeNull()
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('restore 只在创建时调用一次(后续 client() 复用不重复恢复)', async () => {
    const restore = vi.fn(async () => undefined)
    const registry = createAuthRegistry({
      resolveEndpoint: async () => 'https://gw/dsh',
      factory: () => fakeClient(),
      restore
    })
    await registry.client('i1')
    await registry.client('i1')
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('并发创建收敛为 single-flight:两次调用拿到同一客户端,工厂只跑一次', async () => {
    let releaseEndpoint!: () => void
    const endpointGate = new Promise<void>((resolve) => {
      releaseEndpoint = resolve
    })
    const factory = vi.fn(() => fakeClient())
    const registry = createAuthRegistry({
      resolveEndpoint: async () => {
        await endpointGate
        return 'https://gw/dsh'
      },
      factory
    })

    const first = registry.client('i1')
    const second = registry.client('i1')
    releaseEndpoint()
    const [a, b] = await Promise.all([first, second])

    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('登出窗口内创建客户端不从 vault 恢复会话,窗口结束后恢复', async () => {
    const restore = vi.fn(async () => undefined)
    const registry = createAuthRegistry({
      resolveEndpoint: async () => 'https://gw/dsh',
      factory: () => fakeClient(),
      restore
    })

    registry.beginLogout('i1')
    expect(registry.isLoggingOut('i1')).toBe(true)
    expect(await registry.client('i1')).not.toBeNull()
    expect(restore).not.toHaveBeenCalled()

    registry.endLogout('i1')
    registry.forget('i1')
    expect(registry.isLoggingOut('i1')).toBe(false)
    await registry.client('i1')
    expect(restore).toHaveBeenCalledTimes(1)
  })
})
