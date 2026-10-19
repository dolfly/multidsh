import { describe, expect, it, vi } from 'vitest'
import type { InstanceRecord, LocalInstance, SshInstance } from '@shared/contracts'
import { autoStartTargets, startAutoStartInstances } from './auto-start'

const ISO = '2026-01-01T00:00:00.000Z'

function local(overrides: Partial<LocalInstance> = {}): LocalInstance {
  return {
    id: 'local-1',
    name: '本机实例',
    transport: 'local',
    authMode: 'auto',
    notes: null,
    dshVersion: null,
    port: null,
    profile: null,
    launcher: null,
    useDefaultSpace: false,
    runCommand: null,
    autoStart: true,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  }
}

function ssh(overrides: Partial<SshInstance> = {}): SshInstance {
  return {
    id: 'ssh-1',
    name: '远端实例',
    transport: 'ssh',
    authMode: 'auto',
    notes: null,
    host: 'example.com',
    port: 22,
    username: 'me',
    remotePort: 3080,
    localPort: null,
    identityFile: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  }
}

describe('autoStartTargets(启动时自动拉起的选择)', () => {
  it('只挑出勾选 autoStart 的本机实例', () => {
    const records: InstanceRecord[] = [
      local({ id: 'on' }),
      local({ id: 'off', autoStart: false }),
      ssh()
    ]
    expect(autoStartTargets(records).map((item) => item.id)).toEqual(['on'])
  })

  it('空注册表 → 无目标', () => {
    expect(autoStartTargets([])).toEqual([])
  })
})

describe('startAutoStartInstances(启动时自动拉起的执行)', () => {
  it('每个目标各启动一次,非目标不启动,且不等待单个 start 完成', async () => {
    const started: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const deps = {
      list: async () =>
        [local({ id: 'a' }), local({ id: 'b', autoStart: false })] as InstanceRecord[],
      start: vi.fn(async (instance: LocalInstance) => {
        started.push(instance.id)
        await gate
      })
    }

    await startAutoStartInstances(deps)
    // start 未完成也不阻塞启动流程:调用已发生,目标全部入队
    expect(started).toEqual(['a'])
    expect(deps.start).toHaveBeenCalledTimes(1)
    release()
  })

  it('读注册表失败:上报错误且不启动任何实例', async () => {
    const onError = vi.fn()
    const start = vi.fn(async () => undefined)
    await startAutoStartInstances({
      list: async () => {
        throw new Error('io-error')
      },
      start,
      onError
    })
    expect(start).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('单个实例启动失败:上报错误但不阻断其余实例', async () => {
    const onError = vi.fn()
    const started: string[] = []
    await startAutoStartInstances({
      list: async () => [local({ id: 'bad' }), local({ id: 'good' })] as InstanceRecord[],
      start: async (instance) => {
        if (instance.id === 'bad') throw new Error('spawn failed')
        started.push(instance.id)
      },
      onError
    })
    expect(started).toEqual(['good'])
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
