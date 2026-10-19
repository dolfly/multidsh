import { describe, expect, it } from 'vitest'
import { classifyAuthSignal, locationPathname } from './intercept'

/** 主框架导航响应(302 判定的前提) */
const nav = (
  statusCode: number,
  location: string,
  extra: Record<string, string> = {}
): Parameters<typeof classifyAuthSignal>[0] => ({
  statusCode,
  headers: { location, ...extra },
  resourceType: 'mainFrame'
})

describe('intercept（ 302/401 判定）', () => {
  it('302 → /login = 会话失效', () => {
    expect(classifyAuthSignal(nav(302, '/login'))).toBe('session-expired')
  })

  it('basePath 下的 302 → /dsh/login = 会话失效;其他路径不算', () => {
    expect(classifyAuthSignal(nav(302, '/dsh/login'), '/dsh')).toBe('session-expired')
    expect(classifyAuthSignal(nav(302, '/other/login'), '/dsh')).toBeNull()
  })

  it('带查询串/尾斜杠的登录重定向仍识别', () => {
    expect(classifyAuthSignal(nav(302, '/login?next=/a'))).toBe('session-expired')
    expect(classifyAuthSignal(nav(302, '/login/'))).toBe('session-expired')
  })

  it('302 → /onboarding 与 /onboarding/password = 需要先完成引导改密', () => {
    expect(classifyAuthSignal(nav(302, '/onboarding'))).toBe('needs-onboarding')
    expect(classifyAuthSignal(nav(302, '/onboarding/password'))).toBe('needs-onboarding')
    expect(classifyAuthSignal(nav(302, '/dsh/onboarding'), '/dsh')).toBe('needs-onboarding')
  })

  it('302 → /otp/verify = 需要二因素验证码', () => {
    expect(classifyAuthSignal(nav(302, '/otp/verify'))).toBe('needs-otp')
    expect(classifyAuthSignal(nav(302, '/dsh/otp/verify'), '/dsh')).toBe('needs-otp')
  })

  it('302 到未知 location / 缺 location 都不算信号', () => {
    expect(classifyAuthSignal(nav(302, '/assets/app.js'))).toBeNull()
    expect(classifyAuthSignal(nav(302, '/'))).toBeNull()
    expect(
      classifyAuthSignal({ statusCode: 302, headers: {}, resourceType: 'mainFrame' })
    ).toBeNull()
  })

  it('子资源(xhr/script)的 302 不算信号 —— 只有主框架导航才代表被拦到登录页', () => {
    expect(classifyAuthSignal({ ...nav(302, '/login'), resourceType: 'xhr' })).toBeNull()
    expect(classifyAuthSignal({ ...nav(302, '/login'), resourceType: 'script' })).toBeNull()
    // 调用方未告知资源类型时保守拒判(避免把子资源 302 误判为会话失效)
    expect(classifyAuthSignal({ statusCode: 302, headers: { location: '/login' } })).toBeNull()
  })

  it('401 JSON = 会话失效(不依赖响应体)', () => {
    expect(
      classifyAuthSignal({
        statusCode: 401,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        resourceType: 'xhr'
      })
    ).toBe('session-expired')
  })

  it('401 非 JSON(dsh BrowserAuth 的 text/plain)不算网关信号', () => {
    // dsh 内置 BrowserAuth 未认证响应:401 + text/plain + 固定文案。
    // 若不加 content-type 判别,本地区实例的 401 会凭空触发网关登录面板。
    expect(
      classifyAuthSignal({
        statusCode: 401,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        resourceType: 'mainFrame'
      })
    ).toBeNull()
    // 缺 content-type 时保守不判(宁可漏判,由 probe 兜底)
    expect(classifyAuthSignal({ statusCode: 401, headers: {} })).toBeNull()
  })

  it('200 与其它状态码不算信号(任何 HTTP 响应都说明传输通)', () => {
    expect(classifyAuthSignal(nav(200, '/login'))).toBeNull()
    expect(classifyAuthSignal({ statusCode: 500, headers: {} })).toBeNull()
    expect(classifyAuthSignal({ statusCode: 404, headers: {} })).toBeNull()
  })

  it('头名大小写不敏感;数组头取首个', () => {
    expect(
      classifyAuthSignal({
        statusCode: 302,
        headers: { Location: ['/login'] },
        resourceType: 'mainFrame'
      })
    ).toBe('session-expired')
  })
})

describe('locationPathname', () => {
  it('相对与绝对 location 都取 pathname 并小写化', () => {
    expect(locationPathname('/a/b')).toBe('/a/b')
    expect(locationPathname('/Dsh/Login')).toBe('/dsh/login')
    expect(locationPathname('https://gw.example.com/dsh/login?x=1')).toBe('/dsh/login')
    expect(locationPathname(null)).toBe('')
  })
})
