import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandResult, NpmInvocation } from './runtime-installer'
import {
  COMMAND_TIMEOUT_MS,
  createRuntimeInstaller,
  globalPrefixFor,
  globalRuntimeEntry,
  npmFetchInfo,
  readInstallingMarker,
  resolveNpmInvocation,
  runtimeDirFor,
  runtimeEntryFor,
  spawnNpm,
  type InstalledRuntime
} from './runtime-installer'

let dirs: string[] = []
const tmpDir = (): string => {
  const dir = join(process.cwd(), 'hub-data', 'test-tmp', `rt-${randomUUID().slice(0, 8)}`)
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  dirs = []
})

function okRun(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: '' }
}

/** 路径断言只关心布局：分隔符由宿主的 path.join 决定（Windows 上是反斜杠），比较前统一成正斜杠。 */
const slashes = (value: string): string => value.replace(/\\/g, '/')

/** 造一个「已安装」的运行时目录,让入口存在性校验通过 */
async function fakeInstallArtifacts(runtimesDir: string, version: string): Promise<string> {
  const entry = runtimeEntryFor(runtimesDir, version)
  await mkdir(
    join(runtimeDirFor(runtimesDir, version), 'node_modules', '@deepseek-ai', 'dsh', 'lib'),
    {
      recursive: true
    }
  )
  await writeFile(entry, '#!/usr/bin/env node\n', 'utf8')
  return entry
}

