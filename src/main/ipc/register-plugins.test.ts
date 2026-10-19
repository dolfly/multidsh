import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// electron 在 vitest node 环境不可加载——整体 mock 掉；mock 是文件级的，各 test 文件需各自声明
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    getVersion: () => '9.9.9',
    getPath: () => '/tmp/fake-userdata',
    getLocale: () => 'zh-CN',
    getPreferredSystemLanguages: () => ['zh-Hans-CN', 'en']
  }
}))

import { createInstanceStore } from '../registry/instance-store'
import { registerIpc } from './register'
import { setupRegister, teardownRegister, type RegisterHarness } from './register.testkit'

type MockFn = ReturnType<typeof vi.fn>

let harness: RegisterHarness
let dir: RegisterHarness['dir']
let invoke: RegisterHarness['invoke']
let ipcDeps: RegisterHarness['ipcDeps']
let pluginManagerFake: RegisterHarness['pluginManagerFake']
let openExternalUrl: MockFn

beforeEach(async () => {
  harness = await setupRegister()
  ;({ dir, invoke, ipcDeps, pluginManagerFake, openExternalUrl } = harness)
})

afterEach(async () => {
  await teardownRegister(harness)
})

const VALID_LOCAL = { transport: 'local', name: 'IPC 实例' }

