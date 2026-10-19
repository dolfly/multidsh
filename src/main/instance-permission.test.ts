import { describe, expect, it, vi } from 'vitest'
import { installInstancePermissionPolicy, isAllowedInstancePermission } from './instance-permission'

describe('isAllowedInstancePermission', () => {
  it('放行剪贴板写入类权限', () => {
    expect(isAllowedInstancePermission('clipboard-write')).toBe(true)
    expect(isAllowedInstancePermission('clipboard-sanitized-write')).toBe(true)
  })

  it('media 仅当请求类型全部为 audio 时放行', () => {
    expect(isAllowedInstancePermission('media', ['audio'])).toBe(true)
    expect(isAllowedInstancePermission('media', ['video'])).toBe(false)
    expect(isAllowedInstancePermission('media', ['audio', 'video'])).toBe(false)
    // 非 media 请求不带媒体类型;media 请求缺媒体类型时按拒绝处理
    expect(isAllowedInstancePermission('media')).toBe(false)
    expect(isAllowedInstancePermission('media', [])).toBe(false)
  })

  it('其余权限一律拒绝', () => {
    for (const permission of [
      'notifications',
      'geolocation',
      'display-capture',
      'clipboard-read',
      'midi',
      'unknown'
    ]) {
      expect(isAllowedInstancePermission(permission)).toBe(false)
      expect(isAllowedInstancePermission(permission, ['audio'])).toBe(false)
    }
  })
})

describe('installInstancePermissionPolicy', () => {
  function fakeSession() {
    return {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn()
    } as unknown as Electron.Session & {
      setPermissionRequestHandler: ReturnType<typeof vi.fn>
      setPermissionCheckHandler: ReturnType<typeof vi.fn>
    }
  }

  it('请求 handler 按 mediaTypes 判定,缺省 details 不抛错', () => {
    const session = fakeSession()
    installInstancePermissionPolicy(session)
    const request = session.setPermissionRequestHandler.mock.calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details?: unknown
    ) => void

    const callback = vi.fn()
    request(null, 'media', callback, { mediaTypes: ['audio'] })
    expect(callback).toHaveBeenLastCalledWith(true)
    request(null, 'media', callback, { mediaTypes: ['video'] })
    expect(callback).toHaveBeenLastCalledWith(false)
    request(null, 'clipboard-write', callback)
    expect(callback).toHaveBeenLastCalledWith(true)
    request(null, 'notifications', callback)
    expect(callback).toHaveBeenLastCalledWith(false)
  })

  it('检查 handler 按 mediaType 判定,与请求 handler 结论一致', () => {
    const session = fakeSession()
    installInstancePermissionPolicy(session)
    const check = session.setPermissionCheckHandler.mock.calls[0]?.[0] as (
      contents: unknown,
      permission: string,
      requestingOrigin: string,
      details?: unknown
    ) => boolean

    expect(check(null, 'media', 'http://127.0.0.1:3080/', { mediaType: 'audio' })).toBe(true)
    expect(check(null, 'media', 'http://127.0.0.1:3080/', { mediaType: 'video' })).toBe(false)
    expect(check(null, 'media', 'http://127.0.0.1:3080/', { mediaType: 'unknown' })).toBe(false)
    expect(check(null, 'clipboard-sanitized-write', 'http://127.0.0.1:3080/')).toBe(true)
    expect(check(null, 'clipboard-read', 'http://127.0.0.1:3080/')).toBe(false)
    expect(check(null, 'notifications', 'http://127.0.0.1:3080/')).toBe(false)
  })
})