describe('createRuntimeInstaller', () => {
  it('listAvailableVersions 解析 npm view 输出(剔除非字符串/含斜杠项)', async () => {
    // npm 解析注入固定值:聚焦 view 输出解析,断言不随宿主平台探测结果漂移
    const run = vi.fn(async () =>
      okRun(JSON.stringify(['0.1.2-rc.1', '0.1.5-rc.1', '0.1.5-rc.2', { bad: 1 }, 'x/y']))
    )
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run,
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] })
    })
    const versions = await installer.listAvailableVersions()
    expect(versions).toEqual(['0.1.2-rc.1', '0.1.5-rc.1', '0.1.5-rc.2'])
    expect(run).toHaveBeenCalledWith(
      '/fake/npm',
      expect.arrayContaining(['view', '@deepseek-ai/dsh', 'versions', '--json']),
      expect.anything()
    )
  })

  it('resolveDefaultVersion 优先 dist-tags.latest,否则取版本列表末位', async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) =>
      args.includes('dist-tags')
        ? okRun(JSON.stringify({ latest: '0.1.5-rc.1', next: '0.1.5-rc.2' }))
        : okRun(JSON.stringify(['0.1.2-rc.1', '0.1.5-rc.2']))
    )
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: run as never
    })
    expect(await installer.resolveDefaultVersion()).toBe('0.1.5-rc.1')

    const noTags = vi.fn(async () => okRun(JSON.stringify(['0.1.2-rc.1', '0.1.5-rc.2'])))
    const fallback = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: noTags as never
    })
    expect(await fallback.resolveDefaultVersion()).toBe('0.1.5-rc.2')
  })

  it('resolveLatestVersion 取版本列表最大值(dist-tags.latest 滞后于新发布也不受影响)', async () => {
    const run = vi.fn(async (_cmd: string, args: string[]) =>
      args.includes('dist-tags')
        ? okRun(JSON.stringify({ latest: '0.1.5-rc.2' }))
        : okRun(JSON.stringify(['0.1.5-rc.2', '0.1.6-alpha.2', '0.1.7-alpha.2']))
    )
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: run as never
    })
    expect(await installer.resolveLatestVersion()).toBe('0.1.7-alpha.2')

    // 不假设 registry 返回顺序：乱序也按版本比较取最大。
    const unordered = vi.fn(async (_cmd: string, args: string[]) =>
      args.includes('dist-tags')
        ? okRun('{}')
        : okRun(JSON.stringify(['0.1.7-alpha.2', '0.1.5-rc.4', '0.1.6']))
    )
    const shuffled = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: unordered as never
    })
    expect(await shuffled.resolveLatestVersion()).toBe('0.1.7-alpha.2')
  })

  it('install 流程:写 installing.json → npm install → 校验入口 → 移除标记', async () => {
    const version = '0.1.5-rc.1'
    const runtimesDir = tmpDir()
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run: async () => okRun('')
    })
    const entry = await fakeInstallArtifacts(runtimesDir, version)

    const installed = await installer.install(version)
    expect(installed).toMatchObject({ version, dir: runtimeDirFor(runtimesDir, version), entry })
    expect(await installer.isInstalled(version)).toBe(true)
    expect(await installer.hasIncompleteInstall(version)).toBe(false)
  })

  it('install 失败时保留 installing.json(断点恢复依据)', async () => {
    const version = '0.1.5-rc.1'
    const runtimesDir = tmpDir()
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run: async () => ({ code: 1, stdout: '', stderr: 'EACCES 模拟' })
    })
    await expect(installer.install(version)).rejects.toThrow(/失败/)
    expect(await installer.hasIncompleteInstall(version)).toBe(true)
    expect(await readInstallingMarker(runtimesDir, version)).toMatchObject({ version })
  })

  it('isInstalled 按入口存在性 stat 判断:有入口→已安装,无入口/无目录→未安装', async () => {
    // 已通过 fakeInstallArtifacts 造好 0.1.5-rc.2 的入口;0.1.4-rc.1 目录与入口都不存在。
    const runtimesDir = tmpDir()
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run: async () => okRun('')
    })
    await fakeInstallArtifacts(runtimesDir, '0.1.5-rc.2')
    expect(await installer.isInstalled('0.1.5-rc.2')).toBe(true)
    expect(await installer.isInstalled('0.1.4-rc.1')).toBe(false)
  })

  it('非法版本号(路径穿越)一律拒绝', async () => {
    const installer = createRuntimeInstaller({ runtimesDir: tmpDir(), cacheDir: tmpDir() })
    await expect(installer.install('1.0.0/../../evil')).rejects.toThrow(/非法版本号/)
    await expect(installer.isInstalled('../x')).rejects.toThrow(/非法版本号/)
    expect(() => runtimeDirFor(tmpDir(), 'a/b')).toThrow(/非法版本号/)
    expect(() => runtimeEntryFor(tmpDir(), 'a\\b')).toThrow(/非法版本号/)
  })

  it('ensureInstalled 并发只安装一次(多实例同时首启复用同一份运行时)', async () => {
    const runtimesDir = tmpDir()
    const version = '0.1.5-rc.1'
    let installCalls = 0
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run: async (_command: string, args: string[]) => {
        if (args.includes('install')) {
          installCalls += 1
          await fakeInstallArtifacts(runtimesDir, version)
          return okRun('')
        }
        return okRun('[]')
      }
    })

    const [first, second] = await Promise.all([
      installer.ensureInstalled(version),
      installer.ensureInstalled(version)
    ])
    expect(installCalls).toBe(1)
    expect(first.entry).toBe(second.entry)
    expect(await installer.isInstalled(version)).toBe(true)
  })

  it('listInstalled 跳过未完成安装与无关目录名', async () => {
    const runtimesDir = tmpDir()
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run: async () => okRun('')
    })
    await fakeInstallArtifacts(runtimesDir, '0.1.5-rc.1')

    // 手工制造「未完成」目录与无关目录
    const broken = join(runtimesDir, 'dsh-0.1.4-rc.1')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'installing.json'), '{}', 'utf8')
    await mkdir(join(runtimesDir, '无关目录'), { recursive: true })

    const installed = await installer.listInstalled()
    expect(installed.map((item: InstalledRuntime) => item.version)).toEqual(['0.1.5-rc.1'])
  })

  it('进度分支:只报下载记录（只数 .tgz 包体、含缓存命中、按个数去重），不给百分比', async () => {
    const version = '0.1.5-rc.1'
    const runtimesDir = tmpDir()
    const run = vi.fn(async (command: string, args: string[]) => {
      void command
      void args
      return okRun('[]')
    })
    const runNpm = vi.fn(
      async (
        _npm: NpmInvocation,
        _args: string[],
        opts: { onStderrLine?: (line: string) => void }
      ) => {
        // 元数据请求不算下载
        opts.onStderrLine?.('npm http fetch GET 200 https://registry.npmjs.org/a 1ms (cache miss)')
        opts.onStderrLine?.(
          'npm http fetch GET 200 https://registry.npmjs.org/b/-/b-1.0.0.tgz 2ms (cache miss)'
        )
        // 缓存命中的包体同样计入（重复安装/修复时不会漏数）
        opts.onStderrLine?.(
          'npm http cache c@https://registry.npmjs.org/c/-/c-1.0.0.tgz 0ms (cache hit)'
        )
        // 同一包体的重复日志只算一次
        opts.onStderrLine?.(
          'npm http fetch GET 200 https://registry.npmjs.org/b/-/b-1.0.0.tgz 1ms (cache miss)'
        )
        opts.onStderrLine?.('added 2 packages')
        await fakeInstallArtifacts(runtimesDir, version)
        return okRun('')
      }
    )
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run,
      runNpm,
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] })
    })

    const seen: Array<Record<string, unknown>> = []
    await installer.ensureInstalled(version, (progress) => seen.push({ ...progress }))
    const details = seen.map((item) => item.detail as string | undefined)

    expect(details[0]).toBe(`安装 @deepseek-ai/dsh@${version}`)
    expect(details).toContain('下载依赖 (1)：b/-/b-1.0.0.tgz')
    expect(details).toContain('下载依赖 (2)：c/-/c-1.0.0.tgz')
    expect(details).toContain('校验安装结果')
    expect(details.at(-1)).toBe('安装完成')
    // 不再提供百分比（npm 没有可用的总量与进度）
    expect(seen.every((item) => item.percent === undefined)).toBe(true)
    // 非 fetch 行不推进进度
    expect(details.filter((detail) => detail?.includes('added'))).toHaveLength(0)
  })

  it('进度分支不因解析失败而受影响：无需额外解析步骤', async () => {
    const version = '0.1.5-rc.3'
    const runtimesDir = tmpDir()
    // run 只在无进度回调的汇总分支使用；带进度时完全不走它
    const run = vi.fn(async (command: string, args: string[]) => {
      void command
      void args
      return okRun('not json')
    })
    const runNpm = vi.fn(
      async (
        _npm: NpmInvocation,
        _args: string[],
        opts: { onStderrLine?: (line: string) => void }
      ) => {
        opts.onStderrLine?.('npm http fetch GET 200 https://registry.npmjs.org/b/-/b-1.0.0.tgz 1ms')
        await fakeInstallArtifacts(runtimesDir, version)
        return okRun('')
      }
    )
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run,
      runNpm,
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] })
    })

    await installer.ensureInstalled(version, () => undefined)
    expect(run).not.toHaveBeenCalled()
  })

  it('进度分支失败:错误消息只保留 stderr 尾部结论(http 日志不整段进入消息)', async () => {
    const runtimesDir = tmpDir()
    const run = vi.fn(async () => okRun('[]'))
    const stderrLines = [
      ...Array.from(
        { length: 40 },
        (_, index) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${index} 1ms`
      ),
      'npm error 404 Not Found'
    ]
    const runNpm = vi.fn(
      async (
        _npm: NpmInvocation,
        _args: string[],
        opts: { onStderrLine?: (line: string) => void }
      ) => {
        for (const line of stderrLines) opts.onStderrLine?.(line)
        return { code: 1, stdout: '', stderr: stderrLines.join('\n') }
      }
    )
    const installer = createRuntimeInstaller({
      runtimesDir,
      cacheDir: tmpDir(),
      run,
      runNpm,
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] })
    })

    const message = await installer
      .ensureInstalled('0.1.5-rc.1', () => undefined)
      .catch((error: Error) => error.message)
    expect(message).toContain('npm error 404 Not Found')
    expect(message).not.toContain('pkg-0')
  })
})

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

describe('npm 子进程 PATH（GUI 启动时 node 不在 PATH 的场景）', () => {
  const pathDirs = (path: string | undefined): string[] => (path ?? '').split(delimiter)
  const envOf = (call: unknown[] | undefined): NodeJS.ProcessEnv =>
    (call?.[2] as { env?: NodeJS.ProcessEnv } | undefined)?.env ?? {}

  it('view 调用：npm 目录与常见 node 落点前置，原 PATH 目录全部保留', async () => {
    const run = vi.fn(async () => okRun(JSON.stringify(['0.1.5'])))
    const command = join('/opt', 'custom', 'npm')
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run,
      resolveNpm: async () => ({ command, prefixArgs: [] })
    })
    await installer.listAvailableVersions()

    const dirs = pathDirs(envOf(run.mock.calls[0]).PATH)
    // npm 自身目录在最前：PATH 缺它时 npm 入口脚本的 `#!/usr/bin/env node` 解析不到 node
    expect(dirs[0]).toBe(dirname(command))
    // 常见 node 落点兜底：npm 与 node 不在同目录时仍能找到 node
    expect(dirs).toContain(join(homedir(), '.local', 'bin'))
    expect(dirs).toContain('/opt/homebrew/bin')
    for (const original of pathDirs(process.env.PATH)) expect(dirs).toContain(original)
  })

  it('install 调用（无进度走 run、进度走 runNpm）同样带上增强后的 PATH', async () => {
    const version = '0.1.5-rc.1'
    const command = join('/opt', 'custom', 'npm')
    const resolveNpm = async () => ({ command, prefixArgs: [] })

    // 无进度分支
    const plainDir = tmpDir()
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('install')) await fakeInstallArtifacts(plainDir, version)
      return okRun('')
    })
    const plain = createRuntimeInstaller({
      runtimesDir: plainDir,
      cacheDir: tmpDir(),
      run,
      resolveNpm
    })
    await plain.install(version)
    const installCall = run.mock.calls.find(([, args]) => (args as string[]).includes('install'))
    expect(pathDirs(envOf(installCall).PATH)[0]).toBe(dirname(command))

    // 进度分支
    const progressDir = tmpDir()
    let progressPath: string | undefined
    const runNpm = vi.fn(
      async (_npm: NpmInvocation, _args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        progressPath = opts.env.PATH
        await fakeInstallArtifacts(progressDir, version)
        return okRun('')
      }
    )
    const progress = createRuntimeInstaller({
      runtimesDir: progressDir,
      cacheDir: tmpDir(),
      run: vi.fn(async () => okRun('')),
      runNpm,
      resolveNpm
    })
    await progress.ensureInstalled(version, () => undefined)
    expect(pathDirs(progressPath)[0]).toBe(dirname(command))
  })

  it('捆绑 npm 的 env（ELECTRON_RUN_AS_NODE）叠加到子进程环境', async () => {
    const run = vi.fn(async () => okRun(JSON.stringify(['0.1.5'])))
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run,
      resolveNpm: async () => ({
        command: process.execPath,
        prefixArgs: ['/app/npm/bin/npm-cli.js'],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      })
    })
    await installer.listAvailableVersions()
    expect(envOf(run.mock.calls[0]).ELECTRON_RUN_AS_NODE).toBe('1')
  })
})

