import { describe, expect, it, vi } from 'vitest'
import type { CommandResult, CommandRunner } from './runtime-installer'
import { createLoginPathResolver, mergeLoginPath, resolveLoginPath } from './login-path'

function runReturning(result: CommandResult | (() => Promise<CommandResult>)): CommandRunner {
  return vi.fn(typeof result === 'function' ? result : async () => result)
}

describe('resolveLoginPath（macOS/Linux：登录 shell 导出）', () => {
  it('按标记行提取 PATH，rc 噪声不影响', async () => {
    const run = runReturning({
      code: 0,
      stdout: 'rc noise without newline__DSH_LOGIN_PATH__=/custom/bin:/usr/bin\n',
      stderr: ''
    })
    const got = await resolveLoginPath({ run, platform: 'darwin', shell: '/bin/zsh' })
    expect(got).toBe('/custom/bin:/usr/bin')
    expect(run).toHaveBeenCalledWith('/bin/zsh', [
      '-lc',
      expect.stringContaining('__DSH_LOGIN_PATH__')
    ])
  })

  it('缺省 shell 取 env.SHELL', async () => {
    const run = runReturning({ code: 0, stdout: '__DSH_LOGIN_PATH__=/a\n', stderr: '' })
    await resolveLoginPath({ run, platform: 'linux', env: { SHELL: '/usr/bin/fish' } })
    expect(run).toHaveBeenCalledWith('/usr/bin/fish', expect.anything())
  })

  it('shell 退出非 0 / 输出无标记 → null', async () => {
    const failed = runReturning({ code: 1, stdout: '', stderr: 'boom' })
    expect(await resolveLoginPath({ run: failed, platform: 'darwin' })).toBeNull()
    const noMarker = runReturning({ code: 0, stdout: 'just noise\n', stderr: '' })
    expect(await resolveLoginPath({ run: noMarker, platform: 'darwin' })).toBeNull()
    const empty = runReturning({ code: 0, stdout: '__DSH_LOGIN_PATH__=\n', stderr: '' })
    expect(await resolveLoginPath({ run: empty, platform: 'darwin' })).toBeNull()
  })

  it('shell 不存在（执行器 reject）→ null，不抛异常', async () => {
    const run = runReturning(() => Promise.reject(new Error('ENOENT')))
    expect(await resolveLoginPath({ run, platform: 'darwin' })).toBeNull()
  })
})

describe('resolveLoginPath（Windows：注册表 User + Machine）', () => {
  it('Machine 段在前、User 段在后，按分号拼接', async () => {
    const run = runReturning({
      code: 0,
      stdout: 'C:\\Windows\\system32\n__DSH_LOGIN_PATH_SPLIT__\nC:\\Users\\me\\bin\n',
      stderr: ''
    })
    const got = await resolveLoginPath({ run, platform: 'win32', env: {} })
    expect(got).toBe('C:\\Windows\\system32;C:\\Users\\me\\bin')
    expect(run).toHaveBeenCalledWith('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      expect.stringContaining('GetEnvironmentVariable')
    ])
  })

  it('单侧缺失只取非空一侧', async () => {
    const run = runReturning({
      code: 0,
      stdout: '\n__DSH_LOGIN_PATH_SPLIT__\nC:\\Users\\me\\bin\n',
      stderr: ''
    })
    expect(await resolveLoginPath({ run, platform: 'win32', env: {} })).toBe('C:\\Users\\me\\bin')
  })

  it('%VAR% 按环境展开，未知变量原样保留', async () => {
    const run = runReturning({
      code: 0,
      stdout: '%SystemRoot%\\system32\n__DSH_LOGIN_PATH_SPLIT__\n%USERPROFILE%\\bin;%UNKNOWN%\\x\n',
      stderr: ''
    })
    const got = await resolveLoginPath({
      run,
      platform: 'win32',
      env: { systemroot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' }
    })
    // 变量名大小写不敏感查找（systemroot 命中 SystemRoot）
    expect(got).toBe('C:\\Windows\\system32;C:\\Users\\me\\bin;%UNKNOWN%\\x')
  })

  it('执行失败 / 输出无分隔标记 → null', async () => {
    const failed = runReturning({ code: 1, stdout: '', stderr: 'ps broken' })
    expect(await resolveLoginPath({ run: failed, platform: 'win32', env: {} })).toBeNull()
    const noMarker = runReturning({ code: 0, stdout: 'garbage\n', stderr: '' })
    expect(await resolveLoginPath({ run: noMarker, platform: 'win32', env: {} })).toBeNull()
  })
})

describe('mergeLoginPath', () => {
  it('登录目录前置、去重保序，继承 PATH 的独有目录随后', () => {
    expect(mergeLoginPath('/usr/bin:/bin', '/custom/bin:/usr/bin', 'darwin')).toBe(
      '/custom/bin:/usr/bin:/bin'
    )
  })

  it('win32 大小写不敏感、分隔符形态归一后去重（保留登录侧写法）', () => {
    expect(mergeLoginPath('C:\\Windows\\system32', 'c:/windows/SYSTEM32;D:\\tools', 'win32')).toBe(
      'c:/windows/SYSTEM32;D:\\tools'
    )
  })

  it('login 为 null 或空 → base 原样返回', () => {
    expect(mergeLoginPath('/usr/bin:', null, 'darwin')).toBe('/usr/bin:')
    expect(mergeLoginPath('/usr/bin', '  ', 'darwin')).toBe('/usr/bin')
  })
})

describe('createLoginPathResolver（进程内缓存）', () => {
  it('并发与后续调用只解析一次', async () => {
    const probe = vi.fn(async () => '/login/bin')
    const resolve = createLoginPathResolver(probe)
    const [a, b] = await Promise.all([resolve(), resolve()])
    const c = await resolve()
    expect([a, b, c]).toEqual(['/login/bin', '/login/bin', '/login/bin'])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('解析失败同样缓存为 null，不再重试', async () => {
    const probe = vi.fn(async () => null)
    const resolve = createLoginPathResolver(probe)
    expect(await resolve()).toBeNull()
    expect(await resolve()).toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('invalidate 后下次调用重新解析（装了新工具无需重启 app 即可生效）', async () => {
    let value = '/old/bin'
    const probe = vi.fn(async () => value)
    const resolve = createLoginPathResolver(probe)
    expect(await resolve()).toBe('/old/bin')
    expect(await resolve()).toBe('/old/bin')
    expect(probe).toHaveBeenCalledTimes(1)

    value = '/old/bin:/new/git/bin'
    resolve.invalidate()
    expect(await resolve()).toBe('/old/bin:/new/git/bin')
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