describe('registerIpc：插件管理', () => {
  it('plugin:list：本机实例转发给 pluginManager', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    pluginManagerFake.list.mockResolvedValueOnce([{ name: 'p', version: '1.0.0' }])
    const result = (await invoke('plugin:list', created.value.id)) as {
      ok: boolean
      value: Array<{ name: string }>
    }
    expect(result.ok).toBe(true)
    expect(result.value[0]?.name).toBe('p')
    expect(pluginManagerFake.list).toHaveBeenCalled()
  })

  it('plugin:list：非 local 实例报 invalid-input', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: 'HTTP',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:list', created.value.id)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-input')
  })

  it('plugin:checkState：转发持久化检查状态（供挂载时恢复标记）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    pluginManagerFake.checkState.mockResolvedValueOnce({
      lastCheckedAt: '2026-09-29T10:00:00.000Z',
      updates: {
        p: { current: '1.0.0', latest: '2.0.0', compatible: true, dshPeer: null, dshVersion: null }
      },
      checking: []
    })
    const result = (await invoke('plugin:checkState', created.value.id)) as {
      ok: boolean
      value: { lastCheckedAt: string | null; updates: Record<string, unknown> }
    }
    expect(result.ok).toBe(true)
    expect(result.value.lastCheckedAt).toBe('2026-09-29T10:00:00.000Z')
    expect(Object.keys(result.value.updates)).toEqual(['p'])
  })

  it('plugin:upgrade：显式版本经校验后转发（缺省 options 也补空对象）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke(
      'plugin:upgrade',
      created.value.id,
      'dsh-free-search',
      '0.4.40'
    )) as {
      ok: boolean
    }
    expect(result.ok).toBe(true)
    expect(pluginManagerFake.upgrade).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id }),
      'dsh-free-search',
      '0.4.40',
      {}
    )
  })

  it('plugin:upgrade：安装源档位经校验后作为第 4 参转发', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:upgrade', created.value.id, 'dsh-free-search', '0.4.40', {
      registry: 'npmjs'
    })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(pluginManagerFake.upgrade).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id }),
      'dsh-free-search',
      '0.4.40',
      { registry: 'npmjs' }
    )
  })

  it('plugin:upgrade：非法安装源档位被拒，不到达命令层', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:upgrade', created.value.id, 'dsh-free-search', '0.4.40', {
      registry: 'http://evil.example.com'
    })) as { ok: boolean; code?: string }
    expect(result).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(pluginManagerFake.upgrade).not.toHaveBeenCalled()
  })

  it('plugin:install：非法 spec 被拒（含 shell 元字符）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:install', created.value.id, 'foo; rm -rf /')) as {
      ok: boolean
      code?: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-input')
    expect(pluginManagerFake.install).not.toHaveBeenCalled()
  })

  it('plugin:install：第三参 options 经校验后透传（enable + registry）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:install', created.value.id, 'demo-plugin@1.1.0', {
      enable: false,
      registry: 'npmjs'
    })) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(pluginManagerFake.install).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id }),
      'demo-plugin@1.1.0',
      { enable: false, registry: 'npmjs' }
    )
  })

  it('plugin:install：非法安装源档位被拒，不到达命令层', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:install', created.value.id, 'demo-plugin', {
      registry: 'https://evil.example.com'
    })) as { ok: boolean; code?: string }
    expect(result).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(pluginManagerFake.install).not.toHaveBeenCalled()
  })

  it('plugin:resolveInstall：解析计划透传给渲染层（含安装源）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:resolveInstall', created.value.id, 'demo-plugin', {
      registry: 'npmjs'
    })) as { ok: boolean; value: { installSpec: string; targetVersion: string } }
    expect(result.ok).toBe(true)
    expect(result.value.installSpec).toBe('demo-plugin@1.1.0')
    expect(result.value.targetVersion).toBe('1.1.0')
    expect(pluginManagerFake.resolveInstall).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id }),
      'demo-plugin',
      { registry: 'npmjs' }
    )
  })

  it('plugin:resolveInstall：非 local 实例报 invalid-input', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: 'HTTP',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:resolveInstall', created.value.id, 'demo-plugin')) as {
      ok: boolean
      code?: string
    }
    expect(result).toMatchObject({ ok: false, code: 'invalid-input' })
  })

  it('plugin:packageInfo：包名与版本经校验后转发（取不到内容不是错误）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke(
      'plugin:packageInfo',
      created.value.id,
      'demo-plugin',
      '1.1.0'
    )) as {
      ok: boolean
      value: { releaseNotes: { source: string } }
    }
    expect(result.ok).toBe(true)
    expect(result.value.releaseNotes.source).toBe('none')
    expect(pluginManagerFake.packageInfo).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id }),
      'demo-plugin',
      '1.1.0'
    )

    const bad = (await invoke(
      'plugin:packageInfo',
      created.value.id,
      'demo-plugin',
      'bad version'
    )) as {
      ok: boolean
      code?: string
    }
    expect(bad).toMatchObject({ ok: false, code: 'invalid-input' })
  })

  it('plugin:setEnabled：校验入参后转发（布尔 + 包名）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke(
      'plugin:setEnabled',
      created.value.id,
      'dsh-free-search',
      false
    )) as {
      ok: boolean
      value: { name: string; enabled: boolean }
    }
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ name: 'dsh-free-search', enabled: false })

    const bad = (await invoke(
      'plugin:setEnabled',
      created.value.id,
      'dsh-free-search',
      'nope'
    )) as {
      ok: boolean
      code?: string
    }
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('invalid-input')
  })

  it('plugin:openExternal：白名单外域名被拒，白名单内放行', async () => {
    const denied = (await invoke('plugin:openExternal', 'https://evil.example.com/x')) as {
      ok: boolean
      code?: string
    }
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe('invalid-input')
    expect(openExternalUrl).not.toHaveBeenCalled()

    const allowed = (await invoke('plugin:openExternal', 'https://www.npmjs.com/package/x')) as {
      ok: boolean
    }
    expect(allowed.ok).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.npmjs.com/package/x')
  })

  it('plugin:list：pluginManager 未装配 → ok:false code=internal', async () => {
    registerIpc(createInstanceStore({ dir }), { ...ipcDeps, pluginManager: undefined })
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('plugin:list', created.value.id)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('internal')
  })

  it('check/list：installer 未装配 → ok:false code=internal', async () => {
    // 装配层缺 installer 时 check/list 必须回错误信封，不能让渲染层拿到半份结果。
    registerIpc(createInstanceStore({ dir }), { ...ipcDeps, installer: undefined })
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(result).toMatchObject({ ok: false, code: 'internal' })

    const listResult = (await invoke('dsh-version:list')) as { ok: boolean; code?: string }
    expect(listResult).toMatchObject({ ok: false, code: 'internal' })
  })
})
