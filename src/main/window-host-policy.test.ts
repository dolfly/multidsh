import { describe, expect, it, vi } from 'vitest'
import {
  isAllowedExternalOpen,
  isAllowedInstanceNavigation,
  openExternalSafely
} from './window-host-policy'

describe('isAllowedInstanceNavigation（实例窗口外跳拦截 ）', () => {
  const origin = 'http://127.0.0.1:30000/?token=abc'

  it('同源回环导航放行（含路径与查询）', () => {
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30000/', origin)).toBe(true)
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30000/api/jobs', origin)).toBe(true)
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30000/?token=abc#/chat', origin)).toBe(
      true
    )
  })

  it('回环别名（localhost / ::1 / 127.1 省略写法）同端口放行', () => {
    expect(isAllowedInstanceNavigation('http://localhost:30000/', origin)).toBe(true)
    expect(isAllowedInstanceNavigation('http://127.1:30000/', origin)).toBe(true)
    expect(isAllowedInstanceNavigation('http://[::1]:30000/', origin)).toBe(true)
  })

  it('外部 http(s) 顶层导航一律拒绝', () => {
    expect(isAllowedInstanceNavigation('https://evil.example.com/phish', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('http://192.168.1.5:30000/', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('http://10.0.0.1:30000/', origin)).toBe(false)
  })

  it('跨端口回环拒绝（防串到其他实例 / 本机其他服务）', () => {
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30001/', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('http://127.0.0.1:80/', origin)).toBe(false)
  })

  it('省略默认端口时只放行同协议的默认端口', () => {
    const defaultHttp = 'http://127.0.0.1/'
    expect(isAllowedInstanceNavigation('http://localhost:80/', defaultHttp)).toBe(true)
    expect(isAllowedInstanceNavigation('https://localhost/', defaultHttp)).toBe(false)
    expect(isAllowedInstanceNavigation('http://localhost:81/', defaultHttp)).toBe(false)
  })

  it('非 http(s) 协议拒绝（file / data / javascript / about）', () => {
    expect(isAllowedInstanceNavigation('file:///etc/passwd', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('data:text/html,<script>1</script>', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('javascript:alert(1)', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('about:blank', origin)).toBe(false)
  })

  it('非法 / 不可解析的 URL 拒绝', () => {
    expect(isAllowedInstanceNavigation('not a url', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('', origin)).toBe(false)
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30000/', 'not a url')).toBe(false)
  })
})
describe('isAllowedInstanceNavigation（用户#4:远程 http 实例的登录页导航）', () => {
  const remote = 'https://gw.example.com/dsh/?token=abc'

  it('同 origin 的网关登录页 / OTP / onboarding / 登录提交一律放行', () => {
    // #4 的复现场景:302 落到 <origin>/login,用户输入密码提交 form → 顶层导航
    expect(isAllowedInstanceNavigation('https://gw.example.com/login', remote)).toBe(true)
    expect(isAllowedInstanceNavigation('https://gw.example.com/login/auth', remote)).toBe(true)
    expect(isAllowedInstanceNavigation('https://gw.example.com/dsh/otp/verify', remote)).toBe(true)
    expect(
      isAllowedInstanceNavigation('https://gw.example.com/dsh/onboarding/password', remote)
    ).toBe(true)
    expect(isAllowedInstanceNavigation('https://gw.example.com/dsh/', remote)).toBe(true)
  })

  it('http(明文)远程实例的同 origin 导航同样放行', () => {
    const plain = 'http://remote.internal.example.com/dsh/'
    expect(isAllowedInstanceNavigation('http://remote.internal.example.com/login', plain)).toBe(
      true
    )
  })

  it('远程实例:跨 origin(外部钓鱼/其他网关)一律拒绝 —— 分区 Cookie 不出实例服务', () => {
    expect(isAllowedInstanceNavigation('https://evil.example.com/phish', remote)).toBe(false)
    expect(isAllowedInstanceNavigation('https://other-gw.example.com/login', remote)).toBe(false)
    expect(isAllowedInstanceNavigation('http://gw.example.com.evil.io/login', remote)).toBe(false)
  })

  it('远程实例:同 host 跨协议/跨端口拒绝(origin 不等价)', () => {
    expect(isAllowedInstanceNavigation('http://gw.example.com/login', remote)).toBe(false)
    expect(isAllowedInstanceNavigation('https://gw.example.com:8443/login', remote)).toBe(false)
  })

  it('回环实例语义不:跨端口/外部仍拒绝(见上一组用例)', () => {
    const loopback = 'http://127.0.0.1:30000/?token=abc'
    expect(isAllowedInstanceNavigation('https://gw.example.com/login', loopback)).toBe(false)
    expect(isAllowedInstanceNavigation('http://127.0.0.1:30001/', loopback)).toBe(false)
  })
})

describe('openExternalSafely（外跳协议白名单）', () => {
  it('http / https / mailto 交给系统打开', () => {
    const openExternal = vi.fn(async () => undefined)
    expect(openExternalSafely('https://example.com/docs', openExternal)).toBe(true)
    expect(openExternalSafely('http://example.com/', openExternal)).toBe(true)
    expect(openExternalSafely('mailto:dev@example.com', openExternal)).toBe(true)
    expect(openExternal).toHaveBeenCalledTimes(3)
  })

  it('能在宿主拉起本地程序的协议一律不打开', () => {
    const openExternal = vi.fn(async () => undefined)
    const denied = [
      'file:///etc/passwd',
      'search-ms:query=secret&crumb=..',
      'ms-settings:privacy',
      'javascript:alert(1)',
      'ftp://example.com/',
      'smb://host/share',
      'not a url',
      ''
    ]
    for (const url of denied) {
      expect(isAllowedExternalOpen(url)).toBe(false)
      expect(openExternalSafely(url, openExternal)).toBe(false)
    }
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('打开失败被消费,不成为未处理拒绝', async () => {
    const openExternal = vi.fn(async () => {
      throw new Error('no handler for https')
    })
    expect(openExternalSafely('https://example.com', openExternal)).toBe(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(openExternal).toHaveBeenCalledTimes(1)
  })
})
