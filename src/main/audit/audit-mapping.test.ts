import { describe, expect, it } from 'vitest'
import { mapAuthTransition, mapRuntimeTransition } from './audit-mapping'
import type { AuthStateLike, RuntimeStatusLike } from './audit-mapping'

const auth = (over: Partial<AuthStateLike> = {}): AuthStateLike => ({
  phase: 'await-credentials',
  lockedForMs: 0,
  lastErrorCode: null,
  ...over
})

const runtime = (status: RuntimeStatusLike['status']): RuntimeStatusLike => ({ status })

describe('audit-mapping（ 状态迁移 → 事件枚举）', () => {
  it('进入 connected = login-success', () => {
    expect(
      mapAuthTransition('i1', auth({ phase: 'await-otp' }), auth({ phase: 'connected' }))
    ).toEqual([{ instanceId: 'i1', event: 'login-success', result: 'ok' }])
  })

  it('持续 connected 不重复记 login-success(幂等)', () => {
    expect(
      mapAuthTransition('i1', auth({ phase: 'connected' }), auth({ phase: 'connected' }))
    ).toEqual([])
  })

  it('从 connected 掉回需要凭据 = session-revoked', () => {
    expect(
      mapAuthTransition('i1', auth({ phase: 'connected' }), auth({ phase: 'await-credentials' }))
    ).toEqual([{ instanceId: 'i1', event: 'session-revoked', result: 'unauthenticated' }])
    expect(
      mapAuthTransition(
        'i1',
        auth({ phase: 'connected' }),
        auth({ phase: 'needs-auth', lastErrorCode: 'invalid-credentials' })
      )
    ).toEqual([{ instanceId: 'i1', event: 'session-revoked', result: 'invalid-credentials' }])
  })

  it('锁定 = lockout(优先于其它失败归类)', () => {
    expect(
      mapAuthTransition(
        'i1',
        auth({ phase: 'await-credentials' }),
        auth({
          phase: 'await-credentials',
          lockedForMs: 60_000,
          lastErrorCode: 'too-many-attempts'
        })
      )
    ).toEqual([{ instanceId: 'i1', event: 'lockout', result: 'too-many-attempts' }])
  })

  it('锁定倒计时刷新不会重复写 lockout 审计', () => {
    expect(
      mapAuthTransition(
        'i1',
        auth({ lockedForMs: 60_000, lastErrorCode: 'too-many-attempts' }),
        auth({ lockedForMs: 59_000, lastErrorCode: 'too-many-attempts' })
      )
    ).toEqual([])
  })

  it('限流 = rate-limited', () => {
    expect(
      mapAuthTransition(
        'i1',
        auth({ phase: 'await-credentials' }),
        auth({ phase: 'await-credentials', lastErrorCode: 'rate-limited' })
      )
    ).toEqual([{ instanceId: 'i1', event: 'rate-limited', result: 'rate-limited' }])
  })

  it('凭据错误 = login-failed(只记错误码)', () => {
    expect(
      mapAuthTransition(
        'i1',
        auth({ phase: 'await-credentials' }),
        auth({ phase: 'await-credentials', lastErrorCode: 'invalid-credentials' })
      )
    ).toEqual([{ instanceId: 'i1', event: 'login-failed', result: 'invalid-credentials' }])
    expect(
      mapAuthTransition(
        'i1',
        auth({ phase: 'await-otp' }),
        auth({ phase: 'await-otp', lastErrorCode: 'invalid-credentials' })
      )
    ).toEqual([{ instanceId: 'i1', event: 'login-failed', result: 'invalid-credentials' }])
  })

  it('首次观测(prev=null)的失败不记成登录失败 —— 那只是探测', () => {
    expect(
      mapAuthTransition('i1', null, auth({ phase: 'await-credentials', lastErrorCode: 'network' }))
    ).toEqual([])
    expect(mapAuthTransition('i1', null, auth({ phase: 'needs-auth' }))).toEqual([])
    // 但首次观测到「已连接」要记(重启后静默复用会话)
    expect(mapAuthTransition('i1', null, auth({ phase: 'connected' }))).toEqual([
      { instanceId: 'i1', event: 'login-success', result: 'ok' }
    ])
  })

  it('无错误码的状态变化不产生虚假失败事件', () => {
    expect(
      mapAuthTransition('i1', auth({ phase: 'await-otp' }), auth({ phase: 'await-credentials' }))
    ).toEqual([])
    expect(mapAuthTransition('i1', auth({ phase: 'probe' }), auth({ phase: 'unknown' }))).toEqual(
      []
    )
  })

  it('审计条目只有白名单字段(没有 message/status 等额外信息)', () => {
    const [entry] = mapAuthTransition(
      'i1',
      auth({ phase: 'await-credentials' }),
      auth({ phase: 'await-credentials', lockedForMs: 1000, lastErrorCode: 'too-many-attempts' })
    )
    expect(Object.keys(entry ?? {}).sort()).toEqual(['event', 'instanceId', 'result'])
  })

  it('运行时:进入 running = connect;离开 = disconnect', () => {
    expect(mapRuntimeTransition('i1', runtime('starting'), runtime('running'))).toEqual([
      { instanceId: 'i1', event: 'connect', result: 'ok' }
    ])
    expect(mapRuntimeTransition('i1', runtime('running'), runtime('stopped'))).toEqual([
      { instanceId: 'i1', event: 'disconnect', result: 'ok' }
    ])
    // 幂等:持续 running / 持续 stopped 不重复记
    expect(mapRuntimeTransition('i1', runtime('running'), runtime('running'))).toEqual([])
    expect(mapRuntimeTransition('i1', runtime('stopped'), runtime('stopped'))).toEqual([])
  })

  it('运行时:进入 error = ssh-exit;从 error/stopped 重新 starting = ssh-reconnect', () => {
    expect(mapRuntimeTransition('i1', runtime('running'), runtime('error'))).toEqual([
      { instanceId: 'i1', event: 'ssh-exit', result: 'error' }
    ])
    expect(mapRuntimeTransition('i1', runtime('error'), runtime('error'))).toEqual([])
    expect(mapRuntimeTransition('i1', runtime('error'), runtime('starting'))).toEqual([
      { instanceId: 'i1', event: 'ssh-reconnect', result: 'ok' }
    ])
    expect(mapRuntimeTransition('i1', runtime('stopped'), runtime('starting'))).toEqual([
      { instanceId: 'i1', event: 'ssh-reconnect', result: 'ok' }
    ])
    // 首次启动(starting → starting 之外)不算重连
    expect(mapRuntimeTransition('i1', null, runtime('starting'))).toEqual([])
  })
})
