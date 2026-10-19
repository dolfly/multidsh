import { randomUUID } from 'node:crypto'
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
import { createInstanceStore } from '../registry/instance-store'
import { registerIpc } from './register'
import { setupRegister, teardownRegister, type RegisterHarness } from './register.testkit'

let harness: RegisterHarness
let dir: RegisterHarness['dir']
let invoke: RegisterHarness['invoke']
let ipcDeps: RegisterHarness['ipcDeps']
let runtimeFake: RegisterHarness['runtimeFake']
let installerFake: RegisterHarness['installerFake']
let promptBrokerFake: RegisterHarness['promptBrokerFake']
let currentStatus: InstanceStatusEvent | null

beforeEach(async () => {
  currentStatus = null
  harness = await setupRegister(() => currentStatus)
  ;({ dir, invoke, ipcDeps, runtimeFake, installerFake, promptBrokerFake } = harness)
})

afterEach(async () => {
  await teardownRegister(harness)
})

const VALID_LOCAL = { transport: 'local', name: 'IPC 实例' }

describe('registerIpc：版本检查与升级编排', () => {
  it('check：hub 托管 local 实例，current < latest 时报告有更新且可升级', async () => {
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      dshVersion: '0.1.4'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = {
      id: created.value.id,
      status: 'stopped',
      runtimeSource: 'hub',
      at: new Date().toISOString()
    }

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      ok: boolean
      value: {
        current: string | null
        latest: string
        hasUpdate: boolean
        canUpgrade: boolean
        reason?: string
      }
    }

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({
      current: '0.1.4',
      latest: '0.1.5',
      hasUpdate: true,
      canUpgrade: true
    })
    expect(result.value.reason).toBeUndefined()
  })

  it('check：状态事件版本优先于注册表 dshVersion，已是最新时 hasUpdate=false', async () => {
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      dshVersion: '0.1.4'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = {
      id: created.value.id,
      status: 'running',
      runtimeSource: 'hub',
      version: '0.1.5',
      at: new Date().toISOString()
    }

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      ok: boolean
      value: { current: string | null; hasUpdate: boolean }
    }

    expect(result.value.current).toBe('0.1.5')
    expect(result.value.hasUpdate).toBe(false)
  })

  it('check：从未启动过（current=null）的 hub 实例视为有更新', async () => {
    const created = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = null

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      ok: boolean
      value: { current: string | null; hasUpdate: boolean; canUpgrade: boolean }
    }

    expect(result.value).toMatchObject({ current: null, hasUpdate: true, canUpgrade: true })
  })

  it('check：本地实例（含 dush/duush、path 来源）可升级；仅外部接管与非本地不可升级并给出原因', async () => {
    for (const launcher of ['dush', 'duush'] as const) {
      // 隔离空间：hub 代管自己的运行时（含 path 来源在升级时接管）
      const isolated = (await invoke('instances:create', {
        ...VALID_LOCAL,
        launcher
      })) as { ok: boolean; value: { id: string } }
      if (!isolated.ok) throw new Error('创建失败')
      currentStatus = {
        id: isolated.value.id,
        status: 'running',
        runtimeSource: 'path',
        at: new Date().toISOString()
      }
      const isolatedResult = (await invoke('dsh-version:check', isolated.value.id)) as {
        value: { canUpgrade: boolean; reason?: string }
      }
      expect(isolatedResult.value).toMatchObject({ canUpgrade: true })
      expect(isolatedResult.value.reason).toBeUndefined()

      // 公共空间：升级对象是系统默认 dsh（默认装配不带 pathProbe 时跳过来源检测）
      const shared = (await invoke('instances:create', {
        ...VALID_LOCAL,
        launcher,
        useDefaultSpace: true
      })) as { ok: boolean; value: { id: string } }
      if (!shared.ok) throw new Error('创建失败')
      currentStatus = {
        id: shared.value.id,
        status: 'running',
        runtimeSource: 'path',
        at: new Date().toISOString()
      }
      const sharedResult = (await invoke('dsh-version:check', shared.value.id)) as {
        value: { canUpgrade: boolean; reason?: string }
      }
      expect(sharedResult.value).toMatchObject({ canUpgrade: true })
      expect(sharedResult.value.reason).toBeUndefined()
    }

    // 推广：默认 dsh 启动器的 path 来源同样可升级（升级时接管进 hub 隔离目录）
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    currentStatus = {
      id: local.value.id,
      status: 'running',
      runtimeSource: 'path',
      at: new Date().toISOString()
    }
    const pathResult = (await invoke('dsh-version:check', local.value.id)) as {
      value: { canUpgrade: boolean; reason?: string }
    }
    expect(pathResult.value).toMatchObject({ canUpgrade: true })
    expect(pathResult.value.reason).toBeUndefined()

    currentStatus = {
      id: local.value.id,
      status: 'running',
      runtimeSource: 'external',
      at: new Date().toISOString()
    }
    const externalResult = (await invoke('dsh-version:check', local.value.id)) as {
      value: { canUpgrade: boolean; reason?: string }
    }
    expect(externalResult.value).toMatchObject({ canUpgrade: false, reason: 'runtime-external' })
  })

  it('check：公共空间实例的 current 取 PATH 实测版本；来源无法代管时主动给出原因', async () => {
    const probe = vi.fn(async (): Promise<{ command: string; version: string } | null> => ({
      command: '/Users/x/.local/bin/dsh',
      version: '0.1.6'
    }))
    registerIpc(createInstanceStore({ dir }), {
      ...ipcDeps,
      pathProbe: { probe, probeLauncher: async () => null }
    })
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      launcher: 'dush',
      useDefaultSpace: true,
      dshVersion: '0.1.4'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    // 注册表里的 0.1.4 已过期：公共空间以系统 dsh 实测版本为准
    currentStatus = null

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      value: {
        current: string | null
        latest: string
        hasUpdate: boolean
        canUpgrade: boolean
        reason?: string
      }
    }
    expect(probe).toHaveBeenCalled()
    expect(result.value).toMatchObject({
      current: '0.1.6',
      latest: '0.1.5',
      hasUpdate: false,
      canUpgrade: true
    })
    expect(installerFake.resolveGlobalPrefix).toHaveBeenCalledWith('/Users/x/.local/bin/dsh')

    // 来源检测：系统 dsh 非 npm 全局安装 → 检查时就给出不可代管原因，不等用户点升级才失败
    installerFake.resolveGlobalPrefix.mockResolvedValueOnce(null)
    const unmanaged = (await invoke('dsh-version:check', created.value.id)) as {
      value: { canUpgrade: boolean; reason?: string }
    }
    expect(unmanaged.value).toMatchObject({ canUpgrade: false, reason: 'global-unmanaged' })

    // 探不到系统 dsh：current 按未知，同样主动提示不可代管
    probe.mockResolvedValueOnce(null)
    const missing = (await invoke('dsh-version:check', created.value.id)) as {
      value: { current: string | null; hasUpdate: boolean; canUpgrade: boolean; reason?: string }
    }
    expect(missing.value).toMatchObject({
      current: null,
      hasUpdate: false,
      canUpgrade: false,
      reason: 'global-unmanaged'
    })
  })

  it('check：公共空间默认启动器未启动时按启动计划判定，hub 已装固定版本不按 PATH 改写 current', async () => {
    const probe = vi.fn(async () => ({ command: '/Users/x/.local/bin/dsh', version: '0.1.9' }))
    const listInstalled = vi.fn(async () => [
      {
        version: '0.1.4',
        dir: '/tmp/dsh-0.1.4',
        entry: '/tmp/e',
        installedAt: '2026-09-18T00:00:00.000Z'
      }
    ])
    registerIpc(createInstanceStore({ dir }), {
      ...ipcDeps,
      pathProbe: { probe, probeLauncher: async () => null },
      installer: { ...installerFake, listInstalled } as never
    })
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      useDefaultSpace: true,
      dshVersion: '0.1.4'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = null

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      value: { current: string | null; canUpgrade: boolean; reason?: string }
    }

    // 计划 = 固定版本已在 hub → 下次启动跑 hub 副本：current 取注册表版本，
    // 不被 PATH 实测版本改写，也不做系统 dsh 的安装来源检测。
    expect(result.value).toMatchObject({ current: '0.1.4', canUpgrade: true })
    expect(result.value.reason).toBeUndefined()
    expect(listInstalled).toHaveBeenCalled()
    expect(installerFake.resolveGlobalPrefix).not.toHaveBeenCalled()
  })

  it('probeLocalDsh：按 LAUNCHERS 逐个探测，命中项含 duush、未命中项不出现', async () => {
    registerIpc(createInstanceStore({ dir }), {
      ...ipcDeps,
      pathProbe: {
        probe: async () => ({ command: '/Users/x/.local/bin/dsh', version: '0.1.6' }),
        probeLauncher: async (launcher) =>
          launcher === 'dush'
            ? null
            : { command: `/Users/x/.local/bin/${launcher}`, version: '0.1.6' }
      }
    })

    const result = (await invoke('instances:probeLocalDsh')) as {
      value: Array<{ launcher: string; version: string }>
    }
    expect(result.value).toEqual([
      { launcher: 'dsh', version: '0.1.6' },
      { launcher: 'duush', version: '0.1.6' }
    ])
  })

  it('check：非 local 传输报 not-local', async () => {
    const created = (await invoke('instances:create', {
      transport: 'http',
      name: 'HTTP 实例',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')

    const result = (await invoke('dsh-version:check', created.value.id)) as {
      value: { canUpgrade: boolean; reason?: string }
    }
    expect(result.value).toMatchObject({ canUpgrade: false, reason: 'not-local' })
  })

  it('dsh-version:list：按版本从新到旧返回可用版本与已装版本', async () => {
    installerFake.listAvailableVersions.mockResolvedValueOnce([
      '0.1.5',
      '0.1.7-alpha.2',
      '0.1.6-alpha.2'
    ])
    installerFake.listInstalled.mockResolvedValueOnce([
      {
        version: '0.1.5-rc.1',
        dir: '/tmp/runtimes/dsh-0.1.5-rc.1',
        entry: '/tmp/e1',
        installedAt: ''
      },
      {
        version: '0.1.6-alpha.2',
        dir: '/tmp/runtimes/dsh-0.1.6-alpha.2',
        entry: '/tmp/e2',
        installedAt: ''
      }
    ])

    const result = (await invoke('dsh-version:list')) as {
      ok: boolean
      value?: { versions: string[]; installed: string[] }
    }

    expect(result).toEqual({
      ok: true,
      value: {
        versions: ['0.1.7-alpha.2', '0.1.6-alpha.2', '0.1.5'],
        installed: ['0.1.6-alpha.2', '0.1.5-rc.1']
      }
    })
  })

  it('dsh-version:list：registry 读取失败 → ok:false code=internal（透传原因）', async () => {
    installerFake.listAvailableVersions.mockRejectedValueOnce(new Error('registry 不可达'))

    const result = (await invoke('dsh-version:list')) as {
      ok: boolean
      code?: string
      message?: string
    }

    expect(result).toMatchObject({
      ok: false,
      code: 'internal',
      message: expect.stringContaining('registry 不可达')
    })
  })

  it('upgrade：可升级 → 触发 runtime.upgradeInstance 并立即返回 null', async () => {
    const created = (await invoke('instances:create', {
      ...VALID_LOCAL,
      dshVersion: '0.1.4'
    })) as { ok: boolean; value: { id: string } }
    if (!created.ok) throw new Error('创建失败')
    currentStatus = {
      id: created.value.id,
      status: 'stopped',
      runtimeSource: 'hub',
      at: new Date().toISOString()
    }

    const result = (await invoke('dsh-version:upgrade', created.value.id)) as {
      ok: boolean
      value: null
    }

    expect(result).toEqual({ ok: true, value: null })
    expect(runtimeFake.upgradeInstance).toHaveBeenCalledTimes(1)
    expect(runtimeFake.upgradeInstance).toHaveBeenCalledWith(
      expect.objectContaining({ id: created.value.id, transport: 'local' })
    )
  })

  it('upgrade：本地实例（默认/dush/duush 启动器 × 公共/隔离空间、path 来源）都转交升级编排', async () => {
    for (const launcher of [null, 'dush', 'duush'] as const) {
      for (const useDefaultSpace of [false, true]) {
        const created = (await invoke('instances:create', {
          ...VALID_LOCAL,
          ...(launcher === null ? {} : { launcher }),
          useDefaultSpace
        })) as { ok: boolean; value: { id: string } }
        if (!created.ok) throw new Error('创建失败')
        currentStatus = {
          id: created.value.id,
          status: 'running',
          runtimeSource: 'path',
          at: new Date().toISOString()
        }

        const result = (await invoke('dsh-version:upgrade', created.value.id)) as {
          ok: boolean
          value: null
        }

        expect(result).toEqual({ ok: true, value: null })
        expect(runtimeFake.upgradeInstance).toHaveBeenCalledWith(
          expect.objectContaining({ id: created.value.id, launcher, useDefaultSpace })
        )
      }
    }
    expect(runtimeFake.upgradeInstance).toHaveBeenCalledTimes(6)
  })

  it('dsh-version:confirmList/confirmReply：待答快照补拉与回答经 broker，入参走 zod 边界', async () => {
    const payload = {
      requestId: randomUUID(),
      kind: 'dsh-download' as const,
      version: '0.1.7-rc.1'
    }
    promptBrokerFake.listConfirms.mockReturnValue([payload])

    const list = (await invoke('dsh-version:confirmList')) as { ok: boolean; value: unknown }
    expect(list).toEqual({ ok: true, value: [payload] })

    const reply = (await invoke('dsh-version:confirmReply', payload.requestId, true)) as {
      ok: boolean
      value: null
    }
    expect(reply).toEqual({ ok: true, value: null })
    expect(promptBrokerFake.replyConfirm).toHaveBeenCalledWith(payload.requestId, true)

    // 非法 requestId / 非布尔回答都在 IPC 边界被拒，不触碰 broker。
    const badId = (await invoke('dsh-version:confirmReply', 'not-a-uuid', true)) as {
      ok: boolean
      code?: string
    }
    expect(badId).toMatchObject({ ok: false, code: 'invalid-input' })
    const badAnswer = (await invoke('dsh-version:confirmReply', randomUUID(), 'yes')) as {
      ok: boolean
      code?: string
    }
    expect(badAnswer).toMatchObject({ ok: false, code: 'invalid-input' })
    expect(promptBrokerFake.replyConfirm).toHaveBeenCalledTimes(1)
  })

  it('upgrade：不可升级来源 → ok:false invalid-input，不触发编排', async () => {
    const local = (await invoke('instances:create', VALID_LOCAL)) as {
      ok: boolean
      value: { id: string }
    }
    if (!local.ok) throw new Error('创建失败')
    currentStatus = {
      id: local.value.id,
      status: 'running',
      runtimeSource: 'external',
      at: new Date().toISOString()
    }
    const adopted = (await invoke('dsh-version:upgrade', local.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(adopted).toMatchObject({ ok: false, code: 'invalid-input' })

    const remote = (await invoke('instances:create', {
      transport: 'http',
      name: '远程实例',
      authMode: 'auto',
      endpointUrl: 'http://127.0.0.1:1/dsh'
    })) as { ok: boolean; value: { id: string } }
    if (!remote.ok) throw new Error('创建失败')
    const notLocal = (await invoke('dsh-version:upgrade', remote.value.id)) as {
      ok: boolean
      code?: string
    }
    expect(notLocal).toMatchObject({ ok: false, code: 'invalid-input' })

    expect(runtimeFake.upgradeInstance).not.toHaveBeenCalled()
  })

  it('upgrade：实例不存在报 not-found', async () => {
    const result = (await invoke(
      'dsh-version:upgrade',
      '00000000-0000-4000-8000-000000000000'
    )) as {
      ok: boolean
      code?: string
    }
    expect(result).toMatchObject({ ok: false, code: 'not-found' })
    expect(runtimeFake.upgradeInstance).not.toHaveBeenCalled()
  })
})
