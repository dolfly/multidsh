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

import type { InstanceStatusEvent } from '@shared/contracts'
import { setupRegister, teardownRegister, type RegisterHarness } from './register.testkit'

let harness: RegisterHarness
let invoke: RegisterHarness['invoke']
let runtimeFake: RegisterHarness['runtimeFake']
let tunnelsFake: RegisterHarness['tunnelsFake']
let httpFake: RegisterHarness['httpFake']
let vaultFake: RegisterHarness['vaultFake']
let openInstanceView: RegisterHarness['openInstanceView']
let instanceViewUrlFake: RegisterHarness['instanceViewUrlFake']
let externalDshScannerFake: RegisterHarness['externalDshScannerFake']
let verifyExternalAccess: RegisterHarness['verifyExternalAccess']
let authFake: RegisterHarness['authFake']
let currentStatus: InstanceStatusEvent | null

beforeEach(async () => {
  currentStatus = null
  harness = await setupRegister(() => currentStatus)
  ;({
    invoke,
    runtimeFake,
    tunnelsFake,
    httpFake,
    vaultFake,
    openInstanceView,
    instanceViewUrlFake,
    externalDshScannerFake,
    verifyExternalAccess,
    authFake
  } = harness)
})

afterEach(async () => {
  await teardownRegister(harness)
})

const VALID_LOCAL = { transport: 'local', name: 'IPC 实例' }

