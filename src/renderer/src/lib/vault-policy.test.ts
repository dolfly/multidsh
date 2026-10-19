import { describe, expect, it } from 'vitest'
import type { VaultStatusSnapshot } from '@shared/contracts'
import { canSubmitPolicy, effectivePolicy, policyReady } from './vault-policy'

const snapshot = (
  policies: Record<string, { rememberPassword: boolean; rememberSession: boolean }>
): VaultStatusSnapshot => ({
  available: true,
  degraded: false,
  rememberedInstances: Object.keys(policies),
  policies
})

describe('vault-policy', () => {
  it('快照到达前不可提交(否则会用兜底全 false 覆盖真实策略,静默删凭据)', () => {
    expect(policyReady(null)).toBe(false)
    expect(canSubmitPolicy(null, false)).toBe(false)
    expect(canSubmitPolicy(snapshot({}), false)).toBe(true)
    expect(canSubmitPolicy(snapshot({}), true)).toBe(false)
  })

  it('已有策略但尚无凭据时仍返回策略', () => {
    // 用户勾了「记住密码」但还没登录成功 —— 此时 rememberedInstances 为空
    const status = snapshot({ i1: { rememberPassword: true, rememberSession: false } })
    expect(status.rememberedInstances).toEqual(['i1'])
    expect(effectivePolicy(status, 'i1')).toEqual({
      rememberPassword: true,
      rememberSession: false
    })
    // 使用 rememberedInstances 不能推导策略。
  })

  it('未设策略的实例默认勾选;快照为 null 同样返回默认值', () => {
    expect(effectivePolicy(snapshot({}), 'i1')).toEqual({
      rememberPassword: true,
      rememberSession: true
    })
    expect(effectivePolicy(null, 'i1')).toEqual({
      rememberPassword: true,
      rememberSession: true
    })
  })

  it('多实例各自独立(不会串味)', () => {
    const status = snapshot({
      a: { rememberPassword: true, rememberSession: false },
      b: { rememberPassword: false, rememberSession: true }
    })
    expect(effectivePolicy(status, 'a').rememberPassword).toBe(true)
    expect(effectivePolicy(status, 'b').rememberPassword).toBe(false)
    expect(effectivePolicy(status, 'b').rememberSession).toBe(true)
  })
})
