import { describe, expect, it } from 'vitest'
import type { LocalInstance } from '@shared/contracts'
import { createPluginCommandRunner } from './plugin-command'
import type { CommandResult, CommandRunner } from './exec-file'

/**
 * 插件命令的构造与执行。
 *
 * 重点守卫三条线：
 * - **命令形状**：`dsh plugin --profile <p> <args>`，registry 档位映射成 `--registry <url>`；
 * - **DSH_HOME 与 profile 由主进程推导**：绝不采信渲染层路径；
 * - **失败原因要透出**：dsh 拒绝安装时那段 stderr 是用户唯一能看到的失败原因，
 *   不能收敛成「内部错误」。
 */

const INSTANCE = { id: 'inst-1', name: '本机实例', transport: 'local' } as LocalInstance

/** 记录一次执行调用，便于断言命令形状与环境。 */
interface Call {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/** 装配命令执行器：记录调用，返回预设结果。 */
function runnerOf(result: Partial<CommandResult> = {}): {
  run: CommandRunner
  calls: Call[]
} {
  const calls: Call[] = []
  const run: CommandRunner = async (command, args, options) => {
    calls.push({ command, args: [...args], env: { ...(options?.env ?? {}) } })
    return { code: 0, stdout: '', stderr: '', ...result }
  }
  return { run, calls }
}

/** 装配命令执行器（可覆盖依赖项）。 */
function build(
  overrides: Partial<Parameters<typeof createPluginCommandRunner>[0]> = {},
  result: Partial<CommandResult> = {}
): { runner: ReturnType<typeof createPluginCommandRunner>; calls: Call[] } {
  const { run, calls } = runnerOf(result)
  const runner = createPluginCommandRunner({
    run,
    homeAndProfile: () => ({ home: '/homes/inst-1', profile: 'web' }),
    resolveNode: () => '/usr/bin/node',
    nodeInvocation: { command: '/electron/node', args: ['ELECTRON_RUN_AS_NODE=1'], env: {} },
    inheritShellEnv: () => false,
    shellEnv: async () => null,
    loginPath: async () => null,
    ...overrides
  })
  return { runner, calls }
}

describe('命令形状', () => {
  it('拼成 dsh plugin --profile <p> <args>', async () => {
    const { runner, calls } = build()
    await runner.runPlugin(INSTANCE, ['list', '--json'], { entry: '/dsh/bin.js', version: '0.2.0' })
    expect(calls[0]?.command).toBe('/usr/bin/node')
    expect(calls[0]?.args).toEqual([
      'ELECTRON_RUN_AS_NODE=1',
      '/dsh/bin.js',
      'plugin',
      '--profile',
      'web',
      'list',
      '--json'
    ])
  })

  it('registry 档位追加 --registry <url>', async () => {
    const { runner, calls } = build()
    await runner.runPlugin(
      INSTANCE,
      ['view', 'demo'],
      { entry: '/dsh/bin.js', version: '0.2.0' },
      'npmjs'
    )
    expect(calls[0]?.args).toContain('--registry')
    expect(calls[0]?.args).toContain('https://registry.npmjs.org')
  })

  it('无 registry 档位时不追加 --registry', async () => {
    const { runner, calls } = build()
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/dsh/bin.js', version: '0.2.0' })
    expect(calls[0]?.args).not.toContain('--registry')
  })

  it('DSH_HOME 由主进程按实例推导', async () => {
    const { runner, calls } = build({
      homeAndProfile: () => ({ home: '/homes/inst-9', profile: 'sdk' })
    })
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/dsh/bin.js', version: '0.2.0' })
    expect(calls[0]?.env['DSH_HOME']).toBe('/homes/inst-9')
    expect(calls[0]?.args).toContain('sdk')
  })

  it('绕过 pnpm shim 派发（PNPM_SHIM_BYPASS）', async () => {
    const { runner, calls } = build()
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/dsh/bin.js', version: '0.2.0' })
    expect(calls[0]?.env['PNPM_SHIM_BYPASS']).toBe('1')
  })
})

describe('可执行入口的选择', () => {
  it('node 解析得到时用 node 跑入口脚本', async () => {
    const { runner, calls } = build({ resolveNode: () => '/usr/local/bin/node' })
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/dsh/bin.js', version: '0.2.0' })
    expect(calls[0]?.command).toBe('/usr/local/bin/node')
  })

  it('node 解析不到但入口是 .js 时用 Electron 自带 Node', async () => {
    const { runner, calls } = build({ resolveNode: () => null })
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/dsh/bin.js', version: '0.2.0' })
    expect(calls[0]?.command).toBe('/electron/node')
  })

  it('入口不是 .js 时直接执行它', async () => {
    const { runner, calls } = build({ resolveNode: () => null })
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/usr/local/bin/dsh', version: '0.2.0' })
    expect(calls[0]?.command).toBe('/usr/local/bin/dsh')
    expect(calls[0]?.args).toEqual(['plugin', '--profile', 'web', 'list'])
  })
})

describe('PATH 的处理', () => {
  it('node 目录前置到 PATH', async () => {
    const { runner, calls } = build({ resolveNode: () => '/opt/node/bin/node' })
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/dsh/bin.js', version: '0.2.0' })
    const path = calls[0]?.env['PATH'] ?? ''
    expect(path.startsWith('/opt/node/bin')).toBe(true)
  })

  it('随包 pnpm 启动器目录并入 PATH', async () => {
    const { runner, calls } = build({ pnpmBinDir: '/app/pnpm/bin' })
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/dsh/bin.js', version: '0.2.0' })
    expect(calls[0]?.env['PATH']).toContain('/app/pnpm/bin')
  })

  it('合并登录 shell 完整环境（开关打开且解析成功时）', async () => {
    const { runner, calls } = build({
      inheritShellEnv: () => true,
      shellEnv: async () => new Map([['MY_TOKEN', 'secret']])
    })
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/dsh/bin.js', version: '0.2.0' })
    expect(calls[0]?.env['MY_TOKEN']).toBe('secret')
  })

  it('登录环境解析失败时回退到仅合并登录 PATH', async () => {
    const { runner, calls } = build({
      inheritShellEnv: () => true,
      shellEnv: async () => {
        throw new Error('解析失败')
      },
      loginPath: async () => '/login/bin'
    })
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/dsh/bin.js', version: '0.2.0' })
    expect(calls[0]?.env['PATH']).toContain('/login/bin')
  })

  it('登录 PATH 也解析不到时只保留继承的 PATH（node 目录仍前置）', async () => {
    const { runner, calls } = build({
      inheritShellEnv: () => false,
      loginPath: async () => null,
      resolveNode: () => null
    })
    await runner.runPlugin(INSTANCE, ['list'], { entry: '/dsh/bin.js', version: '0.2.0' })
    expect(calls[0]?.env['PATH']).toBe(process.env.PATH ?? '')
  })
})

describe('失败原因透出', () => {
  it('非零退出 → invalid-state，消息含 stderr', async () => {
    const { runner } = build({}, { code: 1, stderr: 'ERR_PNPM_PEER_DEP_ISSUES 装不了' })
    await expect(
      runner.runPlugin(INSTANCE, ['add', 'demo'], { entry: '/dsh/bin.js', version: '0.2.0' })
    ).rejects.toMatchObject({ code: 'invalid-state' })
  })

  it('stderr 里的键值凭据被脱敏（这段说明会经 IPC 到界面）', async () => {
    const { runner } = build(
      {},
      { code: 1, stderr: 'npmToken=abcdef1234567890\npassword=hunter2secret' }
    )
    try {
      await runner.runPlugin(INSTANCE, ['add', 'demo'], { entry: '/dsh/bin.js', version: '0.2.0' })
      throw new Error('应当抛错')
    } catch (error) {
      const message = (error as Error).message
      expect(message).not.toContain('abcdef1234567890')
      expect(message).not.toContain('hunter2secret')
    }
  })

  it('stderr 里 URL 的查询串被脱敏', async () => {
    const { runner } = build(
      {},
      { code: 1, stderr: 'failed https://registry.example.com/x?token=abc123' }
    )
    try {
      await runner.runPlugin(INSTANCE, ['add', 'demo'], { entry: '/dsh/bin.js', version: '0.2.0' })
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as Error).message).not.toContain('abc123')
    }
  })

  it('无 stderr 时给占位说明，不留空消息', async () => {
    const { runner } = build({}, { code: 2, stderr: '   ' })
    try {
      await runner.runPlugin(INSTANCE, ['add', 'demo'], { entry: '/dsh/bin.js', version: '0.2.0' })
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as Error).message).toContain('无 stderr')
    }
  })

  it('成功时原样返回结果', async () => {
    const { runner } = build({}, { code: 0, stdout: '{"ok":true}' })
    const result = await runner.runPlugin(INSTANCE, ['list'], {
      entry: '/dsh/bin.js',
      version: '0.2.0'
    })
    expect(result.stdout).toBe('{"ok":true}')
  })
})
