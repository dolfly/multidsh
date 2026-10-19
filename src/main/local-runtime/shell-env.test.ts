import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandRunner } from './exec-file'
import { PROTECTED_KEYS, createShellEnvResolver, mergeShellEnv, resolveShellEnv } from './shell-env'

function runReturning(result: CommandResult | (() => Promise<CommandResult>)): CommandRunner {
  return vi.fn(typeof result === 'function' ? result : async () => result)
}

/** 拼 `env -0` 风格输出：KEY=VALUE\0KEY=VALUE\0... */
function nullDelimited(pairs: Array<[string, string]>): string {
  return pairs.map(([k, v]) => `${k}=${v}`).join('\0') + '\0'
}

describe('resolveShellEnv（登录 shell 全量环境解析）', () => {
  it('zsh：用 -l -i -c env -0 解析出完整环境', async () => {
    const run = runReturning({
      code: 0,
      stdout: nullDelimited([
        ['PATH', '/custom/bin:/usr/bin'],
        ['HTTP_PROXY', 'http://127.0.0.1:7890'],
        ['FOO', 'bar']
      ]),
      stderr: ''
    })
    const env = await resolveShellEnv({ run, platform: 'darwin', shell: '/bin/zsh' })
    expect(env?.get('HTTP_PROXY')).toBe('http://127.0.0.1:7890')
    expect(env?.get('FOO')).toBe('bar')
    expect(run).toHaveBeenCalledWith('/bin/zsh', ['-l', '-i', '-c', 'env -0'])
  })

  it('值里含 = 与换行：\\0 分隔不被截断', async () => {
    const run = runReturning({
      code: 0,
      stdout: nullDelimited([
        ['A', 'key=with=equals'],
        ['B', 'line1\nline2']
      ]),
      stderr: ''
    })
    const env = await resolveShellEnv({ run, platform: 'linux', shell: '/bin/bash' })
    expect(env?.get('A')).toBe('key=with=equals')
    expect(env?.get('B')).toBe('line1\nline2')
  })

  it('非 zsh/bash（fish）→ null，不执行任何命令', async () => {
    const run = runReturning({ code: 0, stdout: '', stderr: '' })
    expect(await resolveShellEnv({ run, platform: 'darwin', shell: '/usr/bin/fish' })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('win32 → null，不执行任何命令', async () => {
    const run = runReturning({ code: 0, stdout: '', stderr: '' })
    expect(await resolveShellEnv({ run, platform: 'win32', shell: '/bin/zsh' })).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })

  it('非 0 退出 / 空输出 → null', async () => {
    const failed = runReturning({ code: 1, stdout: '', stderr: 'boom' })
    expect(await resolveShellEnv({ run: failed, platform: 'darwin', shell: '/bin/zsh' })).toBeNull()
    const empty = runReturning({ code: 0, stdout: '', stderr: '' })
    expect(await resolveShellEnv({ run: empty, platform: 'darwin', shell: '/bin/zsh' })).toBeNull()
  })

  it('执行器 reject（超时/ENOENT）→ null，不抛异常', async () => {
    const run = runReturning(() => Promise.reject(new Error('timeout')))
    expect(await resolveShellEnv({ run, platform: 'darwin', shell: '/bin/zsh' })).toBeNull()
  })
})

describe('mergeShellEnv（合并登录 shell 环境）', () => {
  const base: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', EXISTING: 'base' }

  it('shell 值覆盖或新增，PATH 走 mergeLoginPath 前置去重', () => {
    const shellEnv = new Map<string, string>([
      ['PATH', '/custom/bin:/usr/bin'],
      ['EXISTING', 'shell'],
      ['NEW', 'value']
    ])
    const merged = mergeShellEnv(base, shellEnv, 'darwin')
    expect(merged.NEW).toBe('value')
    expect(merged.EXISTING).toBe('shell')
    // 登录目录前置、与 base 去重保序
    expect(merged.PATH).toBe('/custom/bin:/usr/bin:/bin')
  })

  it('受保护键不被 shell 环境覆盖', () => {
    const withProtected = { ...base, DSH_HOME: '/hub/home' }
    const shellEnv = new Map<string, string>(
      [...PROTECTED_KEYS].map((k) => [k, 'from-shell'] as [string, string])
    )
    const merged = mergeShellEnv(withProtected, shellEnv, 'darwin')
    expect(merged.DSH_HOME).toBe('/hub/home')
    for (const key of PROTECTED_KEYS) {
      expect(merged[key]).not.toBe('from-shell')
    }
  })

  it('shellEnv 为 null → 原样返回 base 副本', () => {
    const merged = mergeShellEnv(base, null, 'darwin')
    expect(merged).toEqual(base)
    expect(merged).not.toBe(base)
  })
})

describe('createShellEnvResolver（进程内缓存）', () => {
  it('多次调用只解析一次', async () => {
    const probe = vi.fn(async () => new Map([['A', '1']]))
    const resolve = createShellEnvResolver(probe)
    await resolve()
    await resolve()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('解析 reject 缓存为 null，不再重试', async () => {
    const probe = vi.fn(() => Promise.reject(new Error('boom')))
    const resolve = createShellEnvResolver(probe)
    expect(await resolve()).toBeNull()
    expect(await resolve()).toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('invalidate 后下次调用重新解析', async () => {
    const probe = vi.fn(async () => new Map([['A', '1']]))
    const resolve = createShellEnvResolver(probe)
    await resolve()
    await resolve()
    expect(probe).toHaveBeenCalledTimes(1)
    resolve.invalidate()
    await resolve()
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
