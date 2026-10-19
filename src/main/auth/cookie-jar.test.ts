import { describe, expect, it } from 'vitest'
import { createCookieJar, parseSetCookie } from './cookie-jar'

describe('cookie-jar（内存 Cookie 罐）', () => {
  it('解析真实网关的 Set-Cookie(Path=/; HttpOnly; SameSite=Strict; Max-Age)', () => {
    const record = parseSetCookie(
      'dsh_auth=abc123; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000',
      0
    )
    expect(record?.name).toBe('dsh_auth')
    expect(record?.value).toBe('abc123')
    expect(record?.expiresAt).toBe(2592000 * 1000)
    expect(record?.attributes).toContain('HttpOnly')
  })

  it('Max-Age 优先于 Expires(RFC 6265)', () => {
    const record = parseSetCookie(
      'dsh_auth=x; Expires=Wed, 01 Jan 2030 00:00:00 GMT; Max-Age=10',
      1_000
    )
    expect(record?.expiresAt).toBe(1_000 + 10_000)
  })

  it('无 Max-Age/Expires = 会话 Cookie', () => {
    expect(parseSetCookie('dsh_auth=x; Path=/')?.expiresAt).toBeNull()
  })

  it('Max-Age=0 / 空值 = 删除', () => {
    const jar = createCookieJar()
    jar.store(['dsh_auth=v; Path=/; Max-Age=100'])
    expect(jar.get('dsh_auth')).not.toBeNull()
    jar.store(['dsh_auth=; Path=/; Max-Age=0'])
    expect(jar.get('dsh_auth')).toBeNull()
  })

  it('请求头拼接与过期过滤', () => {
    let now = 0
    const jar = createCookieJar(() => now)
    jar.store(['dsh_auth=a; Path=/; Max-Age=10', 'other=b; Path=/'])
    expect(jar.header()).toBe('dsh_auth=a; other=b')
    now = 11_000
    expect(jar.header()).toBe('other=b')
    expect(jar.get('dsh_auth')).toBeNull()
  })

  it('describe() 只暴露元信息(不含值)', () => {
    const jar = createCookieJar()
    jar.store(['dsh_auth=SECRET-VALUE; Path=/; Max-Age=100'])
    const described = JSON.stringify(jar.describe())
    expect(described).not.toContain('SECRET-VALUE')
    expect(described).toContain('dsh_auth')
  })

  it('clear() 清空(登出)', () => {
    const jar = createCookieJar()
    jar.store(['dsh_auth=a; Path=/'])
    jar.clear()
    expect(jar.header()).toBeNull()
  })

  it('拒绝会污染 Cookie 请求头的名称和值', () => {
    expect(parseSetCookie('bad name=x; Path=/')).toBeNull()
    expect(parseSetCookie('dsh_auth="a"; Path=/')).toBeNull()
    expect(parseSetCookie('dsh_auth=a\rb; Path=/')).toBeNull()
    expect(parseSetCookie('dsh_auth=a\nb; Path=/')).toBeNull()
  })

  it('畸形 Set-Cookie 不炸', () => {
    expect(parseSetCookie('')).toBeNull()
    expect(parseSetCookie('=x')).toBeNull()
    expect(parseSetCookie('novalue')).toBeNull()
  })
})
