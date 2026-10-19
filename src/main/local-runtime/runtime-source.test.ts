import { describe, expect, it } from 'vitest'
import {
  compareDshVersions,
  createPathProbe,
  planRuntimeSource,
  type PathRuntime
} from './runtime-source'
import type { CommandRunner } from './runtime-installer'

/**
 * 运行时获取策略(用户决策:「优先 hub 已装同版本 → 再探测 PATH →
 * 都没有才下载,真要下载时需要用户确认」)—— 纯决策函数穷举 + PATH 探测。
 */

const PATH_DSH: PathRuntime = { command: '/usr/local/bin/dsh', version: '0.1.5-rc.2' }

describe('planRuntimeSource(纯决策,全输入注入)', () => {
  // —— 固定版本(dshVersion = X)——

  it('固定 X + hub 已装 X → hub(第一优先)', () => {
    const plan = planRuntimeSource({
      desiredVersion: '0.1.5',
      hubInstalled: ['0.1.4', '0.1.5'],
      pathRuntime: PATH_DSH
    })
    expect(plan).toEqual({ kind: 'hub', version: '0.1.5', reason: 'pinned-installed' })
  })

  it('固定 X + hub 未装 + PATH dsh 恰为 X → path(第二优先)', () => {
    const plan = planRuntimeSource({
      desiredVersion: '0.1.5-rc.2',
      hubInstalled: ['0.1.4'],
      pathRuntime: PATH_DSH
    })
    expect(plan).toEqual({
      kind: 'path',
      command: '/usr/local/bin/dsh',
      version: '0.1.5-rc.2',
      reason: 'pinned-path-match'
    })
  })

  it('固定 X + hub 未装 + PATH dsh 版本不匹配 → download X(需确认)', () => {
    const plan = planRuntimeSource({
      desiredVersion: '0.1.5',
      hubInstalled: [],
      pathRuntime: PATH_DSH // 0.1.5-rc.2 ≠ 0.1.5,rc 不算同版本
    })
    expect(plan).toEqual({ kind: 'download', version: '0.1.5', reason: 'pinned-missing' })
  })

  it('固定 X + hub 未装 + 无 PATH → download X(需确认)', () => {
    const plan = planRuntimeSource({ desiredVersion: '0.1.5', hubInstalled: [], pathRuntime: null })
    expect(plan).toEqual({ kind: 'download', version: '0.1.5', reason: 'pinned-missing' })
  })

  // —— 未固定(dshVersion = null)——

  it('未固定 + 有 PATH dsh → path 优先(用户自己维护的安装,永远最新)', () => {
    const plan = planRuntimeSource({
      desiredVersion: null,
      hubInstalled: ['0.1.0'],
      pathRuntime: PATH_DSH
    })
    expect(plan).toEqual({
      kind: 'path',
      command: '/usr/local/bin/dsh',
      version: '0.1.5-rc.2',
      reason: 'unpinned-path-any'
    })
  })

  it('未固定 + 无 PATH + hub 已装 → hub 取最新(复用已下载)', () => {
    const plan = planRuntimeSource({
      desiredVersion: null,
      hubInstalled: ['0.1.9.0', '0.10.0', '0.9.0'],
      pathRuntime: null
    })
    // 数字感知:0.10.0 > 0.9.0 > 0.1.9.0(字典序会把 0.9 排最后,这里必须数字比较)
    expect(plan).toEqual({ kind: 'hub', version: '0.10.0', reason: 'unpinned-installed' })
  })

  it('未固定 + 无 PATH + hub 有正式与 rc → 取正式(0.1.5 > 0.1.5-rc.2)', () => {
    const plan = planRuntimeSource({
      desiredVersion: null,
      hubInstalled: ['0.1.5-rc.2', '0.1.5'],
      pathRuntime: null
    })
    expect(plan).toEqual({ kind: 'hub', version: '0.1.5', reason: 'unpinned-installed' })
  })

  it('未固定 + 无 PATH + hub 空 → download null(由调用方解析 latest,需确认)', () => {
    const plan = planRuntimeSource({ desiredVersion: null, hubInstalled: [], pathRuntime: null })
    expect(plan).toEqual({ kind: 'download', version: null, reason: 'unpinned-missing' })
  })

  it('未固定 + hub 只有 rc + 无 PATH → 取 rc(hub 里仅有就复用)', () => {
    const plan = planRuntimeSource({
      desiredVersion: null,
      hubInstalled: ['0.1.5-rc.2'],
      pathRuntime: null
    })
    expect(plan).toEqual({ kind: 'hub', version: '0.1.5-rc.2', reason: 'unpinned-installed' })
  })
})

