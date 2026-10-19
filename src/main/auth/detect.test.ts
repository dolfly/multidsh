import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { classifyAuthResponse, detectAuthMode } from './detect'

const servers: Array<ReturnType<typeof createServer>> = []
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

describe('classifyAuthResponse（ 判定表）', () => {
  it('302 → /login = gateway（登录页）', () => {
    const result = classifyAuthResponse({ status: 302, location: '/dsh/login' })
    expect(result.mode).toBe('gateway')
    expect(result.gatewayEvidence).toBe('login-page')
  })

  it('302 → /onboarding = gateway（onboarding 未完成）', () => {
    expect(classifyAuthResponse({ status: 302, location: '/onboarding' }).gatewayEvidence).toBe(
      'onboarding'
    )
  })

  it('401 JSON unauthenticated = gateway（API 直探）', () => {
    const result = classifyAuthResponse({
      status: 401,
      contentType: 'application/json',
      body: '{"ok":false,"error":"unauthenticated"}'
    })
    expect(result.mode).toBe('gateway')
    expect(result.gatewayEvidence).toBe('api-401')
  })

  it('401 JSON onboarding-required = gateway(onboarding)', () => {
    const result = classifyAuthResponse({
      status: 401,
      contentType: 'application/json; charset=utf-8',
      body: '{"ok":false,"error":"onboarding-required"}'
    })
    expect(result.gatewayEvidence).toBe('onboarding')
  })

  it('401 text/plain + dsh BrowserAuth 提示 = browser-auth', () => {
    const result = classifyAuthResponse({
      status: 401,
      contentType: 'text/plain; charset=utf-8',
      body: 'dsh web authentication required; reopen the URL printed by dsh web.\n'
    })
    expect(result.mode).toBe('browser-auth')
  })

  it('200 = none', () => {
    expect(classifyAuthResponse({ status: 200, body: '<html>dsh</html>' }).mode).toBe('none')
  })

  it('404/500 = unknown', () => {
    expect(classifyAuthResponse({ status: 404 }).mode).toBe('unknown')
    expect(classifyAuthResponse({ status: 503 }).mode).toBe('unknown')
  })
})

describe('detectAuthMode（真实 HTTP 往返,含 redirect:manual）', () => {
  it('302 → /login 不被跟随,识别为 gateway', async () => {
    const port = await listen((req, res) => {
      if (req.url === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>login</html>')
        return
      }
      res.writeHead(302, { location: '/login' })
      res.end()
    })
    const result = await detectAuthMode(`http://127.0.0.1:${port}/`, { timeoutMs: 1000 })
    expect(result.mode).toBe('gateway')
    expect(result.status).toBe(302)
  })

  it('401 JSON = gateway(api-401)', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":"unauthenticated"}')
    })
    const result = await detectAuthMode(`http://127.0.0.1:${port}/`, { timeoutMs: 1000 })
    expect(result.mode).toBe('gateway')
  })

  it('200 = none', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><title>dsh</title></html>')
    })
    expect((await detectAuthMode(`http://127.0.0.1:${port}/`, { timeoutMs: 1000 })).mode).toBe(
      'none'
    )
  })

  it('ECONNREFUSED = unreachable（不抛异常）', async () => {
    const result = await detectAuthMode('http://127.0.0.1:1/', { timeoutMs: 500 })
    expect(result.mode).toBe('unreachable')
    expect(result.status).toBeNull()
  })
})

describe('防线', () => {
  it('401 体含 dsh 但非 text/plain → 不判 browser-auth(与 JSON 分支对称)', () => {
    const result = classifyAuthResponse({
      status: 401,
      contentType: 'application/json',
      body: '{"ok":false,"error":"some-dsh-error"}'
    })
    expect(result.mode).not.toBe('browser-auth')
  })

  it('401 体含 dsh 的 HTML → 不判 browser-auth', () => {
    const result = classifyAuthResponse({
      status: 401,
      contentType: 'text/html',
      body: '<html><body>dsh web authentication required; reopen the URL</body></html>'
    })
    expect(result.mode).not.toBe('browser-auth')
  })

  it('特征串必须完整(仅含 dsh 的 text/plain 401 不判 browser-auth)', () => {
    expect(
      classifyAuthResponse({ status: 401, contentType: 'text/plain', body: 'dsh: something else' })
        .mode
    ).not.toBe('browser-auth')
  })

  it('不安全方向:未识别路径的 302 不得判为 gateway', () => {
    const result = classifyAuthResponse({ status: 302, location: '/somewhere/else' })
    expect(result.mode).toBe('unknown')
    expect(result.mode).not.toBe('gateway')
  })

  it('302 → /otp/verify 判为 gateway(要求二因素)', () => {
    const result = classifyAuthResponse({ status: 302, location: '/otp/verify' })
    expect(result.mode).toBe('gateway')
    expect(result.gatewayEvidence).toBe('otp-page')
  })

  it('basePath 下的重定向仍能识别(/dsh/login)', () => {
    expect(classifyAuthResponse({ status: 302, location: '/dsh/login' }).mode).toBe('gateway')
  })

  it('探测带会话 Cookie(D1:不带就只能看到第一道门禁 302→/login)', async () => {
    const seen: Array<{ url: string; cookie: string | null }> = []
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ url: String(input), cookie: headers.get('cookie') })
      // 有会话且 OTP 未验:网关给 302 → /otp/verify
      return new Response('', {
        status: 302,
        headers: {
          location: '/dsh/otp/verify',
          ...(headers.get('cookie') ? {} : { location: '/dsh/login' })
        }
      })
    }) as unknown as typeof fetch

    const detection = await detectAuthMode('https://gw.example.com/dsh/', {
      fetchImpl,
      cookie: 'dsh_auth=half-authenticated'
    })
    expect(seen).toEqual([
      { url: 'https://gw.example.com/dsh/', cookie: 'dsh_auth=half-authenticated' }
    ])
    expect(detection.gatewayEvidence).toBe('otp-page')
  })

  it('无 cookie 时不发送 Cookie 头(匿名探测保持原样)', async () => {
    const seen: Array<string | null> = []
    const fetchImpl = (async (_input: string | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('cookie'))
      return new Response('', { status: 302, headers: { location: '/dsh/login' } })
    }) as unknown as typeof fetch

    const detection = await detectAuthMode('https://gw.example.com/dsh/', { fetchImpl })
    expect(seen).toEqual([null])
    expect(detection.gatewayEvidence).toBe('login-page')
  })
})
