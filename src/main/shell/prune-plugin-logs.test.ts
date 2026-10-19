import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { InstanceRecord } from '@shared/contracts'
import {
  PLUGIN_LOG_MAX_AGE_DAYS,
  consolidatePluginLogsForInstances,
  consolidatePluginOperationLogs,
  managedDshHomes
} from './prune-plugin-logs'

const roots: string[] = []

async function root(): Promise<string> {
  const path = join(process.cwd(), 'hub-data', `prune-plugin-logs-${crypto.randomUUID()}`)
  roots.push(path)
  await mkdir(path, { recursive: true })
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const now = (): number => NOW

/** 与模块一致的本地日历日（避开时区脆弱）。 */
function localDay(ms: number): string {
  const date = new Date(ms)
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function logsRoot(home: string, profile = 'web'): string {
  return join(home, 'profiles', profile, '.plugin-manager', 'logs')
}

/** 建一个 operation-* 目录，写入 pnpm.log 内容，并把目录 mtime 设成 ageMs 毫秒前。 */
async function makeOperation(
  home: string,
  name: string,
  ageMs: number,
  content = '',
  profile = 'web'
): Promise<string> {
  const dir = join(logsRoot(home, profile), name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'pnpm.log'), content)
  const when = new Date(NOW - ageMs)
  await utimes(dir, when, when)
  return dir
}

describe('consolidatePluginOperationLogs', () => {
  it('非空日志归并进按天文件（按 mtime 日）、原目录删除', async () => {
    const home = await root()
    const dir = await makeOperation(home, 'operation-a', 1 * DAY_MS, 'pnpm ERR! boom')

    const summary = await consolidatePluginOperationLogs(home, { now })

    expect(summary.merged).toEqual([dir])
    expect(summary.removed).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
    const dayFile = join(logsRoot(home), `plugin-operations.${localDay(NOW - DAY_MS)}.log`)
    const text = await readFile(dayFile, 'utf8')
    expect(text).toContain('operation-a')
    expect(text).toContain('pnpm ERR! boom')
  })

  it('空日志不写合并文件，目录直接删除', async () => {
    const home = await root()
    const dir = await makeOperation(home, 'operation-empty', 1 * DAY_MS, '')

    const summary = await consolidatePluginOperationLogs(home, { now })

    expect(summary.merged).toEqual([])
    expect(summary.removed).toEqual([dir])
    expect(existsSync(dir)).toBe(false)
    // 没有任何按天合并文件被创建
    expect(await readdir(logsRoot(home))).toEqual([])
  })

  it('沉降窗口内（太新）的目录跳过，不碰', async () => {
    const home = await root()
    const recent = await makeOperation(home, 'operation-recent', 60 * 1000, 'oops')

    const summary = await consolidatePluginOperationLogs(home, { now })

    expect(summary.merged).toEqual([])
    expect(summary.removed).toEqual([])
    expect(existsSync(recent)).toBe(true)
  })

  it('超保留期的目录直接删除，不归并（不产生按天文件）', async () => {
    const home = await root()
    const old = await makeOperation(
      home,
      'operation-old',
      (PLUGIN_LOG_MAX_AGE_DAYS + 1) * DAY_MS,
      'ancient error'
    )

    const summary = await consolidatePluginOperationLogs(home, { now })

    expect(summary.merged).toEqual([])
    expect(summary.removed).toEqual([old])
    expect(existsSync(old)).toBe(false)
    expect(await readdir(logsRoot(home))).toEqual([])
  })

  it('按天合并文件按保留期清理：旧的删、近的留', async () => {
    const home = await root()
    await mkdir(logsRoot(home), { recursive: true })
    const stale = join(
      logsRoot(home),
      `plugin-operations.${localDay(NOW - (PLUGIN_LOG_MAX_AGE_DAYS + 1) * DAY_MS)}.log`
    )
    const fresh = join(logsRoot(home), `plugin-operations.${localDay(NOW - 1 * DAY_MS)}.log`)
    await writeFile(stale, 'old')
    await writeFile(fresh, 'recent')

    const summary = await consolidatePluginOperationLogs(home, { now })

    expect(summary.prunedDayFiles).toEqual([stale])
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('不触碰非 operation- 目录与非合并文件命名', async () => {
    const home = await root()
    await mkdir(join(logsRoot(home), 'keep-dir'), { recursive: true })
    await writeFile(join(logsRoot(home), 'notes.txt'), 'x')
    await writeFile(join(logsRoot(home), 'operation-note.txt'), 'y')

    const summary = await consolidatePluginOperationLogs(home, { now })

    expect(summary).toEqual({ merged: [], removed: [], prunedDayFiles: [] })
    expect(existsSync(join(logsRoot(home), 'keep-dir'))).toBe(true)
    expect(existsSync(join(logsRoot(home), 'notes.txt'))).toBe(true)
    expect(existsSync(join(logsRoot(home), 'operation-note.txt'))).toBe(true)
  })

  it('profiles / logs 目录不存在时静默返回空摘要', async () => {
    const home = await root()
    await expect(consolidatePluginOperationLogs(home, { now })).resolves.toEqual({
      merged: [],
      removed: [],
      prunedDayFiles: []
    })
    expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('跨 profile 归并', async () => {
    const home = await root()
    const web = await makeOperation(home, 'operation-w', 1 * DAY_MS, 'web err', 'web')
    const acp = await makeOperation(home, 'operation-c', 1 * DAY_MS, 'acp err', 'acp')

    const summary = await consolidatePluginOperationLogs(home, { now })

    expect(summary.merged.sort()).toEqual([web, acp].sort())
    expect(existsSync(web)).toBe(false)
    expect(existsSync(acp)).toBe(false)
  })
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

describe('managedDshHomes', () => {
  it('隔离空间 → <dataRoot>/homes/<id>，公共空间 → <home>/.dsh，并去重', () => {
    const homes = managedDshHomes(
      '/data',
      [
        localRecord({ id: 'iso-1' }),
        localRecord({ id: 'default-a', useDefaultSpace: true }),
        localRecord({ id: 'default-b', useDefaultSpace: true }),
        { transport: 'http' } as InstanceRecord
      ],
      '/Users/admin'
    )
    expect(homes).toEqual([join('/data', 'homes', 'iso-1'), join('/Users/admin', '.dsh')])
  })
})

describe('consolidatePluginLogsForInstances', () => {
  it('归并所有本机实例 DSH_HOME 下的目录（隔离 + 公共空间）', async () => {
    const dataRoot = await root()
    const home = await root()
    const isoHome = join(dataRoot, 'homes', 'iso-1')
    const iso = await makeOperation(isoHome, 'operation-iso', 1 * DAY_MS, 'iso err')
    const def = await makeOperation(join(home, '.dsh'), 'operation-def', 1 * DAY_MS, 'def err')
    const recent = await makeOperation(join(home, '.dsh'), 'operation-recent', 60 * 1000, 'skip')

    const summary = await consolidatePluginLogsForInstances({
      dataRoot,
      home,
      records: [localRecord({ id: 'iso-1' }), localRecord({ id: 'd', useDefaultSpace: true })],
      options: { now }
    })

    expect(summary.removed.sort()).toEqual([iso, def].sort())
    expect(existsSync(iso)).toBe(false)
    expect(existsSync(def)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  it('单条失败经 onError 上报后继续处理其余条目', async () => {
    const dataRoot = await root()
    const home = await root()
    const dir = await makeOperation(join(home, '.dsh'), 'operation-x', 1 * DAY_MS, 'err')
    await stat(dir)
    const errors: unknown[] = []

    const summary = await consolidatePluginLogsForInstances({
      dataRoot,
      home,
      records: [localRecord({ useDefaultSpace: true })],
      options: { now, onError: (error) => errors.push(error) }
    })

    expect(summary.removed).toEqual([dir])
    expect(errors).toEqual([])
  })
})