describe('compareDshVersions(数字感知,正式 > 同号 rc)', () => {
  it.each([
    ['0.10.0', '0.9.0', 1], // 数字比较,非字典序
    ['0.9.0', '0.10.0', -1],
    ['0.1.5', '0.1.5-rc.2', 1], // 正式 > rc
    ['0.1.5-rc.2', '0.1.5', -1],
    ['0.1.5-rc.1', '0.1.5-rc.2', -1], // rc 后缀字典序
    ['0.1.5-rc.2', '0.1.5-rc.10', -1], // 点分 rc 段按数值比:rc.2 < rc.10（非字典序）
    ['0.1.5-rc9', '0.1.5-rc10', -1], // 无点分隔的双位 rc 同样按数值比:rc9 < rc10
    ['0.1.5-rc10', '0.1.5-rc9', 1],
    ['0.1.5-rc2', '0.1.5-rc2', 0],
    ['0.1.5-alpha', '0.1.5-rc', -1], // 同为文本后缀时按字典序:alpha < rc
    ['0.1.5-rc', '0.1.5-rc.1', -1], // 较短后缀排前:rc < rc.1
    ['1.2.3', '1.2.3', 0],
    ['0.1.0', '0.1.1', -1],
    ['2.0.0', '1.999.999', 1],
    ['0.1', '0.1.0', 0] // 段数不同,缺段按 0
  ])('compare(%s, %s) → %i', (a, b, expected) => {
    expect(Math.sign(compareDshVersions(a, b))).toBe(expected)
  })
})

/** 造一个按脚本应答的 CommandRunner:按 `command args.join` 前缀匹配 */
function scriptedRunner(
  script: Record<string, { code: number; stdout: string; stderr?: string }>
): CommandRunner {
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(' ')
    // 先试全 key(含参数),再试命令本身
    const hit = script[key] ?? script[`${command} --version`] ?? script[command]
    if (!hit) {
      const error = new Error(`ENOENT: ${key}`) as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }
    return { code: hit.code, stdout: hit.stdout, stderr: hit.stderr ?? '' }
  }
  return run
}

