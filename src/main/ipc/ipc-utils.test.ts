import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultVerifyExternalAccess,
  externalAccessToken,
  externalAccessUrl,
  upgradeEligibility
} from './ipc-utils'
import { InstanceStoreError } from '../registry/instance-store'
import type { InstanceRecord } from '@shared/contracts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('externalAccessToken', () => {
  it('裸 token 原样返回', () => {
    expect(externalAccessToken('abc123', 8080)).toBe('abc123')
  })

  it('裸 token 含空白拒绝', () => {
    expect(() => externalAccessToken('ab c', 8080)).toThrow(InstanceStoreError)
  })

  it('回环 URL 提取 token', () => {
    expect(externalAccessToken('http://127.0.0.1:8080/?token=xyz', 8080)).toBe('xyz')
    expect(externalAccessToken('http://[::1]:8080/?token=xyz', 8080)).toBe('xyz')
  })

  it('非回环主机、错端口、带认证信息或缺 token 一律拒绝', () => {
    expect(() => externalAccessToken('http://10.0.0.1:8080/?token=xyz', 8080)).toThrow()
    expect(() => externalAccessToken('http://127.0.0.1:9090/?token=xyz', 8080)).toThrow()
    expect(() => externalAccessToken('http://u:p@127.0.0.1:8080/?token=xyz', 8080)).toThrow()
    expect(() => externalAccessToken('http://127.0.0.1:8080/', 8080)).toThrow()
    expect(() => externalAccessToken('https://127.0.0.1:8080/?token=xyz', 8080)).toThrow()
  })

  it('token 含控制字符拒绝', () => {
    expect(() => externalAccessToken('http://127.0.0.1:8080/?token=a%00b', 8080)).toThrow()
  })
})

describe('externalAccessUrl', () => {
  it('拼回环端口并对 token 转义', () => {
    expect(externalAccessUrl('a b', 8080)).toBe('http://127.0.0.1:8080/?token=a%20b')
  })
})

describe('defaultVerifyExternalAccess', () => {
  it('200 视为通过，401/403 视为未通过', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200 }) as Response)
    )
    await expect(defaultVerifyExternalAccess('http://127.0.0.1:8080/')).resolves.toBe(true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 401 }) as Response)
    )
    await expect(defaultVerifyExternalAccess('http://127.0.0.1:8080/')).resolves.toBe(false)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 403 }) as Response)
    )
    await expect(defaultVerifyExternalAccess('http://127.0.0.1:8080/')).resolves.toBe(false)
  })

  it('慢响应超过探测超时即中止并抛错', async () => {
    // fetch 永不主动完成，只在 signal abort 时按真实语义 reject；用可注入的短超时确定性驱动。
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
              )
            )
          })
      )
    )
    await expect(defaultVerifyExternalAccess('http://127.0.0.1:8080/', 10)).rejects.toThrow()
  })
})

describe('upgradeEligibility', () => {
  const local = { transport: 'local' } as InstanceRecord
  const ssh = { transport: 'ssh' } as InstanceRecord

  it('本地非外部接管可升级', () => {
    expect(upgradeEligibility(local, undefined)).toEqual({ canUpgrade: true })
  })

  it('外部接管不可升级', () => {
    expect(upgradeEligibility(local, 'external')).toEqual({
      canUpgrade: false,
      reason: 'runtime-external'
    })
  })

  it('非本地不可升级', () => {
    expect(upgradeEligibility(ssh, undefined)).toEqual({ canUpgrade: false, reason: 'not-local' })
  })
})
