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
let vaultFake: RegisterHarness['vaultFake']
let externalDshScannerFake: RegisterHarness['externalDshScannerFake']
let verifyExternalAccess: RegisterHarness['verifyExternalAccess']
let openInstanceView: RegisterHarness['openInstanceView']
let auditSpy: RegisterHarness['auditSpy']
let currentStatus: InstanceStatusEvent | null

beforeEach(async () => {
  currentStatus = null
  harness = await setupRegister(() => currentStatus)
  ;({
    invoke,
    runtimeFake,
    vaultFake,
    externalDshScannerFake,
    verifyExternalAccess,
    openInstanceView,
    auditSpy
  } = harness)
})

afterEach(async () => {
  await teardownRegister(harness)
})

const VALID_LOCAL = { transport: 'local', name: 'IPC 实例' }

describe('registerIpc：外部实例扫描与接管', () => {
  it('本机已有 dsh web 时创建实例会绑定其端口，而非额外启动新进程', async () => {
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 52300, patch: '/x.yml', command: 'node /x/dsh web --patch /x.yml' }
    ])
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      useExistingExternal: true,
      externalPid: 84758,
      externalAccess: 'access-token'
    })) as {
      ok: boolean
      value: { id: string; port: number | null }
    }
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.value.port).toBe(52300)

    const opened = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(openInstanceView).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id }),
      'http://127.0.0.1:52300/?token=access-token'
    )
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('scanExternal:无参数、只读投影、缺省装配返回空列表', async () => {
    externalDshScannerFake.scan.mockResolvedValueOnce([
      {
        pid: 84758,
        port: 3080,
        patch: '/Users/x/.dush/cordis.dush.patch.yml',
        command: 'node /Users/x/.local/bin/dsh web --patch /x.yml --no-open',
        // 探测器内部字段不应外泄(只投影 pid/port/patch/command)
        internalNote: 'should-not-leak'
      }
    ])
    const result = (await invoke('instances:scanExternal')) as {
      ok: boolean
      value: Array<Record<string, unknown>>
    }
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toHaveLength(1)
    expect(Object.keys(result.value[0] ?? {}).sort()).toEqual(
      ['command', 'patch', 'pid', 'port'].sort()
    )
  })

  it('adoptExternal:端口/patch 由主进程重新扫描认定,渲染层只传 pid', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: '/x.yml', command: 'node /x/dsh web --patch /x.yml' }
    ])
    const adopted = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'http://127.0.0.1:3080/?token=token-value'
    )) as {
      ok: boolean
    }
    expect(adopted.ok).toBe(true)
    expect(runtimeFake.adopt).toHaveBeenCalledWith(
      expect.objectContaining({ id: local.value.id }),
      { pid: 84758, port: 3080, patch: '/x.yml' }
    )
    expect(auditSpy).toHaveBeenCalledWith({
      instanceId: local.value.id,
      event: 'connect',
      result: 'adopt-external'
    })
  })

  it('接管时可复用已保存的外部 token，渲染层无需再次提交凭据', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    vaultFake['getExternalAccessToken']!.mockReturnValue('saved-token')

    const adopted = (await invoke('instances:adoptExternal', local.value.id, 84758, '')) as {
      ok: boolean
    }
    expect(adopted.ok).toBe(true)
    expect(verifyExternalAccess).toHaveBeenCalledWith('http://127.0.0.1:3080/?token=saved-token')
    expect(vaultFake['rememberExternalAccessToken']).not.toHaveBeenCalled()
  })

  it('外部接管的 token 持久化失败时不改变现有运行时', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    vaultFake['rememberExternalAccessToken']!.mockRejectedValueOnce(
      new Error('keychain unavailable')
    )

    const adopted = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'new-token'
    )) as { ok: boolean }

    expect(adopted.ok).toBe(false)
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(runtimeFake.adopt).not.toHaveBeenCalled()
  })

  it('外部 dsh 接管验证 token 后保存，失效 token 会被清除并要求重新输入', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])

    const saved = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'valid-token'
    )) as { ok: boolean }
    expect(saved.ok).toBe(true)
    expect(verifyExternalAccess).toHaveBeenCalledWith('http://127.0.0.1:3080/?token=valid-token')
    expect(vaultFake['rememberExternalAccessToken']).toHaveBeenCalledWith(
      local.value.id,
      'valid-token'
    )

    currentStatus = null
    verifyExternalAccess.mockResolvedValueOnce(false)
    const rejected = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'invalid-token'
    )) as {
      ok: boolean
      code?: string
    }
    expect(rejected.ok).toBe(false)
    expect(rejected.code).toBe('invalid-state')
    expect(vaultFake['forgetExternalAccessToken']).not.toHaveBeenCalled()
  })

  it('接管外部 dsh 的 token 只用于匹配 PID 的回环 URL，拒绝远程或错误端口', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])

    const remote = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'https://example.com/?token=x'
    )) as {
      ok: boolean
      code?: string
    }
    expect(remote.ok).toBe(false)
    expect(remote.code).toBe('invalid-input')

    const localhost = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'http://localhost:3080/?token=x'
    )) as {
      ok: boolean
      code?: string
    }
    expect(localhost.ok).toBe(false)
    expect(localhost.code).toBe('invalid-input')

    const wrongPort = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'http://127.0.0.1:3081/?token=x'
    )) as {
      ok: boolean
      code?: string
    }
    expect(wrongPort.ok).toBe(false)
    expect(wrongPort.code).toBe('invalid-input')

    const nullByte = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'http://127.0.0.1:3080/?token=%00'
    )) as { ok: boolean; code?: string }
    expect(nullByte.ok).toBe(false)
    expect(nullByte.code).toBe('invalid-input')

    const newline = (await invoke(
      'instances:adoptExternal',
      local.value.id,
      84758,
      'http://127.0.0.1:3080/?token=%0A'
    )) as { ok: boolean; code?: string }
    expect(newline.ok).toBe(false)
    expect(newline.code).toBe('invalid-input')
  })

  it('不允许运行中的实例覆盖已接管外部 dsh 的访问会话', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    currentStatus = { id: local.value.id, status: 'running', at: '2026-09-17T00:00:00.000Z' }
    runtimeFake.runningIds.mockReturnValue([local.value.id])
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    const adopted = (await invoke('instances:adoptExternal', local.value.id, 84758, 'token')) as {
      ok: boolean
      code?: string
    }
    expect(adopted.ok).toBe(false)
    expect(adopted.code).toBe('invalid-state')
    expect(runtimeFake.adopt).not.toHaveBeenCalled()
  })

  it('已接管的外部 dsh 可用新 token 重新接管，但 hub 启动的实例仍被拒绝', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    currentStatus = {
      id: local.value.id,
      status: 'running',
      runtimeSource: 'external',
      at: '2026-09-17T00:00:00.000Z'
    }
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84758, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])
    runtimeFake.runningIds.mockReturnValue([local.value.id])

    await expect(
      invoke('instances:adoptExternal', local.value.id, 84758, 'rotated-token')
    ).resolves.toEqual({
      ok: true,
      value: null
    })
    expect(runtimeFake.stop).toHaveBeenCalledWith(local.value.id)
    expect(runtimeFake.adopt).toHaveBeenCalledWith(
      expect.objectContaining({ id: local.value.id }),
      {
        pid: 84758,
        port: 3080,
        patch: null
      }
    )
  })

  it('意外退出留下 error 状态时，仍可用新 token 接管重启的外部 dsh', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    currentStatus = { id: local.value.id, status: 'error', at: '2026-09-17T00:00:00.000Z' }
    runtimeFake.runningIds.mockReturnValue([])
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 84759, port: 3080, patch: null, command: 'node /x/dsh web' }
    ])

    await expect(
      invoke('instances:adoptExternal', local.value.id, 84759, 'new-token')
    ).resolves.toEqual({
      ok: true,
      value: null
    })
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(runtimeFake.adopt).toHaveBeenCalledWith(
      expect.objectContaining({ id: local.value.id }),
      {
        pid: 84759,
        port: 3080,
        patch: null
      }
    )
  })

  it('adoptExternal 边界:pid 不存在 / 端口未知 / 非本地实例 / 非法 pid 都被拒', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')

    // pid 不在扫描结果里 → not-found
    externalDshScannerFake.scan.mockResolvedValue([])
    const missing = (await invoke('instances:adoptExternal', local.value.id, 999, 'token')) as {
      ok: boolean
      code?: string
    }
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('not-found')

    // 端口未知 → invalid-state(接管也无法开窗)
    externalDshScannerFake.scan.mockResolvedValue([
      { pid: 5, port: null, patch: null, command: 'node /x/dsh web' }
    ])
    const noPort = (await invoke('instances:adoptExternal', local.value.id, 5, 'token')) as {
      ok: boolean
      code?: string
    }
    expect(noPort.ok).toBe(false)
    if (!noPort.ok) expect(noPort.code).toBe('invalid-state')

    // 非本地实例 → invalid-input(http/ssh 不能「本机接管」)
    const httpInstance = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!httpInstance.ok) throw new Error('创建失败')
    const wrongTransport = (await invoke(
      'instances:adoptExternal',
      httpInstance.value.id,
      5,
      'token'
    )) as {
      ok: boolean
      code?: string
    }
    expect(wrongTransport.ok).toBe(false)
    if (!wrongTransport.ok) expect(wrongTransport.code).toBe('invalid-input')

    // 非法 pid(负数/非整数)→ invalid-input;不触碰 runtime.adopt
    runtimeFake.adopt.mockClear()
    const badPid = (await invoke('instances:adoptExternal', local.value.id, -1, 'token')) as {
      ok: boolean
      code?: string
    }
    expect(badPid.ok).toBe(false)
    if (!badPid.ok) expect(badPid.code).toBe('invalid-input')
    expect(runtimeFake.adopt).not.toHaveBeenCalled()
  })

  it('/http:detect 非法 URL → invalid-input(而非 internal)', async () => {
    for (const bad of ['ftp://x', 'http://user:pw@h/', 'not a url', '']) {
      const result = (await invoke('http:detect', bad)) as { ok: boolean; code?: string }
      expect(result.ok, `URL=${JSON.stringify(bad)} 应被拒绝`).toBe(false)
      if (!result.ok) {
        expect(result.code, `URL=${JSON.stringify(bad)} 的错误码`).toBe('invalid-input')
      }
    }
  })

  it('http:detect 合法 URL 调通(本地 200 服务 → none)', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>ok</html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
      const result = (await invoke('http:detect', `http://127.0.0.1:${port}`)) as {
        ok: boolean
        value?: { mode: string }
      }
      expect(result.ok).toBe(true)
      expect(result.value?.mode).toBe('none')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
