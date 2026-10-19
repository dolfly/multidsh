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

import { setupRegister, teardownRegister, type RegisterHarness } from './register.testkit'

type MockFn = ReturnType<typeof vi.fn>

let harness: RegisterHarness
let invoke: RegisterHarness['invoke']
let vaultFake: Record<string, MockFn>
let settingsFake: Record<string, MockFn>
let runtimeFake: RegisterHarness['runtimeFake']
let authFake: RegisterHarness['authFake']
let auditSpy: RegisterHarness['auditSpy']
let onSettingsChanged: MockFn

beforeEach(async () => {
  harness = await setupRegister()
  ;({ invoke, vaultFake, settingsFake, runtimeFake, authFake, auditSpy, onSettingsChanged } =
    harness)
})

afterEach(async () => {
  await teardownRegister(harness)
})

describe('registerIpc：vault 与偏好设置', () => {
  it('vault:status 返回降级与已记住实例', async () => {
    vaultFake['status']!.mockReturnValueOnce({ available: false, degraded: true, instanceCount: 2 })
    vaultFake['rememberedIds']!.mockReturnValueOnce(['a', 'b'])
    vaultFake['policyIds']!.mockReturnValueOnce(['a', 'b', 'c'])
    vaultFake['getPolicy']!.mockReturnValue({ rememberPassword: true, rememberSession: false })
    const result = (await invoke('vault:status')) as {
      ok: boolean
      value: {
        available: boolean
        degraded: boolean
        rememberedInstances: string[]
        policies: Record<string, unknown>
      }
    }
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({
      available: false,
      degraded: true,
      rememberedInstances: ['a', 'b'],
      policies: {
        a: { rememberPassword: true, rememberSession: false },
        b: { rememberPassword: true, rememberSession: false },
        c: { rememberPassword: true, rememberSession: false }
      }
    })
  })

  it('vault:setPolicy 经 zod 边界校验后落库', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const ok = (await invoke('vault:setPolicy', created.value.id, {
      rememberPassword: true,
      rememberSession: false
    })) as { ok: boolean; value: { rememberPassword: boolean } }
    expect(ok.ok).toBe(true)
    expect(ok.value.rememberPassword).toBe(true)
    expect(vaultFake['setPolicy']).toHaveBeenCalledWith(created.value.id, {
      rememberPassword: true,
      rememberSession: false
    })

    // 非法入参在 IPC 边界被拒(错误信封,不抛异常)
    const bad = (await invoke('vault:setPolicy', created.value.id, {
      rememberPassword: 'yes'
    })) as {
      ok: boolean
      code?: string
    }
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('invalid-input')
  })

  it('vault:forget 缺省两个都忘,并同步取消勾选', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    vaultFake['getPolicy']!.mockReturnValue({ rememberPassword: true, rememberSession: true })

    const result = (await invoke('vault:forget', created.value.id)) as {
      ok: boolean
      value: { rememberPassword: boolean; rememberSession: boolean }
    }
    expect(result.ok).toBe(true)
    expect(vaultFake['forgetPassword']).toHaveBeenCalledWith(created.value.id)
    expect(vaultFake['forgetSession']).toHaveBeenCalledWith(created.value.id)
    // 忘记凭据必须同时取消勾选,否则下次登录又写回来
    expect(vaultFake['setPolicy']).toHaveBeenCalledWith(created.value.id, {
      rememberPassword: false,
      rememberSession: false
    })
  })

  it('vault:clear 清空并写审计(审计只记枚举)', async () => {
    const result = (await invoke('vault:clear')) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(vaultFake['clearAll']).toHaveBeenCalledTimes(1)
    expect(auditSpy).toHaveBeenCalledWith({ event: 'vault-clear', result: 'ok' })
  })

  it('登录成功且勾选「记住密码」才写 vault(失败不写)', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    // 未勾选:登录成功也不写
    authFake.login.mockResolvedValueOnce({
      phase: 'connected',
      needsOnboarding: false,
      otpEnabled: false,
      lockedForMs: 0,
      message: null,
      lastErrorCode: null
    })
    await invoke('auth:login', created.value.id, 'pw', null)
    expect(vaultFake['rememberPassword']).not.toHaveBeenCalled()

    // 勾选 + 成功 → 写
    vaultFake['getPolicy']!.mockReturnValue({ rememberPassword: true, rememberSession: false })
    authFake.login.mockResolvedValueOnce({
      phase: 'connected',
      needsOnboarding: false,
      otpEnabled: false,
      lockedForMs: 0,
      message: null,
      lastErrorCode: null
    })
    await invoke('auth:login', created.value.id, 'hunter2', null)
    expect(vaultFake['rememberPassword']).toHaveBeenCalledWith(created.value.id, 'hunter2')
    expect(auditSpy).toHaveBeenCalledWith({
      instanceId: created.value.id,
      event: 'vault-write',
      result: 'password'
    })

    // 勾选但登录失败 → 不写(否则一次错误输入会把错密码存进钥匙串)
    vaultFake['rememberPassword']!.mockClear()
    authFake.login.mockResolvedValueOnce({
      phase: 'await-credentials',
      needsOnboarding: false,
      otpEnabled: false,
      lockedForMs: 0,
      message: '凭据不正确',
      lastErrorCode: 'invalid-credentials'
    })
    await invoke('auth:login', created.value.id, 'wrong', null)
    expect(vaultFake['rememberPassword']).not.toHaveBeenCalled()
  })

  it('删除实例一并清掉已记住凭据与勾选策略', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: '远程',
      endpointUrl: 'https://gw.example.com/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    await invoke('instances:delete', created.value.id)
    expect(vaultFake['forgetInstance']).toHaveBeenCalledWith(created.value.id)
  })

  it('settings:get 返回偏好快照', async () => {
    const result = (await invoke('settings:get')) as {
      ok: boolean
      value: { language: string; theme: string }
    }
    expect(result.ok).toBe(true)
    expect(result.value.language).toBe('zh')
    expect(result.value.theme).toBe('system')
  })

  it('settings:update 只接受已知字段的部分补丁', async () => {
    const ok = (await invoke('settings:update', { language: 'en', tray: true })) as {
      ok: boolean
      value: { language: string; tray: boolean }
    }
    expect(ok.ok).toBe(true)
    expect(settingsFake['update']).toHaveBeenCalledWith({ language: 'en', tray: true })
    expect(onSettingsChanged).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'en', tray: true }),
      ['language', 'tray']
    )

    onSettingsChanged.mockClear()
    const languageOnly = (await invoke('settings:update', { language: 'zh' })) as { ok: boolean }
    expect(languageOnly.ok).toBe(true)
    expect(onSettingsChanged).toHaveBeenCalledWith(expect.anything(), ['language'])

    // 未知字段被 .strict() 拒绝(错误信封,不抛异常)
    const unknown = (await invoke('settings:update', { nope: 1 })) as { ok: boolean; code?: string }
    expect(unknown.ok).toBe(false)
    expect(unknown.code).toBe('invalid-input')

    // 非法取值同样被拒
    const bad = (await invoke('settings:update', { theme: 'rainbow' })) as { ok: boolean }
    expect(bad.ok).toBe(false)
  })

  it('settings:refreshEnvironment 刷新缓存并返回环境差异与可重启的本机实例', async () => {
    runtimeFake.runningIds.mockReturnValue(['a', 'b', 'ext'])
    runtimeFake.statusOf.mockImplementation((id: string) =>
      id === 'ext' ? { runtimeSource: 'external' } : { runtimeSource: 'hub' }
    )
    runtimeFake.refreshEnv.mockResolvedValue({
      pathComparable: true,
      varsComparable: false,
      pathAdded: ['/opt/homebrew/bin'],
      pathRemoved: [],
      varsAdded: [],
      varsRemoved: [],
      varsChanged: []
    })

    const result = (await invoke('settings:refreshEnvironment')) as {
      ok: boolean
      value: { instances: string[]; diff: { pathAdded: string[] } }
    }

    expect(result.ok).toBe(true)
    // 外部接管的实例不可由 hub 重启，必须被排除
    expect(result.value.instances).toEqual(['a', 'b'])
    // 刷新前后的环境差异原样回传，供渲染层报告「多了什么」
    expect(result.value.diff.pathAdded).toEqual(['/opt/homebrew/bin'])
    expect(runtimeFake.refreshEnv).toHaveBeenCalledOnce()
  })

  it('settings:refreshEnvironment 拒绝多余参数', async () => {
    const result = (await invoke('settings:refreshEnvironment', 'x')) as {
      ok: boolean
      code?: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('invalid-input')
  })
})
