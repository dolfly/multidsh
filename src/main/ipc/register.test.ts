import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// electron 在 vitest node 环境不可加载——整体 mock 掉,只验证注册与边界行为
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
import {
  setupRegister,
  teardownRegister,
  type AuthFake,
  type HttpFake,
  type RegisterHarness,
  type RuntimeFake,
  type TunnelsFake
} from './register.testkit'

type MockFn = ReturnType<typeof vi.fn>

let harness: RegisterHarness
let handlers: RegisterHarness['handlers']
let invoke: RegisterHarness['invoke']
let runtimeFake: RuntimeFake
let tunnelsFake: TunnelsFake
let httpFake: HttpFake
let authFake: AuthFake
let openInstanceView: MockFn
let openExternalUrl: MockFn
let showInstanceTooltip: MockFn
let hideInstanceTooltip: MockFn
let currentStatus: InstanceStatusEvent | null

beforeEach(async () => {
  currentStatus = null
  harness = await setupRegister(() => currentStatus)
  ;({
    handlers,
    invoke,
    runtimeFake,
    tunnelsFake,
    httpFake,
    authFake,
    openInstanceView,
    openExternalUrl,
    showInstanceTooltip,
    hideInstanceTooltip
  } = harness)
})

afterEach(async () => {
  await teardownRegister(harness)
})

const VALID_LOCAL = { transport: 'local', name: 'IPC 实例' }