describe('createPathProbe(PATH 探测,尽力而为)', () => {
  /**
   * 纯注入环境:候选探测**不看真实文件系统**、不起登录 shell
   * (否则只要开发机装了 `~/.local/bin/dsh`),测试结果就会随开发机环境漂移。
   * platform 显式固定为 darwin:候选表/which 行为按 POSIX 断言,避免随宿主系统漂移;
   * win32 分支由下方专属用例单独覆盖。
   */
  const HERMETIC = {
    platform: 'darwin' as const,
    exists: () => false,
    listDir: () => [],
    loginShell: false
  }

  it('which dsh → 绝对路径 + dsh --version → 有效版本 → 返回 {command, version}', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      run: scriptedRunner({
        'which dsh': { code: 0, stdout: '/usr/local/bin/dsh\n' },
        '/usr/local/bin/dsh --version': { code: 0, stdout: '0.1.5-rc.2\n' }
      })
    })
    await expect(probe.probe()).resolves.toEqual({
      command: '/usr/local/bin/dsh',
      version: '0.1.5-rc.2'
    })
  })

  it('which 找不到(exit 1)→ null,不抛异常', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      run: async () => ({ code: 1, stdout: '', stderr: 'not found' })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('which 抛 ENOENT(极端环境没有 which)→ null', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      run: async () => {
        const error = new Error('ENOENT') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('which 输出相对路径 → 拒绝采用(PATH 里被塞相对路径时 spawn 行为随 cwd 漂移)', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      run: scriptedRunner({
        'which dsh': { code: 0, stdout: 'bin/dsh\n' },
        'bin/dsh --version': { code: 0, stdout: '0.1.5\n' }
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('dsh --version 输出垃圾(不含合法版本字符集)→ null', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      run: scriptedRunner({
        'which dsh': { code: 0, stdout: '/usr/local/bin/dsh\n' },
        '/usr/local/bin/dsh --version': { code: 0, stdout: 'not a version!!\n' }
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('dsh --version 非零退出 → null', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      run: scriptedRunner({
        'which dsh': { code: 0, stdout: '/usr/local/bin/dsh\n' },
        '/usr/local/bin/dsh --version': { code: 127, stdout: '', stderr: 'command not found' }
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('-version 输出多行 → 取第一行(带尾随空白也容忍)', async () => {
    // HERMETIC 固定 darwin,路径也要用 POSIX 形态,不能用真实 home(Windows 是盘符反斜杠)
    const whichPath = '/usr/local/bin/dsh'
    const probe = createPathProbe({
      ...HERMETIC,
      run: scriptedRunner({
        'which dsh': { code: 0, stdout: `${whichPath}\n` },
        [`${whichPath} --version`]: { code: 0, stdout: '0.1.5\nextra line\n' }
      })
    })
    await expect(probe.probe()).resolves.toEqual({
      command: whichPath,
      version: '0.1.5'
    })
  })

  it('win32:用 where 探测,接受盘符绝对路径', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      platform: 'win32',
      run: scriptedRunner({
        'where dsh': { code: 0, stdout: 'C:\\Tools\\dsh.exe\n' },
        'C:\\Tools\\dsh.exe --version': { code: 0, stdout: '0.1.5\r\n' }
      })
    })
    await expect(probe.probe()).resolves.toEqual({
      command: 'C:\\Tools\\dsh.exe',
      version: '0.1.5'
    })
  })

  it('win32:where 输出相对路径 → 拒绝', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      platform: 'win32',
      run: scriptedRunner({
        'where dsh': { code: 0, stdout: 'dsh.exe\n' }
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  // 用户实测:dsh 装在 ~/.local/bin(Finder 启动时不在 PATH)→ which 失败 → 候选绝对路径兜底命中
  it('which 失败 → 回退探测候选绝对路径(~/.local/bin/dsh 命中)', async () => {
    const probe = createPathProbe({
      platform: 'darwin' as const,
      home: '/Users/tester',
      exists: (path) => path === '/Users/tester/.local/bin/dsh',
      listDir: () => [],
      loginShell: false,
      run: scriptedRunner({
        'which dsh': { code: 1, stdout: '', stderr: 'not found' },
        '/Users/tester/.local/bin/dsh --version': { code: 0, stdout: '0.1.5-rc.2\n' }
      })
    })
    await expect(probe.probe()).resolves.toEqual({
      command: '/Users/tester/.local/bin/dsh',
      version: '0.1.5-rc.2'
    })
  })

  it('候选路径按优先级:homebrew 与 nvm 多版本都在时,先命中列表靠前者', async () => {
    const probed: string[] = []
    const probe = createPathProbe({
      platform: 'darwin' as const,
      home: '/Users/tester',
      exists: () => true,
      listDir: (path) => (path === '/Users/tester/.nvm/versions/node' ? ['v22.0.0'] : []),
      loginShell: false,
      run: async (command, args) => {
        if (command === 'which') return { code: 1, stdout: '', stderr: '' }
        if (args[0] === '--version') {
          probed.push(command)
          return { code: 0, stdout: '0.1.5\n', stderr: '' }
        }
        return { code: 1, stdout: '', stderr: '' }
      }
    })
    const found = await probe.probe()
    // 预期首个被验证的是 ~/.local/bin/dsh(列表顺序的第一项)
    expect(probed[0]).toBe('/Users/tester/.local/bin/dsh')
    expect(found?.command).toBe('/Users/tester/.local/bin/dsh')
  })

  it('候选都不存在 → 登录 shell 兜底(command -v dsh + dsh --version 在 shell 内一次跑完)', async () => {
    const probe = createPathProbe({
      platform: 'darwin' as const,
      home: '/Users/tester',
      exists: () => false,
      listDir: () => [],
      loginShell: true,
      shell: '/bin/zsh',
      run: scriptedRunner({
        'which dsh': { code: 1, stdout: '', stderr: '' },
        '/bin/zsh -lc command -v dsh; dsh --version': {
          code: 0,
          stdout: '/custom/prefix/bin/dsh\n0.2.0\n'
        }
      })
    })
    await expect(probe.probe()).resolves.toEqual({
      command: '/custom/prefix/bin/dsh',
      version: '0.2.0'
    })
  })

  it('登录 shell 输出缺版本行 → 不采信(避免「找得到路径但跑不动」的假阳性)', async () => {
    const probe = createPathProbe({
      platform: 'darwin' as const,
      home: '/Users/tester',
      exists: () => false,
      listDir: () => [],
      loginShell: true,
      run: scriptedRunner({
        'which dsh': { code: 1, stdout: '', stderr: '' },
        '/bin/zsh -lc command -v dsh; dsh --version': { code: 0, stdout: '/custom/dsh\n' }
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('登录 shell 也不可用 → null(不抛异常、不阻塞启动)', async () => {
    const probe = createPathProbe({
      platform: 'darwin' as const,
      home: '/Users/tester',
      exists: () => false,
      listDir: () => [],
      loginShell: true,
      run: scriptedRunner({
        'which dsh': { code: 1, stdout: '', stderr: '' }
        // shell 未登记 → scriptedRunner 抛 ENOENT
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })

  it('候选存在但 --version 失败 → 继续尝试后续候选,不误判为可用', async () => {
    const probe = createPathProbe({
      platform: 'darwin' as const,
      home: '/Users/tester',
      exists: (path) => path.endsWith('/dsh'),
      listDir: () => [],
      loginShell: false,
      run: async (command, args) => {
        if (command === 'which') return { code: 1, stdout: '', stderr: '' }
        if (args[0] === '--version') {
          // 只有 /usr/local/bin/dsh 能给出合法版本
          if (command === '/usr/local/bin/dsh') return { code: 0, stdout: '0.1.5\n', stderr: '' }
          return { code: 1, stdout: '', stderr: 'broken' }
        }
        return { code: 1, stdout: '', stderr: '' }
      }
    })
    await expect(probe.probe()).resolves.toEqual({
      command: '/usr/local/bin/dsh',
      version: '0.1.5'
    })
  })

  it('win32:候选补 .cmd(npm 全局脚本形态),shim 解析成入口脚本由 node 探测', async () => {
    const cmdPath = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\dsh.cmd'
    const scriptPath = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\dsh\\bin\\dsh.js'
    const probe = createPathProbe({
      platform: 'win32',
      home: 'C:\\Users\\tester',
      exists: (path) => path === cmdPath,
      listDir: () => [],
      loginShell: false,
      resolveShim: (path) => (path === cmdPath ? scriptPath : null),
      run: scriptedRunner({
        'where dsh': { code: 1, stdout: '', stderr: '' },
        [`node ${scriptPath} --version`]: {
          code: 0,
          stdout: '0.1.5\r\n'
        }
      })
    })
    await expect(probe.probe()).resolves.toEqual({
      command: cmdPath,
      version: '0.1.5'
    })
  })

  it('win32:shim 解析失败的 .cmd 不误判为可用(不发起注定 EINVAL 的执行)', async () => {
    const probe = createPathProbe({
      platform: 'win32',
      home: 'C:\\Users\\tester',
      exists: (path) => path === 'C:\\Users\\tester\\AppData\\Roaming\\npm\\dsh.cmd',
      listDir: () => [],
      loginShell: false,
      resolveShim: () => null,
      run: scriptedRunner({
        'where dsh': { code: 1, stdout: '', stderr: '' }
        // shim 解析失败 → 不再发起 node 探测,候选判否
      })
    })
    await expect(probe.probe()).resolves.toBeNull()
  })
})

describe('probeLauncher(向导检测本机 dsh/dush/duush)', () => {
  /** 纯注入环境:候选探测不看真实文件系统;platform 固定 darwin,win32 分支另有专属用例 */
  const HERMETIC = {
    platform: 'darwin' as const,
    home: '/Users/example',
    listDir: () => [],
    loginShell: false
  }

  it('which 失败 → 回退候选绝对路径(打包后 GUI 启动 PATH 残缺)', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      exists: (path) => path === '/Users/example/.local/bin/dsh',
      run: scriptedRunner({
        'which dsh': { code: 1, stdout: '' },
        '/Users/example/.local/bin/dsh --version': { code: 0, stdout: '0.1.6-alpha.2\n' }
      })
    })
    await expect(probe.probeLauncher?.('dsh')).resolves.toEqual({
      command: '/Users/example/.local/bin/dsh',
      version: '0.1.6-alpha.2'
    })
  })

  it('候选表必须覆盖 dush(不能只列 dsh)', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      exists: (path) => path === '/Users/example/.local/bin/dush',
      run: scriptedRunner({
        'which dush': { code: 1, stdout: '' },
        '/Users/example/.local/bin/dush --version': { code: 0, stdout: '0.1.1-rc.3\n' }
      })
    })
    await expect(probe.probeLauncher?.('dush')).resolves.toEqual({
      command: '/Users/example/.local/bin/dush',
      version: '0.1.1-rc.3'
    })
  })

  it('候选表必须覆盖 duush(不能只列 dsh/dush)', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      exists: (path) => path === '/Users/example/.local/bin/duush',
      run: scriptedRunner({
        'which duush': { code: 1, stdout: '' },
        '/Users/example/.local/bin/duush --version': { code: 0, stdout: '0.1.0-beta.0\n' }
      })
    })
    await expect(probe.probeLauncher?.('duush')).resolves.toEqual({
      command: '/Users/example/.local/bin/duush',
      version: '0.1.0-beta.0'
    })
  })

  it('探测 duush 时不得把 dsh/dush 当结果(启动器之间不串台)', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      exists: (path) => path === '/Users/example/.local/bin/dush',
      run: scriptedRunner({
        'which duush': { code: 1, stdout: '' },
        '/Users/example/.local/bin/dush --version': { code: 0, stdout: '0.1.1-rc.3\n' }
      })
    })
    await expect(probe.probeLauncher?.('duush')).resolves.toBeNull()
  })

  it('which 与候选都不行 → 登录 shell 兜底(自定义 PATH 只有登录环境知道)', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      loginShell: true,
      shell: '/bin/zsh',
      exists: () => false,
      run: scriptedRunner({
        'which dush': { code: 1, stdout: '' },
        '/bin/zsh -lc command -v dush; dush --version': {
          code: 0,
          stdout: '/custom/bin/dush\n0.1.1-rc.3\n'
        }
      })
    })
    await expect(probe.probeLauncher?.('dush')).resolves.toEqual({
      command: '/custom/bin/dush',
      version: '0.1.1-rc.3'
    })
  })

  it('探测 dsh 时不得把 dush 当结果(启动器之间不串台)', async () => {
    const probe = createPathProbe({
      ...HERMETIC,
      exists: (path) => path === '/Users/example/.local/bin/dush',
      run: scriptedRunner({
        'which dsh': { code: 1, stdout: '' },
        '/Users/example/.local/bin/dush --version': { code: 0, stdout: '0.1.1-rc.3\n' }
      })
    })
    await expect(probe.probeLauncher?.('dsh')).resolves.toBeNull()
  })
})
