import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
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
import {
  TEST_BASE,
  setupRegister,
  teardownRegister,
  type RegisterHarness,
  type RuntimeFake
} from './register.testkit'

type MockFn = ReturnType<typeof vi.fn>

let harness: RegisterHarness
let invoke: RegisterHarness['invoke']
let runtimeFake: RuntimeFake
let vaultFake: Record<string, MockFn>
let listLocalSpaces: MockFn
let trashLocalSpace: MockFn
let currentStatus: InstanceStatusEvent | null

beforeEach(async () => {
  currentStatus = null
  harness = await setupRegister(() => currentStatus)
  ;({ invoke, runtimeFake, vaultFake, listLocalSpaces, trashLocalSpace } = harness)
})

afterEach(async () => {
  await teardownRegister(harness)
})

const VALID_LOCAL = { transport: 'local', name: 'IPC 实例' }

describe('registerIpc：实例 CRUD 与空间', () => {
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
})
