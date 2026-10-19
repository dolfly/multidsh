import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { spawn } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { COMMAND_TIMEOUT_MS, npmFetchInfo, resolveNpmInvocation, spawnNpm } from './npm-invocation'

/**
 * npm 调用层的单元测试：输出解析、spawn 生命周期（超时/取消/信号终止）与
 * 各平台的 npm 入口解析。安装目录布局与版本语义在 runtime-installer.test.ts。
 */

describe('npmFetchInfo', () => {
  it('网络下载：包体按 .tgz 判定，元数据按包名', () => {
    expect(
      npmFetchInfo('npm http fetch GET 200 https://registry.npmjs.org/is-odd 772ms (cache miss)')
    ).toEqual({ path: 'is-odd', kind: 'packument' })
    expect(
      npmFetchInfo(
        'npm http fetch GET 200 https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz 12ms (cache miss)'
      )
    ).toEqual({ path: 'is-odd/-/is-odd-3.0.1.tgz', kind: 'tarball' })
  })

  it('缓存命中同样计入（否则重复安装会数不到已就绪的包）', () => {
    expect(
      npmFetchInfo(
        'npm http cache media-typer@https://registry.npmjs.org/media-typer/-/media-typer-1.1.1.tgz 0ms (cache hit)'
      )
    ).toEqual({ path: 'media-typer/-/media-typer-1.1.1.tgz', kind: 'tarball' })
    expect(
      npmFetchInfo('npm http cache https://registry.npmjs.org/express 9ms (cache hit)')
    ).toEqual({
      path: 'express',
      kind: 'packument'
    })
  })

  it('镜像 registry 的包体路径不含 /-/，仍按 .tgz 认作包体', () => {
    expect(
      npmFetchInfo(
        'npm http fetch GET 200 https://registry.npmmirror.com/packages/@deepseek-ai/dsh-client-ui-settings-account/0.2.0-rc.2/dsh-client-ui-settings-account-0.2.0-rc.2.tgz 30ms (cache miss)'
      )
    ).toEqual({
      path: 'packages/@deepseek-ai/dsh-client-ui-settings-account/0.2.0-rc.2/dsh-client-ui-settings-account-0.2.0-rc.2.tgz',
      kind: 'tarball'
    })
  })

  it('查询串被剥掉（仍按包体判定）', () => {
    expect(
      npmFetchInfo('npm http fetch GET 200 https://r.example.com/a/-/a-1.0.0.tgz?x=1 1ms')?.kind
    ).toBe('tarball')
  })

  it('非下载完成行返回 null', () => {
    expect(npmFetchInfo('npm http fetch GET https://registry.npmjs.org/x')).toBeNull()
    expect(npmFetchInfo('npm http fetch POST 200 https://registry.npmjs.org/-/user 5ms')).toBeNull()
    expect(npmFetchInfo('added 2 packages in 4s')).toBeNull()
    expect(npmFetchInfo('npm http cache 5ms (cache hit)')).toBeNull()
  })
})

describe('spawnNpm', () => {
  it('收集 stdout/stderr,stderr 逐行回调(跨 chunk 行缓冲)', async () => {
    const lines: string[] = []
    const script = [
      "process.stderr.write('npm http fetch GET 200 https://registry.npmmir')",
      'setTimeout(() => {',
      "  process.stderr.write('ror.com/x 1ms\\ndone-line\\n')",
      "  process.stdout.write('OUT')",
      '}, 20)'
    ].join(';')
    const result = await spawnNpm({ command: process.execPath, prefixArgs: ['-e', script] }, [], {
      env: process.env,
      onStderrLine: (line) => lines.push(line)
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('OUT')
    expect(result.stderr).toContain('done-line')
    expect(lines).toEqual([
      'npm http fetch GET 200 https://registry.npmmirror.com/x 1ms',
      'done-line'
    ])
  })

  it('启动失败时 reject(与 runCommand 语义一致)', async () => {
    await expect(
      spawnNpm({ command: 'dsh-hub-no-such-binary', prefixArgs: [] }, [], { env: process.env })
    ).rejects.toThrow()
  })

  it('超过统一 deadline 时 kill 并以超时 reject,不占死安装队列', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = spawnNpm(
        { command: process.execPath, prefixArgs: ['-e', 'setInterval(() => {}, 1000)'] },
        [],
        { env: process.env }
      )
      const rejection = expect(pending).rejects.toThrow(/npm 执行超时/)
      await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS + 1_000)
      await rejection
    } finally {
      vi.useRealTimers()
    }
  })

  it('signal abort 时 kill 子进程并以取消 reject（应用退出中止在飞安装）', async () => {
    const controller = new AbortController()
    const pending = spawnNpm(
      { command: process.execPath, prefixArgs: ['-e', 'setInterval(() => {}, 1000)'] },
      [],
      { env: process.env, signal: controller.signal }
    )
    // 子进程起来后中止
    setTimeout(() => controller.abort(), 30)
    await expect(pending).rejects.toThrow(/已取消/)
  })

  it('abort 走注入 spawn：确定性驱动 kill 与退出，不依赖真实时序', async () => {
    const emitter = new EventEmitter()
    const kill = vi.fn()
    const fakeChild = {
      pid: undefined, // 无 pid：killProcessGroup 直接返回，不触碰真实进程
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill,
      on: (event: string, listener: (...a: unknown[]) => void) => emitter.on(event, listener)
    }
    const spawnImpl = vi.fn(() => fakeChild) as unknown as typeof spawn
    const controller = new AbortController()
    const pending = spawnNpm(
      { command: 'npm', prefixArgs: [] },
      ['install'],
      { env: process.env, signal: controller.signal },
      spawnImpl
    )
    controller.abort()
    // abort 后进程随即退出（被组信号带走），close 事件驱动 reject
    emitter.emit('close', null, 'SIGTERM')
    await expect(pending).rejects.toThrow(/已取消/)
    expect(spawnImpl).toHaveBeenCalledOnce()
  })
})

