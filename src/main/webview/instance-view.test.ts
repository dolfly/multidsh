import { describe, expect, it, vi } from 'vitest'
import {
  createOncePerSession,
  isAuthenticatedTokenUrl,
  isSameOriginLoginRedirect,
  openInstanceView,
  shouldReuseLoadedView
} from './instance-view'
import type { InstanceViewWindow, OpenInstanceViewDeps } from './instance-view'

const COOKIE = { name: 'dsh_auth', value: 'sess-token', expiresAt: null }

/**
 * 录制开窗顺序的假窗口。
 */
function harness(): {
  deps: OpenInstanceViewDeps<InstanceViewWindow>
  order: string[]
  loaded: string[]
  setDetails: Array<Record<string, unknown>>
} {
  const order: string[] = []
  const loaded: string[] = []
  const setDetails: Array<Record<string, unknown>> = []
  const win: InstanceViewWindow = {
    loadURL: async (url: string) => {
      order.push('loadURL')
      loaded.push(url)
    },
    webContents: {
      session: {
        cookies: {
          set: async (details) => {
            order.push('cookies.set')
            setDetails.push(details as unknown as Record<string, unknown>)
          }
        }
      }
    }
  }
  return {
    order,
    loaded,
    setDetails,
    deps: {
      createWindow: () => {
        order.push('createWindow')
        return win
      },
      installIntercept: () => {
        order.push('installIntercept')
      }
    }
  }
}

const args = {
  url: 'http://127.0.0.1:8002/?token=abc',
  origin: 'http://127.0.0.1:8002',
  basePath: '/',
  cookie: COOKIE
}

describe('openInstanceView（ 先注入再 loadURL 的顺序纪律）', () => {
  it('调用顺序必须是 开窗 → 装拦截 → 写 Cookie → loadURL', async () => {
    const h = harness()
    const injected = await openInstanceView(h.deps, args)
    expect(injected).toBe(true)
    expect(h.order).toEqual(['createWindow', 'installIntercept', 'cookies.set', 'loadURL'])
  })

  it('写入的 Cookie 带 HttpOnly/Path=/ 与正确 url', async () => {
    const h = harness()
    await openInstanceView(h.deps, args)
    expect(h.setDetails).toHaveLength(1)
    expect(h.setDetails[0]).toMatchObject({
      url: 'http://127.0.0.1:8002/',
      name: 'dsh_auth',
      value: 'sess-token',
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/'
    })
  })

  it('加载的是确切 URL(不被 origin+basePath 重建,保留 ?token=)', async () => {
    const h = harness()
    await openInstanceView(h.deps, args)
    expect(h.loaded).toEqual(['http://127.0.0.1:8002/?token=abc'])
  })

  it('复用已加载的同一工作区时不重新导航，避免切换后的白屏', async () => {
    const h = harness()
    h.deps.createWindow = (() => ({
      loadURL: async (url: string): Promise<void> => {
        h.loaded.push(url)
      },
      webContents: {
        getURL: () => args.url,
        session: { cookies: { set: async () => undefined } }
      }
    })) as OpenInstanceViewDeps<InstanceViewWindow>['createWindow']

    await expect(openInstanceView(h.deps, { ...args, cookie: null })).resolves.toBe(false)
    expect(h.loaded).toEqual([])
    expect(h.order).toEqual([])
  })

  it('本地 BrowserAuth 改变 token URL 后仍复用同一实例工作区', async () => {
    const h = harness()
    h.deps.createWindow = (() => ({
      loadURL: async (url: string): Promise<void> => {
        h.loaded.push(url)
      },
      webContents: {
        // dsh BrowserAuth 登录后会去除首次打开时 URL 中的临时 token。
        getURL: () => 'http://127.0.0.1:8002/',
        session: { cookies: { set: async () => undefined } }
      }
    })) as OpenInstanceViewDeps<InstanceViewWindow>['createWindow']

    await expect(openInstanceView(h.deps, args)).resolves.toBe(false)
    expect(h.loaded).toEqual([])
    expect(h.order).toEqual([])
  })

  it('仅当 token 被消费且页面保持同源同路径时复用 BrowserAuth 工作区', () => {
    expect(isAuthenticatedTokenUrl('http://127.0.0.1:8002/', args.url)).toBe(true)
    expect(isAuthenticatedTokenUrl('http://127.0.0.1:8002/other', args.url)).toBe(false)
    expect(isAuthenticatedTokenUrl('http://other.example/', args.url)).toBe(false)
    expect(isAuthenticatedTokenUrl('http://127.0.0.1:8002/?other=value#chat', args.url)).toBe(true)
    expect(isAuthenticatedTokenUrl('http://127.0.0.1:8002/?token=replaced', args.url)).toBe(false)
    expect(isAuthenticatedTokenUrl('http://127.0.0.1:8002/', 'http://127.0.0.1:8002/')).toBe(false)
  })
  it('shouldReuseLoadedView 只认「无需导航」的两种情况', () => {
    const target = 'http://127.0.0.1:8002/?token=abc'
    // 精确同 URL，或 BrowserAuth 已消费一次性 token 后回到同源同路径
    expect(shouldReuseLoadedView(target, target)).toBe(true)
    expect(shouldReuseLoadedView('http://127.0.0.1:8002/', target)).toBe(true)
    // 未缓存(undefined)、异源、异路径、以及仍带 token 的当前页都需要重新导航
    expect(shouldReuseLoadedView(undefined, target)).toBe(false)
    expect(shouldReuseLoadedView('', target)).toBe(false)
    expect(shouldReuseLoadedView('http://other.example/', target)).toBe(false)
    expect(shouldReuseLoadedView('http://127.0.0.1:8002/other', target)).toBe(false)
    expect(shouldReuseLoadedView('http://127.0.0.1:8002/?token=old', target)).toBe(false)
  })

  it('无会话时只开窗+装拦截+加载,不写 Cookie', async () => {
    const h = harness()
    const injected = await openInstanceView(h.deps, { ...args, cookie: null })
    expect(injected).toBe(false)
    expect(h.order).toEqual(['createWindow', 'installIntercept', 'loadURL'])
    expect(h.setDetails).toEqual([])
  })

  it('Cookie 注入失败仍继续加载(交给拦截层触发重登)', async () => {
    const h = harness()
    h.deps.createWindow = (() => {
      h.order.push('createWindow')
      return {
        loadURL: async (url: string) => {
          h.order.push('loadURL')
          h.loaded.push(url)
        },
        webContents: {
          session: {
            cookies: {
              set: async () => {
                h.order.push('cookies.set')
                throw new Error('network service 不可用')
              }
            }
          }
        }
      }
    }) as OpenInstanceViewDeps<InstanceViewWindow>['createWindow']
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const injected = await openInstanceView(h.deps, args)
    errorSpy.mockRestore()
    expect(injected).toBe(false)
    expect(h.order).toEqual(['createWindow', 'installIntercept', 'cookies.set', 'loadURL'])
  })

  it('加载失败经 onLoadError 上报,不向调用方抛出', async () => {
    const errors: unknown[] = []
    const deps: OpenInstanceViewDeps<InstanceViewWindow> = {
      createWindow: () => ({
        loadURL: async () => {
          throw new Error('ERR_CONNECTION_REFUSED')
        },
        webContents: { session: { cookies: { set: async () => undefined } } }
      }),
      installIntercept: () => undefined,
      onLoadError: (error) => errors.push(error)
    }
    await expect(openInstanceView(deps, args)).resolves.toBe(true)
    expect(errors).toHaveLength(1)
  })
})