describe('registerIpc：打开工作区与外部接管', () => {
  it('openView:SSH 未连接时主动建立隧道，准备完成后开窗', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '按需连接的隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    tunnelsFake.start.mockImplementation(async (instance) => {
      tunnelsFake.statusOf.mockReturnValue({
        id: instance.id,
        status: 'running',
        url: 'http://127.0.0.1:39001/',
        at: '2026-09-16T00:00:00.000Z'
      })
    })

    const opened = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(tunnelsFake.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id })
    )
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id, transport: 'ssh' }),
      'http://127.0.0.1:39001/'
    )
  })

  it('SSH 连接失败时向调用方返回可见错误', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '失败的隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    tunnelsFake.start.mockRejectedValueOnce(new Error('SSH 认证失败'))

    const opened = (await invoke('instances:openView', created.value.id)) as {
      ok: boolean
      code?: string
      message?: string
    }
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.code).toBe('internal')
      expect(opened.message).toContain('内部错误')
    }
    expect(openInstanceView).not.toHaveBeenCalled()
  })

  it('未提供接管 token 时不会把外部 dsh 当作可直接访问的工作区', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValueOnce([
      { pid: 84758, port: 3080, patch: '/x.yml', command: 'node /x/dsh web --patch /x.yml' }
    ])

    const opened = (await invoke('instances:openView', local.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(runtimeFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: local.value.id }))
    expect(openInstanceView).not.toHaveBeenCalled()
  })

  it('本机未运行时会启动实例自身的 dsh', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    runtimeFake.start.mockImplementation(async (instance) => {
      const url = 'http://127.0.0.1:39002/'
      runtimeFake.statusOf.mockReturnValue({
        id: instance.id,
        status: 'running',
        at: '2026-09-16T00:00:00.000Z'
      })
      runtimeFake.urlOf.mockReturnValue(url)
    })

    const opened = (await invoke('instances:openView', local.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(runtimeFake.adopt).not.toHaveBeenCalled()
    expect(runtimeFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: local.value.id }))
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: local.value.id }),
      'http://127.0.0.1:39002/'
    )
  })

  it('同一实例的并发打开请求只导航一次', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    let release!: () => void
    const starting = new Promise<void>((resolve) => {
      release = resolve
    })
    runtimeFake.start.mockImplementation(async (instance) => {
      await starting
      const url = 'http://127.0.0.1:39003/'
      runtimeFake.statusOf.mockReturnValue({
        id: instance.id,
        status: 'running',
        at: '2026-09-16T00:00:00.000Z'
      })
      runtimeFake.urlOf.mockReturnValue(url)
    })

    const first = invoke('instances:openView', local.value.id) as Promise<{ ok: boolean }>
    await vi.waitFor(() => expect(runtimeFake.start).toHaveBeenCalledTimes(1))
    const second = invoke('instances:openView', local.value.id) as Promise<{ ok: boolean }>
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, value: null },
      { ok: true, value: null }
    ])
    expect(openInstanceView).toHaveBeenCalledTimes(1)
  })

  it('http 实例未「启动」也能打开视图(启动的意义就是开窗,不该做两遍)', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '免启动远程',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    // http 管理器尚未启动 → statusOf 为 null(正是用户遇到的「必须先点启动」)
    httpFake.statusOf.mockReturnValue(null)
    const opened = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    // 用实例自身端点开窗(httpDirectEndpoint 的归一化结果)
    expect(httpFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: created.value.id }))
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id, transport: 'http' }),
      expect.stringContaining('gw.example.com')
    )
  })

  it('已停在同一 URL 的远程工作区不再等待认证探测', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '已打开的远程',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    const endpoint = 'https://gw.example.com/dsh/'
    httpFake.statusOf.mockReturnValue({
      id: created.value.id,
      status: 'running',
      url: endpoint,
      at: '2026-09-15T00:00:00.000Z'
    })
    // 缓存视图已停在同一 URL → 本次打开不会导航，探测不该阻塞显示。
    instanceViewUrlFake.mockReturnValue(endpoint)
    let probeSettled = false
    authFake.probe.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            probeSettled = true
            resolve(null)
          }, 50)
        })
    )

    const opened = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(probeSettled).toBe(false)
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id }),
      endpoint
    )
  })

  it('缓存视图停在别的 URL 时仍先完成认证探测再开窗', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '换址的远程',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    const endpoint = 'https://gw.example.com/dsh/'
    httpFake.statusOf.mockReturnValue({
      id: created.value.id,
      status: 'running',
      url: endpoint,
      at: '2026-09-15T00:00:00.000Z'
    })
    instanceViewUrlFake.mockReturnValue('https://gw.example.com/dsh/other')
    const order: string[] = []
    authFake.probe.mockImplementation(async () => {
      order.push('probe')
      return null
    })
    openInstanceView.mockImplementation(async () => {
      order.push('openInstanceView')
    })

    const opened = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(order).toEqual(['probe', 'openInstanceView'])
  })

  it('未连接的 SSH 和本机实例会在打开工作区时开始准备', async () => {
    const ssh = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道实例',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!ssh.ok) throw new Error('创建失败')
    tunnelsFake.statusOf.mockReturnValue(null)
    const pendingSsh = (await invoke('instances:openView', ssh.value.id)) as { ok: boolean }
    expect(pendingSsh.ok).toBe(true)
    expect(tunnelsFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: ssh.value.id }))

    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValueOnce([])
    runtimeFake.statusOf.mockReturnValue(null)
    const pendingLocal = (await invoke('instances:openView', local.value.id)) as { ok: boolean }
    expect(pendingLocal.ok).toBe(true)
    expect(runtimeFake.start).toHaveBeenCalledWith(expect.objectContaining({ id: local.value.id }))
  })

  it('重启后的本机实例从保险库读取 token，验证后自动打开已接管的端口', async () => {
    const local = (await invoke('instances:create', { ...VALID_LOCAL, port: 3080 })) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    vaultFake['getExternalAccessToken']!.mockReturnValue('saved-token')

    const opened = (await invoke('instances:openView', local.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(verifyExternalAccess).toHaveBeenCalledWith('http://127.0.0.1:3080/?token=saved-token')
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: local.value.id }),
      'http://127.0.0.1:3080/?token=saved-token'
    )
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('保存的外部 token 无效时清除它并要求重新输入', async () => {
    const local = (await invoke('instances:create', { ...VALID_LOCAL, port: 3080 })) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    vaultFake['getExternalAccessToken']!.mockReturnValue('expired-token')
    verifyExternalAccess.mockResolvedValueOnce(false)

    const opened = (await invoke('instances:openView', local.value.id)) as {
      ok: boolean
      code?: string
      message?: string
    }
    expect(opened.ok).toBe(false)
    expect(opened.code).toBe('invalid-state')
    expect(opened.message).toContain('实例详情中更新')
    expect(vaultFake['forgetExternalAccessToken']).toHaveBeenCalledWith(local.value.id)
    expect(openInstanceView).not.toHaveBeenCalled()
  })

  it('接管的外部 dsh 重启后断开旧接管，并提示在详情页更新访问 token', async () => {
    const local = (await invoke('instances:create', { ...VALID_LOCAL, port: 3080 })) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    vaultFake['getExternalAccessToken']!.mockReturnValue('old-token')
    externalDshScannerFake.scan.mockResolvedValueOnce([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    await expect(invoke('instances:openView', local.value.id)).resolves.toEqual({
      ok: true,
      value: null
    })

    externalDshScannerFake.scan.mockResolvedValueOnce([
      { pid: 84759, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    const reopened = (await invoke('instances:openView', local.value.id)) as {
      ok: boolean
      code?: string
      message?: string
    }

    expect(reopened).toEqual({
      ok: false,
      code: 'invalid-state',
      message: '本机 dsh 已重启，请在实例详情中更新访问 token'
    })
    expect(runtimeFake.stop).toHaveBeenCalledWith(local.value.id)

    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84759, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    currentStatus = {
      id: local.value.id,
      status: 'running',
      runtimeSource: 'external',
      at: '2026-09-17T00:00:00.000Z'
    }
    await expect(
      invoke('instances:adoptExternal', local.value.id, 84759, 'new-token')
    ).resolves.toEqual({
      ok: true,
      value: null
    })
    expect(vaultFake['rememberExternalAccessToken']).toHaveBeenCalledWith(
      local.value.id,
      'new-token'
    )
  })

  it('外部接管创建在 token 持久化失败时回滚实例记录', async () => {
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 52300, patch: null, command: 'node /x/dsh web' }
    ])
    vaultFake['rememberExternalAccessToken']!.mockRejectedValueOnce(
      new Error('keychain unavailable')
    )

    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      useExistingExternal: true,
      externalPid: 84758,
      externalAccess: 'access-token'
    })) as { ok: boolean }

    expect(created.ok).toBe(false)
    expect(await invoke('instances:list')).toMatchObject({ ok: true, value: [] })
    expect(vaultFake['forgetExternalAccessToken']).toHaveBeenCalledOnce()
    expect(runtimeFake.stop).toHaveBeenCalledOnce()
  })
})
