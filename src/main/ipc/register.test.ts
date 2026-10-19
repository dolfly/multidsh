import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
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
  TEST_BASE,
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
let vaultFake: Record<string, MockFn>
let listLocalSpaces: MockFn
let trashLocalSpace: MockFn
let openInstanceView: MockFn
let openExternalUrl: MockFn
let auditSpy: RegisterHarness['auditSpy']
let clearPartitionSession: MockFn
let closeInstanceView: MockFn
let reloadInstanceView: MockFn
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
    vaultFake,
    listLocalSpaces,
    trashLocalSpace,
    openInstanceView,
    openExternalUrl,
    auditSpy,
    clearPartitionSession,
    closeInstanceView,
    reloadInstanceView,
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

  it('disconnectView 只销毁指定 WebContentsView，不停止运行时或清除凭据', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:disconnectView', created.value.id)) as {
      ok: boolean
      value: null
    }

    expect(result).toEqual({ ok: true, value: null })
    expect(closeInstanceView).toHaveBeenCalledWith(created.value.id)
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(tunnelsFake.stop).not.toHaveBeenCalled()
    expect(httpFake.stop).not.toHaveBeenCalled()
    expect(authFake.forget).not.toHaveBeenCalled()
    expect(vaultFake['forgetInstance']).not.toHaveBeenCalled()
    expect(vaultFake['forgetSession']).not.toHaveBeenCalled()
  })

  it('reloadView 刷新指定实例的内嵌工作区会话（重新登录后导航回工作区 URL）', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:reloadView', created.value.id)) as {
      ok: boolean
      value: null
    }

    expect(result).toEqual({ ok: true, value: null })
    expect(reloadInstanceView).toHaveBeenCalledWith(created.value.id)
    expect(runtimeFake.stop).not.toHaveBeenCalled()
  })

  it('restart:运行中的 hub 托管实例先停止再按注册表记录重新拉起', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = {
      id: created.value.id,
      status: 'running',
      runtimeSource: 'hub',
      at: new Date().toISOString()
    }

    const result = (await invoke('instances:restart', created.value.id)) as {
      ok: boolean
      value: null
    }

    expect(result).toEqual({ ok: true, value: null })
    expect(runtimeFake.stop).toHaveBeenCalledWith(created.value.id)
    // 重启前刷新登录环境缓存：新装的工具重启实例即可解析到，无需重启 app
    expect(runtimeFake.refreshEnv).toHaveBeenCalledOnce()
    expect(runtimeFake.start).toHaveBeenCalledTimes(1)
    const started = runtimeFake.start.mock.calls[0]?.[0] as { id: string }
    expect(started.id).toBe(created.value.id)
  })

  it('restart:非 local 传输被拒绝且不触碰运行时', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: 'HTTP 实例',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:restart', created.value.id)) as {
      ok: boolean
      code?: string
    }

    expect(result).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('restart:未运行或外部接管被拒绝', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    // 未运行:statusOf 返回 null
    currentStatus = null
    const idle = (await invoke('instances:restart', created.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(idle).toMatchObject({ ok: false, code: 'invalid-state' })

    // 外部接管:进程归用户所有,hub 无权重启
    currentStatus = {
      id: created.value.id,
      status: 'running',
      runtimeSource: 'external',
      at: new Date().toISOString()
    }
    const external = (await invoke('instances:restart', created.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(external).toMatchObject({ ok: false, code: 'invalid-state' })

    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(runtimeFake.start).not.toHaveBeenCalled()
  })

  it('restart:实例不存在报 not-found', async () => {
    const result = (await invoke('instances:restart', '00000000-0000-4000-8000-000000000000')) as {
      ok: boolean
      code?: string
    }
    expect(result).toMatchObject({ ok: false, code: 'not-found' })
  })

  it('ssh:hostKeyForget:入参走 zod 边界,只有 ssh 实例才转交 tunnels.forgetHostKey', async () => {
    // 非 ssh 实例没有主机指纹 → invalid-input。三种情况都不许触碰隧道管理器。
    const invalid = (await invoke('ssh:hostKeyForget', { instanceId: 'not-a-uuid' })) as {
      ok: boolean
      code?: string
    }
    expect(invalid.ok).toBe(false)
    expect(invalid.code).toBe('invalid-input')

    const missing = (await invoke('ssh:hostKeyForget', { instanceId: randomUUID() })) as {
      ok: boolean
      code?: string
    }
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe('not-found')

    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    const wrongTransport = (await invoke('ssh:hostKeyForget', {
      instanceId: local.value.id
    })) as { ok: boolean; code?: string }
    expect(wrongTransport.ok).toBe(false)
    expect(wrongTransport.code).toBe('invalid-input')
    expect(tunnelsFake.forgetHostKey).not.toHaveBeenCalled()

    // ssh 实例 → 转交显式恢复动作,成功返回 null 信封
    const ssh = (await invoke('instances:create', {
      transport: 'ssh',
      name: '隧道',
      host: 'dsh.internal',
      username: 'dev'
    })) as { ok: boolean; value: { id: string } }
    if (!ssh.ok) throw new Error('创建失败')
    const done = (await invoke('ssh:hostKeyForget', { instanceId: ssh.value.id })) as {
      ok: boolean
      value: null
    }
    expect(done.ok).toBe(true)
    expect(done.value).toBeNull()
    expect(tunnelsFake.forgetHostKey).toHaveBeenCalledWith(
      expect.objectContaining({ id: ssh.value.id, transport: 'ssh' })
    )
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

  it('create 合法输入 → ok + 完整记录', async () => {
    const result = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string; transport: string }
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(result.value.transport).toBe('local')
    }
  })

  it('删除隔离本地实例时仅在明确请求后移入废纸篓', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    const withoutTrash = (await invoke('instances:delete', created.value.id, {})) as { ok: boolean }
    expect(withoutTrash.ok).toBe(true)
    expect(trashLocalSpace).not.toHaveBeenCalled()

    const another = (await invoke('instances:create', {
      transport: 'local',
      name: '移入废纸篓'
    })) as {
      ok: boolean
      value: { id: string }
    }
    if (!another.ok) throw new Error('创建失败')
    const withTrash = (await invoke('instances:delete', another.value.id, {
      trashSpace: true
    })) as { ok: boolean }
    expect(withTrash.ok).toBe(true)
    expect(trashLocalSpace).toHaveBeenCalledWith(another.value.id)
  })

  it('列出空间时标注已被本地实例使用的空间', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    listLocalSpaces.mockResolvedValueOnce([
      {
        id: '11111111-1111-4111-8111-111111111111',
        sizeBytes: 4,
        modifiedAt: '2026-09-20T00:00:00.000Z'
      },
      { id: created.value.id, sizeBytes: 3, modifiedAt: '2026-09-21T00:00:00.000Z' }
    ])

    const result = (await invoke('spaces:list')) as {
      ok: boolean
      value: Array<{ id: string; inUse: boolean }>
    }
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.value).toEqual([
        {
          id: created.value.id,
          sizeBytes: 3,
          modifiedAt: '2026-09-21T00:00:00.000Z',
          inUse: true,
          instanceName: 'IPC 实例'
        },
        {
          id: '11111111-1111-4111-8111-111111111111',
          sizeBytes: 4,
          modifiedAt: '2026-09-20T00:00:00.000Z',
          inUse: false,
          instanceName: null
        }
      ])
  })

  it('reuses only an unassigned existing local space', async () => {
    const id = '11111111-1111-4111-8111-111111111111'
    listLocalSpaces.mockResolvedValueOnce([
      { id, sizeBytes: 4, modifiedAt: '2026-09-20T00:00:00.000Z' }
    ])
    const created = (await invoke('instances:create', {
      transport: 'local',
      name: '复用空间',
      existingSpaceId: id
    })) as {
      ok: boolean
      value: { id: string }
    }
    expect(created.ok).toBe(true)
    if (created.ok) expect(created.value.id).toBe(id)
  })
  it('删除实例一并清理认证客户端与分区会话', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    const result = (await invoke('instances:delete', created.value.id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(authFake.forget).toHaveBeenCalledWith(created.value.id)
    expect(clearPartitionSession).toHaveBeenCalledWith(created.value.id)
  })

  it('logout 后清理实例分区会话 Cookie(否则 webview 仍带旧会话)', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const result = (await invoke('auth:logout', id)) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(authFake.logout).toHaveBeenCalledWith(id)
    expect(clearPartitionSession).toHaveBeenCalledWith(id)
    expect(auditSpy).toHaveBeenCalledWith({
      instanceId: id,
      event: 'session-revoked',
      result: 'logout'
    })
    expect(auditSpy).toHaveBeenCalledWith({
      instanceId: id,
      event: 'cookie-cleared',
      result: 'logout'
    })
  })

  it('logout 全程覆盖登出窗口:begin 先于登出,end 在 vault 会话清理之后', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const order: string[] = []
    authFake.beginLogout.mockImplementation(() => {
      order.push('begin')
    })
    authFake.logout.mockImplementation(async () => {
      order.push('logout')
      return null
    })
    authFake.endLogout.mockImplementation(() => {
      order.push('end')
    })
    vaultFake.forgetSession = vi.fn(async () => {
      order.push('forgetSession')
    })

    const result = (await invoke('auth:logout', id)) as { ok: boolean }

    expect(result.ok).toBe(true)
    // 并发探测只可能落在 begin → end 之间：恢复/静默登录/回写在整段窗口内被压住。
    expect(order).toEqual(['begin', 'logout', 'forgetSession', 'end'])
  })

  it('logout 清理失败：登出仍回成功信封，清理降级为留痕，后续步骤必达', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      clearPartitionSession.mockRejectedValueOnce(new Error('partition 不可用'))
      const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
      const result = (await invoke('auth:logout', id)) as { ok: boolean }
      // 登出成功 → 成功信封（渲染层只在 ok 时提示「已登出」，报错信封会让用户失去反馈）。
      expect(result).toMatchObject({ ok: true })
      expect(authFake.logout).toHaveBeenCalledWith(id)
      // 失败点之后的步骤必达：vault 会话被遗忘、两条安全审计都记录。
      expect(vaultFake.forgetSession).toHaveBeenCalledWith(id)
      expect(auditSpy).toHaveBeenCalledWith({
        instanceId: id,
        event: 'session-revoked',
        result: 'logout'
      })
      // cookie 清理失败如实标记，而不是让这条审计消失。
      expect(auditSpy).toHaveBeenCalledWith({
        instanceId: id,
        event: 'cookie-cleared',
        result: 'failed'
      })
      // 留痕（二）：console 记录失败原因，主进程日志可查。
      expect(errSpy).toHaveBeenCalledWith('[ipc] 登出时清理分区会话失败：', id, expect.any(Error))
    } finally {
      errSpy.mockRestore()
    }
  })

  it('auth:loginStored requires an enabled password policy', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: false, rememberSession: true })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    const result = (await invoke('auth:loginStored', id, null)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-input')
    expect(authFake.login).not.toHaveBeenCalled()
  })

  it('auth:loginStored rejects an unavailable stored password', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue(null)
    const result = (await invoke('auth:loginStored', id, null)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-input')
    expect(authFake.login).not.toHaveBeenCalled()
  })

  it('auth:loginStored reads the stored password in the main process', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    authFake.login.mockResolvedValueOnce({ phase: 'connected', lockedForMs: 0 })
    const result = (await invoke('auth:loginStored', id, '654321')) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(authFake.login).toHaveBeenCalledWith(id, 'stored-secret', '654321')
  })

  it('auth:loginStored validates OTP length before logging in', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    const result = (await invoke('auth:loginStored', id, '12')) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid-input')
    expect(authFake.login).not.toHaveBeenCalled()
  })

  // 真实状态机下 probe 终态是 await-credentials(probe-gateway → session-absent),
  // 只认 needs-auth 会让静默登录生产不可达。
  it('probe attempts stored-password login once from await-credentials', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    authFake.stateOf.mockReturnValue({ phase: 'await-credentials', lockedForMs: 0 })
    authFake.login.mockResolvedValue({ phase: 'connected', lockedForMs: 0 })
    const first = (await invoke('auth:probe', id)) as { ok: boolean; value?: { phase: string } }
    expect(first.ok).toBe(true)
    expect(first.value?.phase).toBe('connected')
    expect(authFake.login).toHaveBeenCalledTimes(1)
    expect(authFake.login).toHaveBeenCalledWith(id, 'stored-secret', undefined)
    // 第二次探测:已尝试过,不再自动登录(401/429 一律交还用户)
    await invoke('auth:probe', id)
    expect(authFake.login).toHaveBeenCalledTimes(1)
  })

  it('remote session expiry from connected resets the stored-password attempt', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    const connected = { phase: 'connected', lockedForMs: 0 }
    const awaiting = { phase: 'await-credentials', lockedForMs: 0 }
    authFake.stateOf
      .mockReturnValueOnce(connected)
      .mockReturnValueOnce(awaiting)
      .mockReturnValueOnce(connected)
      .mockReturnValueOnce(awaiting)
    authFake.login.mockResolvedValue({ phase: 'connected', lockedForMs: 0 })

    await invoke('auth:probe', id)
    await invoke('auth:probe', id)

    expect(authFake.login).toHaveBeenCalledTimes(2)
    expect(authFake.login).toHaveBeenNthCalledWith(1, id, 'stored-secret', undefined)
    expect(authFake.login).toHaveBeenNthCalledWith(2, id, 'stored-secret', undefined)
  })

  it('probe only attempts silent login from eligible phases', async () => {
    // 每个相用独立实例:静默尝试「每实例一次」的记账不该掩盖相本身的判定
    const uid = ((): (() => string) => {
      let n = 0
      return () => `f47ac10b-58cc-4372-a567-${String(++n).padStart(12, '0')}`
    })()
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    authFake.login.mockResolvedValue({ phase: 'connected', lockedForMs: 0 })
    // needs-auth(首探瞬间相):防御性触发
    authFake.stateOf.mockReturnValue({ phase: 'needs-auth', lockedForMs: 0 })
    await invoke('auth:probe', uid())
    expect(authFake.login).toHaveBeenCalledTimes(1)
    // await-otp:已到验证码阶段,密码复用走 AuthPanel 的 loginStored,不再自动重发
    authFake.stateOf.mockReturnValue({ phase: 'await-otp', lockedForMs: 0 })
    await invoke('auth:probe', uid())
    expect(authFake.login).toHaveBeenCalledTimes(1)
    // connected / error / null:无认证需求
    for (const phase of ['connected', 'error']) {
      authFake.stateOf.mockReturnValue({ phase, lockedForMs: 0 })
      await invoke('auth:probe', uid())
    }
    authFake.stateOf.mockReturnValue(null)
    await invoke('auth:probe', uid())
    expect(authFake.login).toHaveBeenCalledTimes(1)
    // 锁定中(429 之后):不自动重试
    authFake.stateOf.mockReturnValue({ phase: 'await-credentials', lockedForMs: 30_000 })
    await invoke('auth:probe', uid())
    expect(authFake.login).toHaveBeenCalledTimes(1)
  })

  it('successful manual login re-enables silent login after logout', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    authFake.stateOf.mockReturnValue({ phase: 'await-credentials', lockedForMs: 0 })
    authFake.login.mockResolvedValue({ phase: 'connected', lockedForMs: 0 })
    // 登出 → 探测:不得立即用已存密码复活会话
    await invoke('auth:logout', id)
    await invoke('auth:probe', id)
    expect(authFake.login).not.toHaveBeenCalled()
    // 手动登录成功 → 解除压制;此后会话再次失效时允许静默登录
    await invoke('auth:login', id, 'manual-pw')
    await invoke('auth:probe', id)
    expect(authFake.login).toHaveBeenCalledTimes(2) // 1 次手动 + 1 次静默
    expect(authFake.login).toHaveBeenLastCalledWith(id, 'stored-secret', undefined)
  })

  it('silent login errors do not change the probe result', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
    vaultFake.getPassword?.mockReturnValue('stored-secret')
    const awaiting = { phase: 'await-credentials', lockedForMs: 0 }
    authFake.stateOf.mockReturnValue(awaiting)
    authFake.login.mockRejectedValueOnce(new Error('network down'))
    const result = (await invoke('auth:probe', id)) as { ok: boolean; value?: unknown }
    expect(result.ok).toBe(true)
    expect(result.value).toEqual(awaiting)
    expect(authFake.login).toHaveBeenCalledTimes(1)
    // 抛错同样记账:会话内不再重试
    await invoke('auth:probe', id)
    expect(authFake.login).toHaveBeenCalledTimes(1)
  })

  it('集成 —— 真实 auth-registry + 真实状态机(不 mock stateOf)打通静默登录', async () => {
    // 静默登录必须在该前提下真实可达 —— mock stateOf 成 needs-auth 掩盖过这个前提。
    const { createAuthRegistry } = await import('../auth/auth-registry')
    const gwUrl = 'https://gw.example.com/dsh'
    const realRegistry = createAuthRegistry({
      resolveEndpoint: async () => gwUrl,
      fetchImpl: (async (input: string | URL) => {
        const url = String(input)
        if (url.includes('/login/auth')) {
          // 登录成功:200 + Set-Cookie(网关协议要求会话 Cookie,缺失 = 协议异常)
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'set-cookie': 'dsh_auth=ticket; Path=/; HttpOnly'
            }
          })
        }
        // 探测:302 → /login = 网关登录页
        return new Response('', {
          status: 302,
          headers: { 'content-type': 'text/html', location: '/dsh/login' }
        })
      }) as unknown as typeof fetch
    })
    // 用真实注册表的三个方法替换 fake(probe/login/stateOf 是静默登录链路全部);
    // 其余方法(forget/client/sessionCookie/clientIds)继续用 fake,避免牵连别的用例
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const saved = { ...authFake }
    authFake.probe = realRegistry.probe.bind(realRegistry) as never
    authFake.login = realRegistry.login.bind(realRegistry) as never
    authFake.stateOf = realRegistry.stateOf.bind(realRegistry) as never
    try {
      vaultFake.getPolicy?.mockReturnValue({ rememberPassword: true, rememberSession: false })
      vaultFake.getPassword?.mockReturnValue('stored-secret')
      const result = (await invoke('auth:probe', id)) as {
        ok: boolean
        value?: { phase: string }
      }
      expect(result.ok).toBe(true)
      expect(result.value?.phase).toBe('connected')
      // 会话 Cookie 已入罐(静默登录真实生效,不是状态对象凑出来的)
      expect(realRegistry.sessionCookie(id)?.name).toBe('dsh_auth')
    } finally {
      Object.assign(authFake, saved)
    }
  })

  it('host 以 - 开头被拒(argv 选项注入面)', async () => {
    for (const host of ['-p2222', '-lroot', '-Fevil', '-oProxyCommand=evil']) {
      const result = (await invoke('instances:create', {
        transport: 'ssh',
        name: '注入尝试',
        host,
        username: 'dev'
      })) as { ok: boolean; code?: string; message?: string }
      expect(result.ok, `host=${host} 应被拒绝`).toBe(false)
      if (!result.ok) expect(result.code).toBe('invalid-input')
    }
    // 合法别名/主机仍可用
    const okHost = (await invoke('instances:create', {
      transport: 'ssh',
      name: '别名',
      host: 'build-01',
      username: 'dev'
    })) as { ok: boolean }
    expect(okHost.ok).toBe(true)
  })

  it('create 非法输入 → 错误信封 invalid-input,不抛异常', async () => {
    const result = (await invoke('instances:create', {
      transport: 'local',
      name: 'x',
      unknownField: 1
    })) as { ok: boolean; code: string; message: string }
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('invalid-input')
      expect(result.message).toContain('unknownField')
    }
  })

  it('list 返回摘要形态(不含 notes 等详情)', async () => {
    await invoke('instances:create', { ...VALID_LOCAL, notes: '秘密备注' })
    const result = (await invoke('instances:list')) as {
      ok: boolean
      value: Array<Record<string, unknown>>
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      const summary = result.value[0]
      expect(summary).toBeDefined()
      expect(summary).not.toHaveProperty('notes')
      expect(summary).toHaveProperty('transport')
      expect(summary).toHaveProperty('authMode')
      // 数据目录由主进程按平台分隔符拼好，渲染层不再自行拼接
      expect(summary).toHaveProperty(
        'localHome',
        join(TEST_BASE, 'homes', (summary as { id: string }).id)
      )
    }
  })

  it('list：本机实例停止后版本回落到注册表 dshVersion，不退回空', async () => {
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      dshVersion: '0.1.7-rc.2'
    })) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    // 运行时未运行 → statusOf 返回 null（无实时版本），摘要应回落到注册表固定的版本。
    currentStatus = null

    const result = (await invoke('instances:list')) as {
      ok: boolean
      value: Array<{ id: string; version?: string }>
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      const summary = result.value.find((item) => item.id === created.value.id)
      expect(summary?.version).toBe('0.1.7-rc.2')
    }
  })

  it('list：运行中的实时版本优先于注册表 dshVersion', async () => {
    const created = (await invoke('instances:create', { ...VALID_LOCAL, dshVersion: '0.1.4' })) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = {
      id: created.value.id,
      status: 'running',
      version: '0.1.7-rc.2',
      at: '2026-09-28T00:00:00.000Z'
    }

    const result = (await invoke('instances:list')) as {
      ok: boolean
      value: Array<{ id: string; version?: string }>
    }
    expect(result.ok).toBe(true)
    if (result.ok) {
      const summary = result.value.find((item) => item.id === created.value.id)
      expect(summary?.version).toBe('0.1.7-rc.2')
    }
  })

  it('get 非法 id → invalid-input;不存在 → ok null', async () => {
    const bad = (await invoke('instances:get', 'not-a-uuid')) as { ok: boolean; code: string }
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('invalid-input')

    const missing = (await invoke('instances:get', randomUUID())) as { ok: boolean; value: unknown }
    expect(missing.ok).toBe(true)
    if (missing.ok) expect(missing.value).toBeNull()
  })

  it('update 非法补丁 → invalid-input;不存在 → not-found', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    const badPatch = (await invoke('instances:update', created.value.id, {
      port: 'x'
    })) as { ok: boolean; code: string }
    expect(badPatch.ok).toBe(false)
    expect(badPatch.code).toBe('invalid-input')

    const missingId = (await invoke('instances:update', randomUUID(), {
      name: 'x'
    })) as { ok: boolean; code: string }
    expect(missingId.ok).toBe(false)
    expect(missingId.code).toBe('not-found')
  })

  it('delete 返回 removed 标志', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    const removed = (await invoke('instances:delete', created.value.id)) as {
      ok: boolean
      value: { removed: boolean }
    }
    expect(removed.ok).toBe(true)
    if (removed.ok) expect(removed.value.removed).toBe(true)

    const again = (await invoke('instances:delete', created.value.id)) as {
      ok: boolean
      value: { removed: boolean }
    }
    if (again.ok) expect(again.value.removed).toBe(false)
  })

  it('delete:local 实例 → 先 runtime.stop 再移除记录(运行中不留孤儿进程)', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:delete', created.value.id)) as {
      ok: boolean
      value: { removed: boolean }
    }
    expect(runtimeFake.stop).toHaveBeenCalledWith(created.value.id)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.removed).toBe(true)
  })

  it('delete:非 local 实例不触碰运行时', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('instances:delete', created.value.id)) as { ok: boolean }
    expect(runtimeFake.stop).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('delete:保险库清理失败不阻断实例记录移除(留痕而非报错)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const created = (await invoke('instances:create', VALID_LOCAL)) as {
        ok: boolean
        value: { id: string }
      }
      if (!created.ok) throw new Error('创建失败')
      // 模拟 Windows 上 vault 落盘偶发失败：删除仍必须成功移除记录。
      vaultFake['forgetInstance'] = vi.fn(async () => {
        throw new Error('vault 落盘失败')
      })

      const result = (await invoke('instances:delete', created.value.id)) as {
        ok: boolean
        value: { removed: boolean }
      }
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.removed).toBe(true)
      expect(errSpy).toHaveBeenCalledWith(
        '[ipc] 删除时清理保险库条目失败：',
        created.value.id,
        expect.any(Error)
      )
    } finally {
      errSpy.mockRestore()
    }
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