describe('registerIpc', () => {
  it('注册 app 双探针 + 实例 CRUD + 运行时控制 + /辅助通道', () => {
    const expected = [
      'app:info',
      'app:ping',
      'app:open-homepage',
      'app:open-about',
      'instances:list',
      'instances:get',
      'instances:create',
      'instances:update',
      'instances:delete',
      'instances:reorder',
      'instances:openDirectory',
      'instances:openLogDirectory',
      'instances:start',
      'instances:stop',
      'instances:restart',
      'instances:openView',
      'instances:reloadView',
      'instances:openInBrowser',
      'instances:updateViewBounds',
      'instances:showTooltip',
      'instances:hideTooltip',
      'instances:hideView',
      'instances:disconnectView',
      'instances:probeLocalDsh',
      'instances:scanExternal',
      'instances:adoptExternal',
      'dsh-version:check',
      'dsh-version:upgrade',
      'dsh-version:list',
      'dsh-version:confirmList',
      'dsh-version:confirmReply',
      'plugin:list',
      'plugin:check',
      'plugin:checkState',
      'plugin:install',
      'plugin:resolveInstall',
      'plugin:packageInfo',
      'plugin:upgrade',
      'plugin:remove',
      'plugin:setEnabled',
      'plugin:openExternal',
      'ssh:keyPreview',
      'ssh:hostKeyReply',
      'ssh:hostKeyForget',
      'ssh:askpassReply',
      'http:detect',
      'auth:probe',
      'auth:login',
      'auth:loginStored',
      'auth:logout',
      'vault:status',
      'vault:setPolicy',
      'vault:forget',
      'vault:clear',
      'settings:get',
      'settings:openDataDir',
      'settings:refreshEnvironment',
      'settings:update',
      'spaces:list',
      'spaces:trash'
    ]
    expect([...handlers.keys()].sort()).toEqual(expected.sort())
  })

  it('将经 schema 校验的原生提示交给主进程，并在隐藏时撤销', async () => {
    const shown = (await invoke('instances:showTooltip', { text: '实例名称', x: 72, y: 160 })) as {
      ok: boolean
      value: null
    }
    const hidden = (await invoke('instances:hideTooltip')) as { ok: boolean; value: null }

    expect(shown).toEqual({ ok: true, value: null })
    expect(hidden).toEqual({ ok: true, value: null })
    expect(showInstanceTooltip).toHaveBeenCalledWith({ text: '实例名称', x: 72, y: 160 })
    expect(hideInstanceTooltip).toHaveBeenCalledOnce()
  })

  it('拒绝超长或越界的原生提示载荷', async () => {
    const result = (await invoke('instances:showTooltip', {
      text: 'x'.repeat(201),
      x: -1,
      y: 160
    })) as {
      ok: boolean
      code?: string
    }

    expect(result).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(showInstanceTooltip).not.toHaveBeenCalled()
  })

  it('app:info 返回版本快照', async () => {
    const result = (await invoke('app:info')) as {
      ok: boolean
      value: { appVersion: string; buildCommit: string; buildTime: string }
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.appVersion).toBe('9.9.9')
      // 构建期常量在单测环境无 define 注入，回落 'unknown'；此处守住字段存在与类型。
      expect(typeof result.value.buildCommit).toBe('string')
      expect(typeof result.value.buildTime).toBe('string')
    }
  })

  it('app:ping 原样回显', async () => {
    const result = (await invoke('app:ping', 'hello')) as {
      ok: boolean
      value: { echo: string | null }
    }
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.echo).toBe('hello')
  })

  it('app:ping 非字符串入参 → invalid-input', async () => {
    const result = (await invoke('app:ping', 123)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-input')
  })

  it('start:local 实例 → 交给 runtime.start 并立即返回(不阻塞安装/启动)', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(runtimeFake.start).toHaveBeenCalledTimes(1)
    const record = runtimeFake.start.mock.calls[0]?.[0]
    expect(record).toMatchObject({ id: created.value.id, transport: 'local' })
  })

  it('start:http 实例 → 交给 http 管理器(起 HTTP 可启动),不误触 local/ssh', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(httpFake.start).toHaveBeenCalledTimes(1)
    expect(runtimeFake.start).not.toHaveBeenCalled()
    expect(tunnelsFake.start).not.toHaveBeenCalled()
  })

  it('start:不存在的 id → not-found', async () => {
    const result = (await invoke('instances:start', randomUUID())) as { ok: boolean; code: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('not-found')
  })

  it('start:ssh 实例 → 交给 tunnels.start 并立即返回(不碰 local 运行时)', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(tunnelsFake.start).toHaveBeenCalledTimes(1)
    const record = tunnelsFake.start.mock.calls[0]?.[0]
    expect(record).toMatchObject({ id: created.value.id, transport: 'ssh' })
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('http 实例 start/stop/openView 走 http 管理器', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程直连',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    // start 路由本身由上一条用例守（http→httpFake、不误触 local/ssh），此处只保留 start 副作用。
    const startResult = (await invoke('instances:start', created.value.id)) as { ok: boolean }
    expect(startResult.ok).toBe(true)

    httpFake.statusOf.mockReturnValue({
      id: created.value.id,
      status: 'running',
      url: 'https://gw.example.com/dsh/',
      at: '2026-09-15T00:00:00.000Z'
    })
    const openResult = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(openResult.ok).toBe(true)
    expect(openInstanceView).toHaveBeenCalledTimes(1)

    const stopResult = (await invoke('instances:stop', created.value.id)) as { ok: boolean }
    expect(stopResult.ok).toBe(true)
    expect(httpFake.stop).toHaveBeenCalledWith(created.value.id)
  })

  it('stop:ssh 实例 → tunnels.stop;local 实例 → runtime.stop', async () => {
    const ssh = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!ssh.ok) throw new Error('创建失败')
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')

    const sshStop = (await invoke('instances:stop', ssh.value.id)) as { ok: boolean }
    expect(sshStop.ok).toBe(true)
    expect(tunnelsFake.stop).toHaveBeenCalledWith(ssh.value.id)
    expect(runtimeFake.stop).not.toHaveBeenCalled()

    const localStop = (await invoke('instances:stop', local.value.id)) as { ok: boolean }
    expect(localStop.ok).toBe(true)
    expect(runtimeFake.stop).toHaveBeenCalledWith(local.value.id)
  })

  it('delete:ssh 实例 → 先 tunnels.stop 再移除;http 不触碰传输层', async () => {
    const ssh = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!ssh.ok) throw new Error('创建失败')
    const result = (await invoke('instances:delete', ssh.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(tunnelsFake.stop).toHaveBeenCalledWith(ssh.value.id)

    const http = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!http.ok) throw new Error('创建失败')
    await invoke('instances:delete', http.value.id)
    expect(tunnelsFake.stop).not.toHaveBeenCalledWith(http.value.id)
    expect(runtimeFake.stop).not.toHaveBeenCalledWith(http.value.id)
  })

  it('stop 交给 runtime.stop；之后打开工作区会再次开始准备', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    const stopResult = (await invoke('instances:stop', created.value.id)) as { ok: boolean }
    expect(stopResult.ok).toBe(true)
    expect(runtimeFake.stop).toHaveBeenCalledWith(created.value.id)

    const viewResult = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(viewResult.ok).toBe(true)
    expect(runtimeFake.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id })
    )
  })

  it('openView:ssh 实例 running → 从 tunnels 取状态开窗', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    tunnelsFake.statusOf.mockReturnValue({
      id: created.value.id,
      status: 'running',
      url: 'http://127.0.0.1:30000/',
      port: 30000,
      at: '2026-09-15T00:00:00.000Z'
    })
    // runtime 侧没有该实例的状态(running 只在 tunnels 里)
    currentStatus = null

    const result = (await invoke('instances:openView', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(tunnelsFake.statusOf).toHaveBeenCalledWith(created.value.id)
    expect(openInstanceView).toHaveBeenCalledTimes(1)
    expect(openInstanceView.mock.calls[0]?.[1]).toBe('http://127.0.0.1:30000/')
  })

  it('openView:运行中实例 → 先完成认证探测再打开窗口，避免首个请求落到登录页', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = {
      id: created.value.id,
      status: 'running',
      url: 'http://127.0.0.1:31234/?token=abc',
      port: 31234,
      at: '2026-09-15T00:00:00.000Z'
    }
    let releaseProbe!: () => void
    const probeFinished = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const order: string[] = []
    authFake.probe.mockImplementation(async () => {
      order.push('probe-start')
      await probeFinished
      order.push('probe-end')
      return null
    })
    openInstanceView.mockImplementation(async () => {
      order.push('open-view')
    })

    const opening = invoke('instances:openView', created.value.id) as Promise<{ ok: boolean }>
    await vi.waitFor(() => expect(order).toEqual(['probe-start']))
    expect(openInstanceView).not.toHaveBeenCalled()
    releaseProbe()

    const result = await opening
    expect(result.ok).toBe(true)
    expect(order).toEqual(['probe-start', 'probe-end', 'open-view'])
    expect(openInstanceView.mock.calls[0]?.[1]).toBe('http://127.0.0.1:31234/?token=abc')
  })

  it('openInBrowser:http 实例用归一化端点交给系统浏览器', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程浏览器',
      authMode: 'auto',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const opened = (await invoke('instances:openInBrowser', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith('https://gw.example.com/dsh/')
  })

  it('openInBrowser:运行中的本机实例带 token 的就绪 URL 交给系统浏览器', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    runtimeFake.urlOf.mockReturnValue('http://127.0.0.1:31234/?token=abc')

    const opened = (await invoke('instances:openInBrowser', created.value.id)) as { ok: boolean }
    expect(opened.ok).toBe(true)
    expect(openExternalUrl).toHaveBeenCalledWith('http://127.0.0.1:31234/?token=abc')
  })

  it('openInBrowser:未运行的本机实例返回可见错误，不打开浏览器', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    runtimeFake.urlOf.mockReturnValue(null)

    const opened = (await invoke('instances:openInBrowser', created.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(opened.ok).toBe(false)
    expect(opened.code).toBe('invalid-state')
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('openInBrowser:SSH 实例不支持在浏览器中打开', async () => {
    const created = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道浏览器',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const opened = (await invoke('instances:openInBrowser', created.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(opened.ok).toBe(false)
    expect(opened.code).toBe('invalid-input')
    expect(openExternalUrl).not.toHaveBeenCalled()
  })
})

it('ssh:askpassReply 空串/全空白在 IPC 边界拒绝(invalid-input)', async () => {
  const reply = (secret: unknown) =>
    invoke('ssh:askpassReply', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', secret)
  // 空串与全空白都不是有效口令(UI 已 disabled,这里是 IPC 边界的第二道闸)
  const empty = (await reply('')) as { ok: boolean; code?: string }
  expect(empty.ok).toBe(false)
  expect(empty.code).toBe('invalid-input')
  const blank = (await reply('   ')) as { ok: boolean; code?: string }
  expect(blank.ok).toBe(false)
  expect(blank.code).toBe('invalid-input')
  // null 是合法回答(用户显式取消)
  const cancelled = (await reply(null)) as { ok: boolean }
  expect(cancelled.ok).toBe(true)
})
