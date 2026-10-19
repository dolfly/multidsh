import { describe, expect, it } from 'vitest'
import type { AuthStateEvent, AuthStateSnapshot } from '@shared/contracts'
import {
  applyAuthSnapshot,
  applyAuthState,
  clearLock,
  closeAuthPanel,
  initialAuthPanelModel,
  lockRemaining,
  lockSeconds,
  openAuthPanel,
  shouldReopenWorkspace
} from './auth-panel-state'
import type { AuthPanelModel } from './auth-panel-state'

const T0 = 1_700_000_000_000

function snapshot(over: Partial<AuthStateSnapshot> = {}): AuthStateSnapshot {
  return {
    phase: 'await-credentials',
    needsOnboarding: false,
    otpEnabled: false,
    lockedForMs: 0,
    message: null,
    lastErrorCode: null,
    ...over
  }
}

function event(instanceId: string, state: AuthStateSnapshot): AuthStateEvent {
  return { instanceId, state, at: new Date(T0).toISOString() }
}

const openA = (): AuthPanelModel =>
  openAuthPanel(initialAuthPanelModel, { id: 'inst-a', name: '甲' })

describe('auth-panel-state', () => {
  it('面板关闭时收到 auth:state 不自动弹面板', () => {
    const model = applyAuthState(
      initialAuthPanelModel,
      event('inst-a', snapshot({ phase: 'needs-auth' })),
      T0
    )
    expect(model).toEqual(initialAuthPanelModel)
  })

  it('跨实例串台防线:为甲打开时,乙的状态不得覆盖', () => {
    const opened = applyAuthState(openA(), event('inst-a', snapshot({ phase: 'needs-auth' })), T0)
    expect(opened.state?.phase).toBe('needs-auth')

    const other = applyAuthState(
      opened,
      event('inst-b', snapshot({ phase: 'await-otp', message: '乙的消息' })),
      T0
    )
    expect(other.target?.id).toBe('inst-a')
    expect(other.state?.phase).toBe('needs-auth')
    expect(other.state?.message).toBeNull()
  })

  it('同实例事件正常更新', () => {
    const opened = applyAuthState(openA(), event('inst-a', snapshot({ phase: 'needs-auth' })), T0)
    const next = applyAuthState(opened, event('inst-a', snapshot({ phase: 'await-otp' })), T0)
    expect(next.state?.phase).toBe('await-otp')
  })

  it('connected 关闭面板', () => {
    const opened = applyAuthState(openA(), event('inst-a', snapshot({ phase: 'needs-auth' })), T0)
    const done = applyAuthState(opened, event('inst-a', snapshot({ phase: 'connected' })), T0)
    expect(done.target).toBeNull()
    expect(done.state).toBeNull()
  })

  it('锁定换算为绝对到期时刻，剩余时间随时钟递减', () => {
    const opened = openAuthPanel(initialAuthPanelModel, { id: 'inst-a', name: '甲' })
    const locked = applyAuthState(
      opened,
      event('inst-a', snapshot({ phase: 'await-credentials', lockedForMs: 30_000 })),
      T0
    )
    expect(locked.lockUntil).toBe(T0 + 30_000)
    expect(lockRemaining(locked, T0)).toBe(30_000)
    expect(lockRemaining(locked, T0 + 10_000)).toBe(20_000)
    expect(lockRemaining(locked, T0 + 30_000)).toBe(0)
    expect(lockSeconds(locked, T0 + 1)).toBe(30)
  })

  it('未锁定时 lockUntil 为 null 且不残留上次锁定', () => {
    const opened = openAuthPanel(initialAuthPanelModel, { id: 'inst-a', name: '甲' })
    const locked = applyAuthState(opened, event('inst-a', snapshot({ lockedForMs: 30_000 })), T0)
    expect(locked.lockUntil).not.toBeNull()
    const unlocked = applyAuthState(
      locked,
      event('inst-a', snapshot({ lockedForMs: 0 })),
      T0 + 1000
    )
    expect(unlocked.lockUntil).toBeNull()
  })

  it('登录返回的快照走同一归约(锁定同样换算)', () => {
    const opened = openAuthPanel(initialAuthPanelModel, { id: 'inst-a', name: '甲' })
    const model = applyAuthSnapshot(
      opened,
      'inst-a',
      snapshot({ phase: 'await-credentials', lockedForMs: 5_000 }),
      T0
    )
    expect(model.lockUntil).toBe(T0 + 5_000)
    // 非本实例的快照被忽略
    expect(applyAuthSnapshot(opened, 'inst-b', snapshot(), T0)).toEqual(opened)
  })

  it('切换到另一实例时清掉上一实例的状态(不显示错的身份快照)', () => {
    const opened = applyAuthState(openA(), event('inst-a', snapshot({ phase: 'needs-auth' })), T0)
    const switched = openAuthPanel(opened, { id: 'inst-b', name: '乙' })
    expect(switched.target?.id).toBe('inst-b')
    expect(switched.state).toBeNull()
  })

  it('到期后无条件解除锁定，即使重探失败', () => {
    const opened = openAuthPanel(initialAuthPanelModel, { id: 'inst-a', name: '甲' })
    const locked = applyAuthState(
      opened,
      event('inst-a', snapshot({ phase: 'await-credentials', lockedForMs: 30_000 })),
      T0
    )
    // 到期时 clearLock 必须把 lockUntil 置空,且不依赖任何重探结果
    expect(lockRemaining(locked, T0 + 30_000)).toBe(0)
    const unlocked = clearLock(locked)
    expect(unlocked.lockUntil).toBeNull()
    expect(lockRemaining(unlocked, T0 + 30_000)).toBe(0)
    // 状态本身保留(仍然是等待凭据,用户可再次提交)
    expect(unlocked.state?.phase).toBe('await-credentials')
    // 幂等
    expect(clearLock(unlocked)).toBe(unlocked)
  })

  it('关闭面板清空全部状态', () => {
    const opened = applyAuthState(openA(), event('inst-a', snapshot({ lockedForMs: 1000 })), T0)
    expect(closeAuthPanel()).toEqual(initialAuthPanelModel)
    expect(opened.target).not.toBeNull()
  })

  it('工作区认证信号不把全局认证面板从关闭状态打开', () => {
    expect(
      applyAuthState(initialAuthPanelModel, event('inst-a', snapshot({ phase: 'needs-auth' })), T0)
    ).toEqual(initialAuthPanelModel)
  })
})

describe('shouldReopenWorkspace', () => {
  const base = {
    phase: 'connected' as const,
    previousPhase: 'await-credentials' as const,
    workspaceConnected: true,
    workspaceOpen: false,
    overlayBusy: false
  }

  it('从已连接工作区重新登录成功后自动重开', () => {
    expect(shouldReopenWorkspace(base)).toBe(true)
  })

  it('未连接过工作区（首次从详情页登录）不自动打开', () => {
    expect(shouldReopenWorkspace({ ...base, workspaceConnected: false })).toBe(false)
  })

  it('登录未成功不打开', () => {
    expect(shouldReopenWorkspace({ ...base, phase: 'await-otp' })).toBe(false)
  })

  it('上一相位已是 connected（并非重新登录跃迁）不重复打开', () => {
    expect(shouldReopenWorkspace({ ...base, previousPhase: 'connected' })).toBe(false)
  })

  it('工作区已在前台时不重复打开', () => {
    expect(shouldReopenWorkspace({ ...base, workspaceOpen: true })).toBe(false)
  })

  it('向导/设置页遮挡或正在打开时不打开', () => {
    expect(shouldReopenWorkspace({ ...base, overlayBusy: true })).toBe(false)
  })
})
