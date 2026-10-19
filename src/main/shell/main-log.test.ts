import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installMainLogging, MAIN_LOG_NAME, type MainLog } from './main-log'

/** 本地正午的时间戳：无论测试机时区，localDay 都稳定落在当天 */
function localNoon(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0).getTime()
}

describe('installMainLogging 主进程日志落盘', () => {
  let dir: string
  let current: MainLog | null = null
  let nowValue: number

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'main-log-'))
    nowValue = localNoon(2026, 9, 22)
    current = null
  })

  afterEach(async () => {
    current?.dispose()
    current = null
    await rm(dir, { recursive: true, force: true })
  })

  function install(opts?: { onError?: (error: unknown) => void; maxAgeDays?: number }): MainLog {
    const handle = installMainLogging({ dir, now: () => nowValue, ...opts })
    current = handle
    return handle
  }

  it('console.error/warn/log 按级别落盘，行首为 ISO 时间戳', async () => {
    const handle = install()
    console.error('boom %s', 'x')
    console.warn('warn line')
    console.log('info line')
    await handle.flush()

    const content = await readFile(join(dir, MAIN_LOG_NAME), 'utf8')
    const lines = content.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ERROR boom x$/)
    expect(lines[1]).toContain('WARN warn line')
    expect(lines[2]).toContain('INFO info line')
  })

  it('凭据形态不落盘：URL token、password、Authorization、PEM', async () => {
    const handle = install()
    console.error('ready http://127.0.0.1:52300/?token=sec123')
    console.error('login failed password=s3cr3t')
    console.error('Authorization: Bearer xyz.abc')
    console.error('-----BEGIN PRIVATE KEY-----\nMIIEvg\n-----END PRIVATE KEY-----')
    await handle.flush()

    const content = await readFile(join(dir, MAIN_LOG_NAME), 'utf8')
    expect(content).not.toContain('sec123')
    expect(content).not.toContain('s3cr3t')
    expect(content).not.toContain('xyz.abc')
    expect(content).not.toContain('MIIEvg')
    expect(content).toContain('http://127.0.0.1:52300/')
    expect(content).toContain('password=***')
    expect(content).toContain('[REDACTED]')
  })

  it('按本地日轮转：跨天后活动文件归档为 main.log.<昨日>', async () => {
    const handle = install()
    console.error('day-one line')
    await handle.flush()

    nowValue = localNoon(2026, 9, 23)
    console.error('day-two line')
    await handle.flush()

    const names = await readdir(dir)
    expect(names).toContain('main.log.2026-09-22')
    expect(await readFile(join(dir, 'main.log.2026-09-22'), 'utf8')).toContain('day-one line')
    expect(await readFile(join(dir, MAIN_LOG_NAME), 'utf8')).toContain('day-two line')
  })

  it('重启恢复：活动文件残留昨日行时先归档再写当日', async () => {
    const stale = `${new Date(localNoon(2026, 9, 21)).toISOString()} INFO stale-line\n`
    await writeFile(join(dir, MAIN_LOG_NAME), stale, 'utf8')

    const handle = install()
    console.error('fresh line')
    await handle.flush()

    expect(await readFile(join(dir, 'main.log.2026-09-21'), 'utf8')).toContain('stale-line')
    const live = await readFile(join(dir, MAIN_LOG_NAME), 'utf8')
    expect(live).toContain('fresh line')
    expect(live).not.toContain('stale-line')
  })

  it('prune 只删过期归档，不碰其它文件', async () => {
    await writeFile(join(dir, 'main.log.2026-06-01'), 'x') // 超过保留期
    await writeFile(join(dir, 'main.log.2026-09-21'), 'x') // 保留期内
    await writeFile(join(dir, 'main.log.backup'), 'keep')
    await writeFile(join(dir, 'notes.txt'), 'keep')

    const handle = install({ maxAgeDays: 30 })
    const removed = await handle.prune()
    const names = await readdir(dir)

    expect(removed).toEqual(['main.log.2026-06-01'])
    expect(names).toEqual(
      expect.arrayContaining(['main.log.2026-09-21', 'main.log.backup', 'notes.txt'])
    )
  })

  it('写失败不冒泡：经 onError 上报，console 照常工作', async () => {
    const blocked = join(dir, 'blocked-file')
    await writeFile(blocked, 'x', 'utf8')
    const onError = vi.fn()

    const handle = installMainLogging({ dir: blocked, now: () => nowValue, onError })
    current = handle
    console.error('unimportant')
    await handle.flush()

    expect(onError).toHaveBeenCalled()
  })

  it('dispose 恢复原生 console；重复安装复用同一实例', () => {
    const originalError = console.error
    const first = install()
    const second = installMainLogging({ dir, now: () => nowValue })
    expect(second).toBe(first)
    expect(console.error).not.toBe(originalError)

    current?.dispose()
    current = null
    expect(console.error).toBe(originalError)
  })
})