describe('认证重定向后的加载失败', () => {
  it('仅将同源 <basePath>/login 识别为认证重定向', () => {
    expect(
      isSameOriginLoginRedirect('https://dsh.crazydb.com/login', 'https://dsh.crazydb.com', '/')
    ).toBe(true)
    expect(
      isSameOriginLoginRedirect('https://dsh.crazydb.com/login/', 'https://dsh.crazydb.com', '/')
    ).toBe(true)
    expect(
      isSameOriginLoginRedirect('https://evil.example.com/login', 'https://dsh.crazydb.com', '/')
    ).toBe(false)
    expect(
      isSameOriginLoginRedirect('https://dsh.crazydb.com/not-login', 'https://dsh.crazydb.com', '/')
    ).toBe(false)
    // 带 basePath 的实例：网关 302 到 <basePath>/login，根路径匹配会漏判
    expect(
      isSameOriginLoginRedirect(
        'https://dsh.crazydb.com/dsh/login',
        'https://dsh.crazydb.com/dsh',
        '/dsh'
      )
    ).toBe(true)
    expect(
      isSameOriginLoginRedirect(
        'https://dsh.crazydb.com/login',
        'https://dsh.crazydb.com/dsh',
        '/dsh'
      )
    ).toBe(false)
  })

  it('ERR_FAILED 且已观测到同源登录重定向时不作为普通加载错误上报', async () => {
    const errors: unknown[] = []
    const redirects: Array<(_event: unknown, url: string) => void> = []
    const deps: OpenInstanceViewDeps<InstanceViewWindow> = {
      createWindow: () => ({
        loadURL: async () => {
          redirects[0]?.(null, 'https://dsh.crazydb.com/login')
          throw Object.assign(new Error('ERR_FAILED (-2)'), { code: 'ERR_FAILED' })
        },
        webContents: {
          session: { cookies: { set: async () => undefined } },
          on: (_event, listener) => redirects.push(listener)
        }
      }),
      installIntercept: () => undefined,
      onLoadError: (error) => errors.push(error)
    }

    await expect(
      openInstanceView(deps, {
        url: 'https://dsh.crazydb.com/',
        origin: 'https://dsh.crazydb.com',
        basePath: '/',
        cookie: null
      })
    ).resolves.toBe(false)
    expect(errors).toEqual([])
  })

  it('未观测到认证重定向的 ERR_FAILED 仍按错误上报', async () => {
    const errors: unknown[] = []
    const deps: OpenInstanceViewDeps<InstanceViewWindow> = {
      createWindow: () => ({
        loadURL: async () => {
          throw Object.assign(new Error('ERR_FAILED (-2)'), { code: 'ERR_FAILED' })
        },
        webContents: {
          session: { cookies: { set: async () => undefined } },
          on: () => undefined
        }
      }),
      installIntercept: () => undefined,
      onLoadError: (error) => errors.push(error)
    }

    await expect(openInstanceView(deps, args)).resolves.toBe(true)
    expect(errors).toHaveLength(1)
  })
})

describe('createOncePerSession（拦截「每分区会话只装一次」守卫）', () => {
  it('同一 session 只在首次返回 true;不同 session 各自首次', () => {
    const once = createOncePerSession<object>()
    const a = {}
    const b = {}
    expect(once(a)).toBe(true)
    expect(once(a)).toBe(false)
    expect(once(a)).toBe(false)
    expect(once(b)).toBe(true)
    expect(once(b)).toBe(false)
    expect(once(a)).toBe(false)
  })
})
