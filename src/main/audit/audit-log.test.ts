import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUDIT_LOG_NAME, createAuditLog, projectAuditRecord } from './audit-log'
import type { AuditEntry } from './audit-log'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hub-audit-'))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const readLines = async (path: string): Promise<Array<Record<string, unknown>>> => {
  const content = await readFile(path, 'utf8')
  return content
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('audit-log（ JSONL 审计）', () => {
  it('写入 JSONL:每行一条记录,字段白名单(ts/instanceId/event/result)', async () => {
    const clock = Date.parse('2026-09-15T10:00:00.000Z')
    const log = createAuditLog({ dir, now: () => clock })
    await log.write({ instanceId: 'inst-1', event: 'login-success' })
    await log.write({ instanceId: 'inst-1', event: 'login-failed', result: 'invalid-credentials' })

    const lines = await readLines(join(dir, AUDIT_LOG_NAME))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toEqual({
      ts: '2026-09-15T10:00:00.000Z',
      instanceId: 'inst-1',
      event: 'login-success',
      result: 'ok'
    })
    expect(lines[1]?.['result']).toBe('invalid-credentials')
    expect(log.count()).toBe(2)
  })

  it('审计不含凭据:调用方多传的字段被白名单投影丢弃', async () => {
    const log = createAuditLog({ dir, now: () => Date.now() })
    // 模拟调用方误传(password/otp/cookie 都不在白名单里)
    const leaky = {
      instanceId: 'inst-1',
      event: 'login-failed',
      result: 'invalid-credentials',
      password: 'hunter2',
      otp: '123456',
      cookie: 'dsh_auth=secret'
    } as unknown as AuditEntry
    await log.write(leaky)

    const raw = await readFile(join(dir, AUDIT_LOG_NAME), 'utf8')
    for (const secret of ['hunter2', '123456', 'dsh_auth=secret', 'password', 'otp', 'cookie']) {
      expect(raw).not.toContain(secret)
    }
    const lines = await readLines(join(dir, AUDIT_LOG_NAME))
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(['event', 'instanceId', 'result', 'ts'])
  })

  it('result 超长被截断(不会把长文本写进日志)', () => {
    const record = projectAuditRecord(
      { event: 'login-failed', result: 'x'.repeat(500) },
      '2026-09-15T00:00:00.000Z'
    )
    expect(record.result).toHaveLength(64)
  })

  it('instanceId 可空(全局事件)', async () => {
    const log = createAuditLog({ dir, now: () => Date.parse('2026-09-15T00:00:00.000Z') })
    await log.write({ event: 'vault-unavailable', result: 'degraded' })
    const lines = await readLines(join(dir, AUDIT_LOG_NAME))
    expect(lines[0]?.['instanceId']).toBeNull()
  })

  it('按本地日历日轮转:跨天后活动文件归档为 audit.log.<前一天>', async () => {
    let clock = new Date(2026, 8, 15, 23, 0, 0).getTime() // 本地 2026-09-15 23:00
    const log = createAuditLog({ dir, now: () => clock })
    await log.write({ event: 'connect' })
    expect(await readLines(join(dir, AUDIT_LOG_NAME))).toHaveLength(1)

    clock = new Date(2026, 8, 16, 1, 0, 0).getTime() // 跨到 09-16
    await log.write({ event: 'disconnect' })

    const names = (await readdir(dir)).sort()
    expect(names).toEqual([`${AUDIT_LOG_NAME}.2026-09-15`, AUDIT_LOG_NAME].sort())
    // 归档里是 09-15 那条,活动文件是 09-16 那条
    expect(await readLines(join(dir, `${AUDIT_LOG_NAME}.2026-09-15`))).toHaveLength(1)
    const live = await readLines(join(dir, AUDIT_LOG_NAME))
    expect(live).toHaveLength(1)
    expect(live[0]?.['event']).toBe('disconnect')
  })

  it('同一天内不轮转(连续写入同一文件)', async () => {
    const clock = new Date(2026, 8, 15, 8, 0, 0).getTime()
    const log = createAuditLog({ dir, now: () => clock })
    await log.write({ event: 'connect' })
    await log.write({ event: 'disconnect' })
    expect((await readdir(dir)).sort()).toEqual([AUDIT_LOG_NAME])
    expect(await readLines(join(dir, AUDIT_LOG_NAME))).toHaveLength(2)
  })

  it('prune 删除超过保留期的归档,保留期内与不匹配文件不动', async () => {
    const clock = new Date(2026, 8, 15, 12, 0, 0).getTime()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${AUDIT_LOG_NAME}.2026-06-01`), '{}\n') // 106 天前 → 删
    await writeFile(join(dir, `${AUDIT_LOG_NAME}.2026-06-17`), '{}\n') // 恰好 90 个日历日 → 留(边界)
    await writeFile(join(dir, `${AUDIT_LOG_NAME}.2026-09-14`), '{}\n') // 昨天 → 留
    await writeFile(join(dir, 'notes.txt'), 'keep me')
    await writeFile(join(dir, 'audit.log.backup'), 'keep me too')

    const log = createAuditLog({ dir, now: () => clock })
    const removed = await log.prune()
    expect(removed).toEqual([`${AUDIT_LOG_NAME}.2026-06-01`])

    const names = (await readdir(dir)).sort()
    expect(names).toContain('notes.txt')
    expect(names).toContain('audit.log.backup')
    expect(names).toContain(`${AUDIT_LOG_NAME}.2026-06-17`)
    expect(names).not.toContain(`${AUDIT_LOG_NAME}.2026-06-01`)
  })

  it('prune 在目录不存在时不抛(等价于无归档)', async () => {
    const log = createAuditLog({ dir: join(dir, 'missing'), now: () => Date.now() })
    await expect(log.prune()).resolves.toEqual([])
  })

  it('写失败经 onError 上报且不抛(审计不可用不能中断认证流)', async () => {
    // 用一个「目录路径被文件占用」的方式制造 mkdir 失败
    const blocked = join(dir, 'blocked')
    await writeFile(blocked, 'not a directory')
    const errors: unknown[] = []
    const log = createAuditLog({
      dir: join(blocked, 'audit'),
      now: () => Date.now(),
      onError: (error) => errors.push(error)
    })
    await expect(log.write({ event: 'login-success' })).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })

  it('并发写入不丢记录且保持串行(轮转不被并发写入踩坏)', async () => {
    const clock = new Date(2026, 8, 15, 12, 0, 0).getTime()
    const log = createAuditLog({ dir, now: () => clock })
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        log.write({ instanceId: `i${index}`, event: 'connect' })
      )
    )
    const lines = await readLines(join(dir, AUDIT_LOG_NAME))
    expect(lines).toHaveLength(25)
    expect(new Set(lines.map((line) => line['instanceId'])).size).toBe(25)
  })
})