describe('resolveNpmInvocation (bundled npm)', () => {
  it('随包 npm-cli.js 存在时最优先，经自带 Node 运行并带 ELECTRON_RUN_AS_NODE', async () => {
    const npmCliJs = join('/app', 'resources', 'npm', 'bin', 'npm-cli.js')
    // 只有捆绑脚本存在；系统探测一律探不到，验证 bundled 分支被优先选中
    const exists = (path: string): boolean => path === npmCliJs
    const run = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }))
    const invocation = await resolveNpmInvocation(run, exists, { npmCliJs })
    expect(invocation).toEqual({
      command: process.execPath,
      prefixArgs: [npmCliJs],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    // 命中 bundled 即短路，不再触发系统 which 探测
    expect(run).not.toHaveBeenCalled()
  })

  it('随包 npm-cli.js 不存在时回退系统探测（不选 bundled）', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      const posix = (path: string): string => path.replace(/\\/g, '/')
      const missing = join('/app', 'resources', 'npm', 'bin', 'npm-cli.js')
      const exists = (path: string): boolean => posix(path) === '/opt/homebrew/bin/npm'
      const run = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }))
      const invocation = await resolveNpmInvocation(run, exists, { npmCliJs: missing })
      expect(invocation).not.toBeNull()
      expect(posix(invocation!.command)).toBe('/opt/homebrew/bin/npm')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('可覆盖 nodeCommand 与 env（供非 Electron 宿主注入自带 Node）', async () => {
    const npmCliJs = join('/app', 'npm', 'bin', 'npm-cli.js')
    const invocation = await resolveNpmInvocation(vi.fn(), (path) => path === npmCliJs, {
      npmCliJs,
      nodeCommand: '/opt/node/bin/node',
      env: {}
    })
    expect(invocation).toEqual({ command: '/opt/node/bin/node', prefixArgs: [npmCliJs], env: {} })
  })
})

describe('resolveNpmInvocation (win32)', () => {
  it('返回 node.exe 直跑自带 npm-cli.js,绝不返回 .cmd', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      // 用同一 join 构造期望路径:POSIX 下 join 产生混合分隔符,与实现一致
      const nodeExe = join('C:\\Program Files', 'nodejs', 'node.exe')
      const bundledCli = join(
        'C:\\Program Files',
        'nodejs',
        'node_modules',
        'npm',
        'bin',
        'npm-cli.js'
      )
      const exists = vi.fn((path: string) => path === nodeExe || path === bundledCli)
      const invocation = await resolveNpmInvocation(vi.fn(), exists)
      expect(invocation).toEqual({ command: nodeExe, prefixArgs: [bundledCli] })
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('node.exe 与 npm-cli.js 不成对出现时返回 null(不落到 .cmd)', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const invocation = await resolveNpmInvocation(vi.fn(), () => false)
      expect(invocation).toBeNull()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})
describe('resolveNpmInvocation (unix)', () => {
  it('PATH 与 which 都找不到时，从常见安装位置解析 npm（如 homebrew）', async () => {
    // 该分支只在 Unix 语义下存在；测试在任意宿主平台固定 platform 后执行
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    try {
      // Windows 宿主上 join 产生反斜杠，与实现一致，比较前统一为正斜杠
      const posix = (path: string): string => path.replace(/\\/g, '/')
      const exists = (path: string): boolean => posix(path) === '/opt/homebrew/bin/npm'
      const run = vi.fn(async () => ({ code: 1, stdout: '', stderr: '' }))
      const invocation = await resolveNpmInvocation(run, exists)
      expect(invocation).not.toBeNull()
      expect(posix(invocation!.command)).toBe('/opt/homebrew/bin/npm')
      expect(invocation!.prefixArgs).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})
