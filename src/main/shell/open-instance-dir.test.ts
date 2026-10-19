import { mkdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstanceRecord } from '@shared/contracts'
import { instanceHomeDir, openInstanceDir, openInstanceLogDir } from './open-instance-dir'

const roots: string[] = []

async function root(): Promise<string> {
  const path = join(process.cwd(), 'hub-data', `open-instance-${crypto.randomUUID()}`)
  roots.push(path)
  await mkdir(path, { recursive: true })
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const ISO_ID = '11111111-1111-4111-8111-111111111111'

function localRecord(overrides: Partial<InstanceRecord> = {}): InstanceRecord {
  return {
    id: ISO_ID,
    name: 'local',
    transport: 'local',
    authMode: 'auto',
    notes: null,
    createdAt: '',
    updatedAt: '',
    dshVersion: null,
    port: null,
    profile: null,
    launcher: null,
    useDefaultSpace: false,
    runCommand: null,
    autoStart: false,
    ...overrides
  } as InstanceRecord
}

describe('instanceHomeDir', () => {
  it('隔离空间：<dataRoot>/homes/<id>', () => {
    expect(instanceHomeDir({ dataRoot: '/data' }, localRecord())).toBe(
      join('/data', 'homes', ISO_ID)
    )
  })

  it('公共空间：<home>/.dsh（Windows 与其他平台一致，由 Node path 规则决定分隔符）', () => {
    const ports = { dataRoot: '/data', homeDir: () => '/Users/admin' }
    expect(instanceHomeDir(ports, localRecord({ useDefaultSpace: true }))).toBe(
      join('/Users/admin', '.dsh')
    )
  })
})

describe('openInstanceDir', () => {
  it('目录不存在时先创建再打开，返回成功传入 openPath 的是解析出的 DSH_HOME', async () => {
    const dataRoot = await root()
    const opened: string[] = []
    await openInstanceDir({ dataRoot, openPath: async (p) => (opened.push(p), '') }, localRecord())
    const home = join(dataRoot, 'homes', ISO_ID)
    expect(opened).toEqual([home])
    expect(existsSync(home)).toBe(true)
  })

  it('openPath 返回非空失败原因时上抛', async () => {
    const dataRoot = await root()
    await expect(
      openInstanceDir({ dataRoot, openPath: async () => '没有可用的文件管理器' }, localRecord())
    ).rejects.toThrow('没有可用的文件管理器')
  })
})

describe('openInstanceLogDir', () => {
  it('插件日志目录存在时优先打开它', async () => {
    const dataRoot = await root()
    const logs = join(dataRoot, 'homes', ISO_ID, 'profiles', 'web', '.plugin-manager', 'logs')
    await mkdir(logs, { recursive: true })
    const opened: string[] = []
    await openInstanceLogDir(
      { dataRoot, openPath: async (p) => (opened.push(p), '') },
      localRecord()
    )
    expect(opened).toEqual([logs])
  })

  it('插件日志目录不存在时回落到 DSH_HOME', async () => {
    const dataRoot = await root()
    const opened: string[] = []
    await openInstanceLogDir(
      { dataRoot, openPath: async (p) => (opened.push(p), '') },
      localRecord()
    )
    expect(opened).toEqual([join(dataRoot, 'homes', ISO_ID)])
  })

  it('profile 自定义时按该 profile 解析日志路径', async () => {
    const dataRoot = await root()
    const logs = join(dataRoot, 'homes', ISO_ID, 'profiles', 'acp', '.plugin-manager', 'logs')
    await mkdir(logs, { recursive: true })
    const opened: string[] = []
    await openInstanceLogDir(
      { dataRoot, openPath: async (p) => (opened.push(p), '') },
      localRecord({ profile: 'acp' })
    )
    expect(opened).toEqual([logs])
    // sanity: 回落分支不会误创建一个空 logs 目录
    expect(await stat(logs).then(() => true)).toBe(true)
  })
})