describe('元数据读取提速（分队列 + TTL 缓存）', () => {
  const viewCount = (run: ReturnType<typeof vi.fn>): number =>
    run.mock.calls.filter(([, args]) => (args as string[]).includes('view')).length

  it('元数据读取不排在安装链后面：安装挂起时版本列表仍立即返回', async () => {
    const runtimesDir = tmpDir()
    const version = '0.1.5-rc.1'
    let releaseInstall!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseInstall = resolve
    })
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'which') return okRun('/usr/local/bin/npm')
      if (args.includes('view')) return okRun(JSON.stringify([version]))
      if (args.includes('install')) {
        await gate
        await fakeInstallArtifacts(runtimesDir, version)
        return okRun('')
      }
      return okRun('')
    })
    const installer = createRuntimeInstaller({ runtimesDir, cacheDir: tmpDir(), run })

    // 安装占住安装链并卡在 gate 上。
    const installing = installer.install(version)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // 若元数据与安装同队，这一行会一直挂到 gate 放开（测试超时即失败）。
    await expect(installer.listAvailableVersions()).resolves.toEqual([version])

    releaseInstall()
    await installing
  })

  it('versions 列表在 TTL 内只打一次 npm view；metadataTtlMs=0 时每次都打', async () => {
    const cachedRun = vi.fn(async (cmd: string) =>
      cmd === 'which' ? okRun('/usr/local/bin/npm') : okRun(JSON.stringify(['0.1.5']))
    )
    const cached = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: cachedRun
    })
    await cached.listAvailableVersions()
    await cached.listAvailableVersions()
    expect(viewCount(cachedRun)).toBe(1)

    const freshRun = vi.fn(async (cmd: string) =>
      cmd === 'which' ? okRun('/usr/local/bin/npm') : okRun(JSON.stringify(['0.1.5']))
    )
    const uncached = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run: freshRun,
      metadataTtlMs: 0
    })
    await uncached.listAvailableVersions()
    await uncached.listAvailableVersions()
    expect(viewCount(freshRun)).toBe(2)
  })

  it('registry 变化（切镜像）后缓存立即失效，且调用带上新 --registry', async () => {
    let registry = 'https://mirror-a.example'
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'which') return okRun('/usr/local/bin/npm')
      if (args.includes('view')) return okRun(JSON.stringify(['0.1.5']))
      return okRun('')
    })
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run,
      getRegistry: () => registry
    })
    await installer.listAvailableVersions()
    await installer.listAvailableVersions()
    expect(viewCount(run)).toBe(1)

    registry = 'https://mirror-b.example'
    await installer.listAvailableVersions()
    expect(viewCount(run)).toBe(2)
    expect(run.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining(['--registry', 'https://mirror-b.example'])
    )
  })
})

