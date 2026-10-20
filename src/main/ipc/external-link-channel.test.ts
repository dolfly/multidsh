import { beforeEach, describe, expect, it, vi } from 'vitest'

// electron 在 vitest node 环境不可加载——整体 mock 掉,只验证注册与边界行为
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: () => '9.9.9', getPath: () => '/tmp/fake-userdata' }
}))

import { ipcMain } from 'electron'
import { IPC } from '@shared/bridge'
import { registerIpc } from './register'
import type { IpcDeps } from './register'

/**
 * `app:open-external-link` 的边界（发布说明里的外链）：
 *
 * 1. **协议白名单**——只有 http / https / mailto 能打开。`file:` / `search-ms:` /
 *    `javascript:` 一类能在宿主上拉起本地程序、执行脚本或读本地文件，一律拒绝；
 * 2. 拒绝时**绝不触达打开动作**；
 * 3. 失败必须变成 `{ok:false,code,message}` 信封，不是静默成功。
 */

type Listener = (...args: unknown[]) => unknown
type Envelope = { ok: true; value: unknown } | { ok: false; code: string; message: string }

let handlers: Map<string, Listener>

function register(openExternalUrl?: (url: string) => Promise<void>): void {
  handlers = new Map()
  vi.mocked(ipcMain.handle).mockImplementation((channel, listener) => {
    handlers.set(channel as string, listener as Listener)
    return undefined as never
  })
  registerIpc({} as never, { openExternalUrl } as unknown as IpcDeps)
}

function invoke(channel: string, ...args: unknown[]): Promise<Envelope> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`通道未注册：${channel}`)
  return Promise.resolve(handler({}, ...args) as Envelope)
}

beforeEach(() => {
  handlers = new Map()
})

describe('app:open-external-link（发布说明外链:协议白名单）', () => {
  it('已注册；http/https/mailto 放行并透传给打开动作', async () => {
    const openExternalUrl = vi.fn(async () => undefined)
    register(openExternalUrl)

    for (const url of ['https://example.com/a', 'http://example.com/', 'mailto:dev@example.com']) {
      const result = await invoke(IPC.openExternalLink, url)
      expect(result).toEqual({ ok: true, value: null })
    }
    expect(openExternalUrl).toHaveBeenCalledTimes(3)
    expect(openExternalUrl).toHaveBeenCalledWith('https://example.com/a')
  })

  it('拒绝能拉起本地程序或执行脚本的协议，且不触达打开动作', async () => {
    const openExternalUrl = vi.fn(async () => undefined)
    register(openExternalUrl)

    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'search-ms:query=x',
      'vbscript:msgbox(1)'
    ]) {
      const result = await invoke(IPC.openExternalLink, url)
      expect(result.ok, `应拒绝：${url}`).toBe(false)
      if (!result.ok) expect(result.code).toBe('invalid-input')
    }
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('拒绝非字符串与空串输入', async () => {
    const openExternalUrl = vi.fn(async () => undefined)
    register(openExternalUrl)

    for (const input of ['', 42, null, undefined, { href: 'https://example.com' }]) {
      const result = await invoke(IPC.openExternalLink, input)
      expect(result.ok).toBe(false)
    }
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('未装配打开动作 → internal 错误信封（绝不假装成功）', async () => {
    register()
    const result = await invoke(IPC.openExternalLink, 'https://example.com/')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('internal')
  })
})
