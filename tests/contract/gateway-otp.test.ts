/** Tests OTP, rate limiting, and basePath against dsh-auth-gateway. */
import { afterEach, describe, expect, it } from 'vitest'
import { createGatewayClient } from '../../src/main/auth/gateway-client'
import { startGatewayFixture } from '../../scripts/gateway-fixture.mjs'

interface Fixture {
  baseUrl: string
  password: string
  otpCode: () => string | null
  stop(): Promise<void>
}

const fixtures: Fixture[] = []
async function fixture(options: Record<string, unknown>): Promise<Fixture> {
  const created = (await startGatewayFixture(options)) as Fixture
  fixtures.push(created)
  return created
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.stop()))
})

describe('GatewayClient OTP integration', () => {
  it('OTP 必需时缺码 → 400 otp-required(进入验证码提问的权威信号)', async () => {
    const gw = await fixture({
      password: 'contract-pass-123!',
      otpEnabled: true,
      otpRequired: true
    })
    const client = createGatewayClient({ baseUrl: gw.baseUrl })
    const login = await client.login({ password: gw.password })
    expect(login.ok).toBe(false)
    if (!login.ok) {
      expect(login.status).toBe(400)
      expect(login.code).toBe('otp-required')
    }
  }, 30_000)

  it('单请求完成 2FA:密码 + 有效 TOTP → 200', async () => {
    const gw = await fixture({
      password: 'contract-pass-123!',
      otpEnabled: true,
      otpRequired: true
    })
    const client = createGatewayClient({ baseUrl: gw.baseUrl })
    const code = gw.otpCode()
    expect(code).toMatch(/^\d{6}$/)
    const login = await client.login({ password: gw.password, otp: code ?? '' })
    expect(login.ok).toBe(true)
    expect(client.hasSession()).toBe(true)
    // 会话完全验证:settings 可用
    expect((await client.settings()).ok).toBe(true)
  }, 30_000)

  it('密码对但验证码错 → 401 invalid-credentials(与密码错统一,不泄漏)', async () => {
    const gw = await fixture({
      password: 'contract-pass-123!',
      otpEnabled: true,
      otpRequired: true
    })
    const client = createGatewayClient({ baseUrl: gw.baseUrl })
    const bad = await client.login({ password: gw.password, otp: '000000' })
    expect(bad.ok).toBe(false)
    if (!bad.ok) {
      expect(bad.status).toBe(401)
      expect(bad.code).toBe('invalid-credentials')
    }
  }, 30_000)

  it('连续失败达上限 → 429 too-many-attempts + retryAfterSeconds(唯一计时依据)', async () => {
    const gw = await fixture({
      password: 'contract-pass-123!',
      maxLoginFailures: 2,
      lockMinutes: 5
    })
    const client = createGatewayClient({ baseUrl: gw.baseUrl })
    // 实测网关语义:第 maxLoginFailures 次失败即触发锁定(不是第 N+1 次)
    const first = await client.login({ password: 'wrong-1' })
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.status).toBe(401)
    const second = await client.login({ password: 'wrong-2' })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.status).toBe(429)
      expect(second.code).toBe('too-many-attempts')
      expect(second.retryAfterSeconds).toBeGreaterThan(0)
      expect(second.retryAfterSeconds).toBeLessThanOrEqual(5 * 60)
    }
    // 锁定期间即使密码正确也被拒(网关语义)
    const correctWhileLocked = await client.login({ password: gw.password })
    expect(correctWhileLocked.ok).toBe(false)
    if (!correctWhileLocked.ok) expect(correctWhileLocked.code).toBe('too-many-attempts')
  }, 30_000)

  it('basePath 前缀下所有端点仍可用', async () => {
    const gw = await fixture({ password: 'contract-pass-123!', basePath: '/dsh' })
    expect(gw.baseUrl).toMatch(/\/dsh$/)
    const client = createGatewayClient({ baseUrl: gw.baseUrl })
    const login = await client.login({ password: gw.password })
    expect(login.ok).toBe(true)
    const settings = await client.settings()
    expect(settings.ok).toBe(true)
  }, 30_000)

  it('settings 返回插件配置(otpEnabled/otpIssuer 等)', async () => {
    const gw = await fixture({ password: 'contract-pass-123!' })
    const client = createGatewayClient({ baseUrl: gw.baseUrl })
    await client.login({ password: gw.password })
    const settings = await client.settings()
    expect(settings.ok).toBe(true)
    if (settings.ok) {
      expect(typeof settings.value.otpEnabled).toBe('boolean')
      expect(settings.value.raw).toBeTruthy()
    }
  }, 30_000)
})