describe('系统 dsh 的 npm 全局升级', () => {
  it('globalPrefixFor 只认 npm 全局布局，pnpm 虚拟存储与本地依赖不猜', () => {
    // 布局判定跟平台走：断言一律显式传平台，宿主平台（如 Windows CI）不改变预期
    expect(
      globalPrefixFor('/Users/x/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'linux')
    ).toBe('/Users/x/.local')
    expect(
      globalPrefixFor('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'linux')
    ).toBe('/usr/local')
    expect(
      globalPrefixFor(
        'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
        'win32'
      )
    ).toBe('C:/Users/x/AppData/Roaming/npm')
    // pnpm 全局:真实路径落在 .pnpm 虚拟存储,node_modules 不在 lib 下
    expect(
      globalPrefixFor(
        '/Users/x/Library/pnpm/global/5/node_modules/.pnpm/@deepseek-ai+dsh@0.1.6/node_modules/@deepseek-ai/dsh/lib/bin.js',
        'linux'
      )
    ).toBeNull()
    // 本地依赖与裸脚本路径
    expect(
      globalPrefixFor('/Users/x/proj/node_modules/@deepseek-ai/dsh/lib/bin.js', 'linux')
    ).toBeNull()
    expect(globalPrefixFor('/opt/homebrew/bin/dsh', 'linux')).toBeNull()
    expect(globalPrefixFor('/lib/node_modules/@deepseek-ai/dsh/lib/bin.js', 'linux')).toBeNull()
  })

  it('globalRuntimeEntry 与 globalPrefixFor 互为逆运算（POSIX 多一层 lib）', () => {
    const prefix = '/Users/x/.local'
    expect(slashes(globalRuntimeEntry(prefix, 'linux'))).toBe(
      '/Users/x/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
    )
    expect(globalPrefixFor(globalRuntimeEntry(prefix, 'linux'), 'linux')).toBe(prefix)
    expect(globalRuntimeEntry('C:\\npm', 'win32')).toContain('node_modules')
  })

  it('resolveGlobalPrefix：先解析符号链接再判定布局', async () => {
    const root = tmpDir()
    // 目录按当前平台的 npm 全局布局构造（POSIX 多一层 lib，Windows 在根下）
    const entry = globalRuntimeEntry(root)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, '#!/usr/bin/env node\n', 'utf8')
    const binDir = join(root, 'bin')
    await mkdir(binDir, { recursive: true })
    await symlink(entry, join(binDir, 'dsh'))

    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] })
    })
    // globalPrefixFor 一律回正斜杠，与宿主平台的分隔符无关
    expect(await installer.resolveGlobalPrefix(join(binDir, 'dsh'))).toBe(slashes(root))
    // 指向不存在的文件 → 解析失败按无法代管处理
    expect(await installer.resolveGlobalPrefix(join(binDir, 'missing'))).toBeNull()
  })

  it('installGlobal 走 npm install -g --prefix 安装到系统 prefix 并校验入口', async () => {
    const prefix = tmpDir()
    const entry = globalRuntimeEntry(prefix)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, '#!/usr/bin/env node\n', 'utf8')
    const run = vi.fn(async () => okRun(''))
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: '/tmp/fake-cache',
      run,
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] })
    })

    await installer.installGlobal(prefix, '0.1.6')

    expect(run).toHaveBeenCalledWith(
      '/fake/npm',
      expect.arrayContaining(['install', '-g', '--prefix', prefix, '@deepseek-ai/dsh@0.1.6']),
      expect.anything()
    )
  })

  it('installGlobal：升级完成后入口缺失 → 报错（不静默假成功）', async () => {
    const prefix = tmpDir() // 不造入口文件
    const run = vi.fn(async () => okRun(''))
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      run,
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] })
    })

    await expect(installer.installGlobal(prefix, '0.1.6')).rejects.toThrow('未找到 dsh 入口')
  })

  it('installGlobal：带进度回调时透传 npm fetch 进度（spawnNpm 分支）', async () => {
    const prefix = tmpDir()
    const entry = globalRuntimeEntry(prefix)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, '#!/usr/bin/env node\n', 'utf8')
    const installer = createRuntimeInstaller({
      runtimesDir: tmpDir(),
      cacheDir: tmpDir(),
      resolveNpm: async () => ({ command: '/fake/npm', prefixArgs: [] }),
      runNpm: vi.fn(async (_npm, _args, options) => {
        options.onStderrLine?.(
          'npm http fetch GET 200 https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.1.6.tgz 12ms'
        )
        return { code: 0, stdout: '', stderr: '' }
      })
    })

    const details: Array<string | undefined> = []
    await installer.installGlobal(prefix, '0.1.6', (item) => details.push(item.detail))

    expect(details.some((detail) => detail?.startsWith('全局安装'))).toBe(true)
    expect(details.some((detail) => detail?.startsWith('下载依赖'))).toBe(true)
    expect(details.at(-1)).toBe('安装完成')
  })
})
