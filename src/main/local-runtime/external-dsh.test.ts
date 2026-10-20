import { describe, expect, it } from 'vitest'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  createExternalDshScanner,
  findDshWebArgs,
  isDshEntryToken,
  isDshWebCommand,
  parseListeningPorts,
  parseWindowsListeningPorts,
  patchOf,
  portOf,
  selectDshWebProcesses,
  WIN_PROCESS_SCRIPT
} from './external-dsh'
import { collectDescendants, parseProcessTable, parseWindowsProcessTable } from './process-table'

/**
 *   node ~/.local/bin/dsh --profile web --patch ~/.dush/cordis.dush.patch.yml --no-open
 * hub 必须能发现它(只读探测:ps + lsof),且不能把自己的 spawn 或 shell 包装误报成外部实例。
 *
 * 路径与用户名取自当前运行环境:真实 `ps`/`lsof` 输出的就是这些环境相关的绝对路径,
 * 因此探测比写死某个用户的路径更贴近生产,也不会把个人目录带进仓库。
 */
const HOME = homedir()
const USER = userInfo().username
const DSH_BIN = join(HOME, '.local/bin/dsh')
const PATCH = join(HOME, '.dush/cordis.dush.patch.yml')
/** 仓库根(vitest 以项目根为 cwd),用于模拟 `cd <repo> && …` 的 shell 包装行 */
const REPO_ROOT = process.cwd()

/** 当前 dsh CLI 形态:profile 由 `--profile` 指定 */
const DSH_PROFILE_CMD = `node ${DSH_BIN} --patch ${PATCH} --profile web --port 3080 --no-open`
/** 旧形态:web 是位置参数 */
const DSH_WEB_CMD = `node ${DSH_BIN} web --patch ${PATCH} --no-open`

const REAL_PS = [
  '  1     0 /sbin/launchd',
  `  84758  39048 ${DSH_PROFILE_CMD}`,
  `  34325  34320 bash -c cd ${REPO_ROOT} && ps -axo pid=,command= | grep "dsh web"`,
  '  34327  34325 grep dsh web',
  '  9001  37931 node /Applications/DSH Hub.app/Contents/Resources/app.asar/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js --profile default --host 127.0.0.1 --port 30501 --no-open'
].join('\n')

describe('isDshEntryToken(dsh 入口判定)', () => {
  it('PATH 上的 dsh 与 dsh.js 是入口', () => {
    expect(isDshEntryToken('/Users/me/.local/bin/dsh')).toBe(true)
    expect(isDshEntryToken('/Users/me/.local/bin/dsh.js')).toBe(true)
  })

  it('npm 全局包的 bin.js 是入口', () => {
    expect(
      isDshEntryToken('/opt/hub/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js')
    ).toBe(true)
  })

  it('目录名带 dsh 的其它程序不是入口', () => {
    expect(isDshEntryToken('/Users/me/dsh-plugins/dsh-hub-desktop/out/main/index.js')).toBe(false)
    expect(isDshEntryToken('/Users/me/.local/bin/duush')).toBe(false)
    expect(isDshEntryToken('/Users/me/.local/bin/dush')).toBe(false)
  })

  it('Windows 反斜杠形态同样识别', () => {
    expect(isDshEntryToken('C:\\Users\\me\\.local\\bin\\dsh')).toBe(true)
    expect(isDshEntryToken('C:\\opt\\hub\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')).toBe(true)
  })
})

describe('isDshWebCommand(命令行判定)', () => {
  it('识别当前形态:dsh --profile web', () => {
    expect(isDshWebCommand(DSH_PROFILE_CMD)).toBe(true)
  })

  it('识别旧形态:dsh web', () => {
    expect(isDshWebCommand(DSH_WEB_CMD)).toBe(true)
  })

  it('识别 --profile=web 等号写法', () => {
    expect(isDshWebCommand(`node ${DSH_BIN} --profile=web --no-open`)).toBe(true)
  })

  it('识别 dsh 发行版入口形态:@deepseek-ai/dsh/lib/bin.js', () => {
    expect(
      isDshWebCommand(
        'node /opt/hub/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port 52300'
      )
    ).toBe(true)
  })

  it('dush/duush 包装器本身不当可接管对象(端口由它 spawn 的 dsh 持有)', () => {
    expect(isDshWebCommand(`node ${join(HOME, '.local/bin/dush')} --profile web --port 3080`)).toBe(
      false
    )
    expect(
      isDshWebCommand(`node ${join(HOME, '.local/bin/duush')} --profile web --port 3080`)
    ).toBe(false)
  })

  it('排除插件管理命令(Hub 自己执行插件命令也走这个形态)', () => {
    expect(isDshWebCommand(`node ${DSH_BIN} plugin --profile web list`)).toBe(false)
    expect(
      isDshWebCommand(
        'node /opt/hub/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add foo'
      )
    ).toBe(false)
  })

  it('排除非 web profile', () => {
    expect(isDshWebCommand(`node ${DSH_BIN} --profile tui`)).toBe(false)
    expect(isDshWebCommand(`node ${DSH_BIN} --profile desktop`)).toBe(false)
  })

  it('排除 shell/grep 包装(它们把 dsh web 当参数)', () => {
    expect(isDshWebCommand('grep dsh web')).toBe(false)
    expect(isDshWebCommand('bash -c ps -axo pid=,command= | grep "dsh web"')).toBe(false)
    expect(isDshWebCommand('/bin/zsh -lc command -v dsh; dsh --version')).toBe(false)
    expect(isDshWebCommand('/usr/bin/pgrep -f /x/dsh web')).toBe(false)
  })

  it('patch 路径里含 "grep" 不影响识别(按词判定,不是子串)', () => {
    expect(isDshWebCommand('node /x/dsh --profile web --patch /tmp/my-grep.yml')).toBe(true)
  })

  it('patch 路径的 basename 恰是 grep/pgrep 也不影响识别', () => {
    // 取值在 dsh 入口之后,不是命令位置 —— 不能把真的 dsh 误判成 grep 包装行
    expect(isDshWebCommand('node /x/dsh --profile web --patch /home/u/grep')).toBe(true)
    expect(isDshWebCommand('node /x/dsh --profile web --patch /usr/local/bin/pgrep')).toBe(true)
  })

  it('裸名 dsh 只有紧跟在 node 之后才算入口', () => {
    // node dsh → dsh 是入口
    expect(isDshWebCommand('node dsh --profile web --port 3080')).toBe(true)
    expect(isDshWebCommand('node dsh.js --profile web --port 3080')).toBe(true)
    // npm run dsh → dsh 是脚本名,不是入口
    expect(isDshWebCommand('npm run dsh -- --profile web')).toBe(false)
    expect(isDshWebCommand('npm exec dsh -- --profile web')).toBe(false)
  })

  it('排除无关进程与「目录名里带 dsh」的干扰项', () => {
    expect(isDshWebCommand('/usr/sbin/cupsd')).toBe(false)
    expect(
      isDshWebCommand(`node ${join(HOME, 'dsh-plugins/dsh-hub-desktop/out/main/index.js')}`)
    ).toBe(false)
    expect(isDshWebCommand(`node ${DSH_BIN} --version`)).toBe(false)
  })

  it('识别 Windows 路径形态', () => {
    expect(isDshWebCommand('node C:\\Users\\me\\.local\\bin\\dsh web --no-open')).toBe(true)
    expect(isDshWebCommand('node C:\\Users\\me\\.local\\bin\\dsh --profile web --no-open')).toBe(
      true
    )
    expect(isDshWebCommand('C:\\Windows\\system32\\cmd.exe /c dsh --version')).toBe(false)
  })
})

describe('findDshWebArgs(定位 dsh web 调用)', () => {
  it('返回 dsh 入口之后的参数', () => {
    expect(findDshWebArgs(DSH_PROFILE_CMD)).toEqual([
      '--patch',
      PATCH,
      '--profile',
      'web',
      '--port',
      '3080',
      '--no-open'
    ])
  })

  it('不是 dsh web 调用时返回 null', () => {
    expect(findDshWebArgs(`node ${DSH_BIN} --version`)).toBeNull()
    expect(findDshWebArgs('grep dsh web')).toBeNull()
  })
})

describe('patchOf / portOf(参数解析)', () => {
  it('空格与等号两种写法都能取到 --patch', () => {
    expect(patchOf('dsh web --patch /a/b.yml')).toBe('/a/b.yml')
    expect(patchOf('dsh web --patch=/a/b.yml')).toBe('/a/b.yml')
    expect(patchOf('dsh web --no-open')).toBeNull()
  })

  it('-port 取合法端口,非法值返回 null(留给 lsof 兜底)', () => {
    expect(portOf('dsh web --port 52300')).toBe(52300)
    expect(portOf('dsh web --port=3080')).toBe(3080)
    expect(portOf('dsh web --port 99999')).toBeNull()
    expect(portOf('dsh web --no-open')).toBeNull()
  })
})

describe('process-table(进程表解析与祖先链)', () => {
  it('解析 ps 的 pid/ppid/command 三元组', () => {
    const entries = parseProcessTable(REAL_PS)
    expect(entries).toHaveLength(5)
    expect(entries[0]).toEqual({ pid: 1, ppid: 0, command: '/sbin/launchd' })
    expect(entries[1]).toMatchObject({ pid: 84758, ppid: 39048 })
  })

  it('无法解析的行被跳过', () => {
    expect(parseProcessTable('garbage\n\n  1  0 /sbin/launchd')).toHaveLength(1)
    expect(parseProcessTable('')).toEqual([])
  })

  it('解析 Windows CIM 的 pid/ppid/command 制表符分隔行', () => {
    const output = [
      '100\t200\tnode C:\\Users\\me\\.local\\bin\\dsh --profile web',
      '200\t4\tC:\\Windows\\system32\\services.exe',
      '没有制表符的行'
    ].join('\n')
    const entries = parseWindowsProcessTable(output)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      pid: 100,
      ppid: 200,
      command: 'node C:\\Users\\me\\.local\\bin\\dsh --profile web'
    })
  })

  it('收集根进程的全部后代(包装器与其 spawn 的 dsh 两层都在内)', () => {
    const entries = parseProcessTable(
      [
        '100  1   /Applications/DSH Hub.app/Contents/MacOS/DSH Hub',
        '200  100 node --expose-internals /Users/me/.local/bin/duush --profile web',
        '300  200 node /Users/me/.local/bin/dsh --profile web --no-open',
        '400  1   node /Users/me/.local/bin/dsh --profile web --no-open'
      ].join('\n')
    )
    const descendants = collectDescendants(100, entries)
    expect([...descendants].sort((a, b) => a - b)).toEqual([100, 200, 300])
    // 别的树上的进程不受影响
    expect(descendants.has(400)).toBe(false)
  })

  it('父 pid 成环时遍历终止', () => {
    const entries = parseProcessTable('10 20 x\n20 10 y')
    const descendants = collectDescendants(10, entries)
    expect(descendants.has(10)).toBe(true)
    expect(descendants.has(20)).toBe(true)
  })

  it('根 pid 不在进程表里 → 收集不到任何后代(排除规则失效)', () => {
    // Hub 主进程查不到(极少见)时整条排除规则失效,只剩 hubPid 自身。
    // 这条行为写进测试是为了让「失效」可见:managedPids 是它的兜底。
    const entries = parseProcessTable('200 100 node /x/dsh --profile web')
    const descendants = collectDescendants(999, entries)
    expect([...descendants]).toEqual([999])
    expect(descendants.has(200)).toBe(false)
  })

  it('包装器先退出 → dsh 被 init 收养后脱离 Hub 子树', () => {
    // POSIX 下父进程退出后子进程被 pid 1 收养,此时 dsh 不在 Hub 的进程树里,
    // 只靠进程树排除会把它误报成外部实例。
    const entries = parseProcessTable(
      [
        '100  1   /Applications/DSH Hub.app/Contents/MacOS/DSH Hub',
        '300  1   node /x/dsh --profile web'
      ].join('\n')
    )
    const descendants = collectDescendants(100, entries)
    expect(descendants.has(300)).toBe(false)
  })
})

describe('selectDshWebProcesses(挑出 dsh web 进程)', () => {
  it('从真实 ps 输出中只挑出 dsh web 进程,并解析 patch', () => {
    const found = selectDshWebProcesses(parseProcessTable(REAL_PS))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      pid: 84758,
      ppid: 39048,
      patch: PATCH,
      port: 3080
    })
    expect(found[0]?.command).toContain(`${DSH_BIN} --patch`)
  })

  it('同一 pid 只上报一次;空输出返回空数组', () => {
    const entries = parseProcessTable(
      ['1 0 node /x/dsh web', '1 0 node /x/dsh web --patch /p.yml', ''].join('\n')
    )
    expect(selectDshWebProcesses(entries)).toHaveLength(1)
    expect(selectDshWebProcesses([])).toEqual([])
  })

  it('排除 Hub 自己拉起的进程(包装器与其 spawn 的 dsh 两层)', () => {
    const entries = parseProcessTable(
      [
        '100  1   /Applications/DSH Hub.app/Contents/MacOS/DSH Hub',
        '200  100 node --expose-internals /Users/me/.local/bin/duush --profile web --port 3080',
        '300  200 node /Users/me/.local/bin/dsh --profile web --port 3080 --no-open',
        '400  1   node /Users/me/.local/bin/dsh --profile web --port 3080 --no-open'
      ].join('\n')
    )
    const found = selectDshWebProcesses(entries, collectDescendants(100, entries))
    expect(found.map((item) => item.pid)).toEqual([400])
  })

  it('用户自己用 dush/duush 起的工作区:包装器不上报,它 spawn 的 dsh 上报', () => {
    // 包装器自身不是 dsh 入口(它另外开自己的本地服务端口),提供工作区的是它
    // spawn 的那个 dsh 子进程 —— 那个才是可接管对象。
    const entries = parseProcessTable(
      [
        '200  1   node --expose-internals /Users/me/.local/bin/duush --profile web --port 3080',
        '300  200 node /Users/me/.local/bin/dsh --profile web --port 3080 --no-open'
      ].join('\n')
    )
    const found = selectDshWebProcesses(entries, collectDescendants(100, entries))
    expect(found.map((item) => item.pid)).toEqual([300])
  })

  it('命令行里的凭据被脱敏后才上报(不进 DOM)', () => {
    const entries = parseProcessTable(
      ['1 0 node /x/dsh --profile web --token=secret-value --port 3080'].join('\n')
    )
    const found = selectDshWebProcesses(entries)
    expect(found[0]?.command).not.toContain('secret-value')
    expect(found[0]?.command).toContain('--token=***')
  })

  it('超长命令行被截断(供 UI 展示,不撑破布局)', () => {
    const long = `node /x/dsh web --patch /${'a'.repeat(400)}.yml`
    const found = selectDshWebProcesses(parseProcessTable(`1 0 ${long}`))
    expect(found[0]?.command.length).toBeLessThanOrEqual(241)
    expect(found[0]?.command.endsWith('…')).toBe(true)
  })
})

describe('parseListeningPorts(lsof 解析)', () => {
  it('pid → 首个监听端口', () => {
    const output = [
      'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
      `node-darw  4323 ${USER}   38u  IPv4 0x1      0t0  TCP 127.0.0.1:49152 (LISTEN)`,
      `node      84758 ${USER}   21u  IPv4 0x2      0t0  TCP *:3080 (LISTEN)`,
      `node      84758 ${USER}   22u  IPv6 0x3      0t0  TCP *:3081 (LISTEN)`,
      `node      84758 ${USER}   23u  IPv4 0x4      0t0  TCP 127.0.0.1:3080 (ESTABLISHED)`
    ].join('\n')
    const ports = parseListeningPorts(output)
    expect(ports.get(84758)).toBe(3080) // 首个 LISTEN;ESTABLISHED 不算
    expect(ports.get(4323)).toBe(49152)
  })

  it('同一 pid 多条监听:优先回环绑定端口（不取 lsof 先输出的非回环端口）', () => {
    const output = [
      // 非回环端口先出现，回环端口后出现：接管连 127.0.0.1，应选回环那个
      `node 555 ${USER} 20u IPv4 0x1 0t0 TCP *:8080 (LISTEN)`,
      `node 555 ${USER} 21u IPv4 0x2 0t0 TCP 127.0.0.1:3080 (LISTEN)`
    ].join('\n')
    expect(parseListeningPorts(output).get(555)).toBe(3080)
  })
})

describe('parseWindowsListeningPorts(netstat 解析)', () => {
  it('pid → 首个 TCP LISTENING 端口,IPv6/UDP/其他状态被过滤', () => {
    const output = [
      '',
      '活动连接',
      '',
      '  协议  本地地址          外部地址        状态           PID',
      '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       84758',
      '  TCP    [::]:3080              [::]:0                 LISTENING       84758',
      '  TCP    127.0.0.1:49152        127.0.0.1:52300        ESTABLISHED     4323',
      '  UDP    0.0.0.0:5353           *:*                                    900',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234'
    ].join('\n')
    const ports = parseWindowsListeningPorts(output)
    expect(ports.get(84758)).toBe(3080) // 首个 LISTENING;ESTABLISHED 不算
    expect(ports.get(1234)).toBe(135)
    expect(ports.get(4323)).toBeUndefined()
    expect(ports.get(900)).toBeUndefined() // UDP 无状态列
  })

  it('同一 pid 多条监听:优先回环绑定端口', () => {
    const output = [
      '  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       555',
      '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       555'
    ].join('\n')
    expect(parseWindowsListeningPorts(output).get(555)).toBe(3080)
  })

  it('pid 无监听端口 → scan 返回 port=null', async () => {
    const scanner = createExternalDshScanner({
      hubPid: 100,
      platform: 'win32',
      run: async (command) => {
        if (command === 'powershell.exe') {
          return {
            code: 0,
            stdout: `84758\t1\tnode C:\\Users\\me\\.local\\bin\\dsh --profile web --no-open\n`
          }
        }
        return {
          code: 0,
          stdout: '  TCP    127.0.0.1:135           0.0.0.0:0              LISTENING       999\n'
        }
      }
    })
    await expect(scanner.scan()).resolves.toEqual([
      {
        pid: 84758,
        ppid: 1,
        port: null,
        patch: null,
        command: 'node C:\\Users\\me\\.local\\bin\\dsh --profile web --no-open'
      }
    ])
  })

  it('PowerShell 查询脚本把命令行内的换行/制表符折叠成空格', () => {
    // Win32_Process.CommandLine 原样保留 `-e` 脚本里的换行:条目一旦断行,
    // `dsh web` 参数会落在无 pid 的续行上,被逐行解析器丢弃(POSIX 的 ps 会自行折叠)
    expect(WIN_PROCESS_SCRIPT).toContain('[char]9')
    expect(WIN_PROCESS_SCRIPT).toContain("-replace '[\\r\\n\\t]+', ' '")
  })

  it('win32 分支由 netstat 确认端口', async () => {
    const scanner = createExternalDshScanner({
      hubPid: 100,
      platform: 'win32',
      run: async (command) => {
        if (command === 'powershell.exe') {
          return {
            code: 0,
            stdout: `84758\t1\tC:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web --port 3080\n`
          }
        }
        return {
          code: 0,
          stdout: '  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       84758\n'
        }
      }
    })
    await expect(scanner.scan()).resolves.toEqual([
      {
        pid: 84758,
        ppid: 1,
        port: 3080,
        patch: null,
        command:
          'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web --port 3080'
      }
    ])
  })
})

describe('createExternalDshScanner(注入 IO)', () => {
  it('ps 找到进程且命令行无 --port → 用 lsof 补端口', async () => {
    const scanner = createExternalDshScanner({
      hubPid: 100,
      platform: 'linux',
      run: async (command) => {
        if (command === 'ps') {
          return {
            code: 0,
            stdout: `  84758 1 ${DSH_PROFILE_CMD}\n`
          }
        }
        return { code: 0, stdout: `node 84758 ${USER} 21u IPv4 0x2 0t0 TCP *:3080 (LISTEN)\n` }
      }
    })
    await expect(scanner.scan()).resolves.toEqual([
      {
        pid: 84758,
        ppid: 1,
        port: 3080,
        patch: PATCH,
        command: DSH_PROFILE_CMD
      }
    ])
  })

  it('命令行带 --port 时仍由 lsof 确认 PID 的监听端口', async () => {
    const calls: string[] = []
    const scanner = createExternalDshScanner({
      hubPid: 100,
      platform: 'linux',
      run: async (command) => {
        calls.push(command)
        if (command === 'ps')
          return { code: 0, stdout: '1 1 node /x/dsh --profile web --port 52300\n' }
        return { code: 0, stdout: 'node 1 user 21u IPv4 0x2 0t0 TCP 127.0.0.1:52301 (LISTEN)\n' }
      }
    })
    const found = await scanner.scan()
    expect(found[0]?.port).toBe(52301)
    expect(calls).toEqual(['ps', 'lsof'])
  })

  it('命令行端口没有对应的 PID 监听 socket 时不返回可打开端口', async () => {
    const scanner = createExternalDshScanner({
      hubPid: 100,
      platform: 'linux',
      run: async (command) =>
        command === 'ps'
          ? { code: 0, stdout: '1 1 node /x/dsh --profile web --port 52300\n' }
          : { code: 0, stdout: 'node 2 user 21u IPv4 0x2 0t0 TCP 127.0.0.1:52300 (LISTEN)\n' }
    })
    await expect(scanner.scan()).resolves.toMatchObject([{ pid: 1, port: null }])
  })

  it('ps 失败 / lsof 失败都退化为空数组或 null 端口,不抛异常', async () => {
    const failing = createExternalDshScanner({
      hubPid: 100,
      platform: 'linux',
      run: async () => {
        throw new Error('ps not available')
      }
    })
    await expect(failing.scan()).resolves.toEqual([])

    const lsofFails = createExternalDshScanner({
      hubPid: 100,
      platform: 'linux',
      run: async (command) => {
        if (command === 'ps') return { code: 0, stdout: '1 1 node /x/dsh --profile web\n' }
        throw new Error('lsof failed')
      }
    })
    await expect(lsofFails.scan()).resolves.toEqual([
      { pid: 1, ppid: 1, port: null, patch: null, command: 'node /x/dsh --profile web' }
    ])
  })

  it('没有 dsh web 进程时返回空数组', async () => {
    const scanner = createExternalDshScanner({
      hubPid: 100,
      platform: 'linux',
      run: async () => ({ code: 0, stdout: '1 0 /sbin/launchd\n2 1 node /x/other.js\n' })
    })
    await expect(scanner.scan()).resolves.toEqual([])
  })

  it('win32 进程查询失败时返回空数组,不抛异常', async () => {
    const scanner = createExternalDshScanner({
      hubPid: 100,
      platform: 'win32',
      run: async () => {
        throw new Error('powershell 不可用')
      }
    })
    await expect(scanner.scan()).resolves.toEqual([])
  })

  it('Hub 自己拉起的实例不上报为外部实例', async () => {
    const scanner = createExternalDshScanner({
      platform: 'linux',
      hubPid: 100,
      run: async (command) => {
        if (command === 'ps') {
          // Hub(100) → duush 包装器(200) → dsh(300)：三层都在 Hub 子树里
          return {
            code: 0,
            stdout: [
              '100 1   /Applications/DSH Hub.app/Contents/MacOS/DSH Hub',
              '200 100 node --expose-internals /Users/me/.local/bin/duush --profile web --port 3080',
              '300 200 node /Users/me/.local/bin/dsh --profile web --port 3080 --no-open'
            ].join('\n')
          }
        }
        return { code: 0, stdout: '' }
      }
    })
    await expect(scanner.scan()).resolves.toEqual([])
  })

  it('用户自己拉起的 dsh 与 Hub 托管的实例可区分', async () => {
    const scanner = createExternalDshScanner({
      platform: 'linux',
      hubPid: 100,
      run: async (command) => {
        if (command === 'ps') {
          return {
            code: 0,
            stdout: [
              '100 1   /Applications/DSH Hub.app/Contents/MacOS/DSH Hub',
              '200 100 node --expose-internals /Users/me/.local/bin/duush --profile web --port 3080',
              '300 200 node /Users/me/.local/bin/dsh --profile web --port 3080 --no-open',
              '400 1   node /Users/me/.local/bin/dsh --profile web --port 3081 --no-open'
            ].join('\n')
          }
        }
        return {
          code: 0,
          stdout: 'node 400 user 21u IPv4 0x2 0t0 TCP 127.0.0.1:3081 (LISTEN)\n'
        }
      }
    })
    const found = await scanner.scan()
    expect(found.map((item) => item.pid)).toEqual([400])
    expect(found[0]?.port).toBe(3081)
  })

  it('包装器先退出、dsh 被 init 收养 → 按托管端口兜住,仍不上报', async () => {
    // 进程树只认「包装器还活着」的情形;包装器退出后 dsh 的 ppid 变成 1,
    // 脱离 Hub 子树。Hub 托管实例的端口就是这条缝的兜底。
    const scanner = createExternalDshScanner({
      platform: 'linux',
      hubPid: 100,
      managedPorts: () => [3080],
      run: async (command) => {
        if (command === 'ps') {
          return {
            code: 0,
            stdout: [
              '100 1   /Applications/DSH Hub.app/Contents/MacOS/DSH Hub',
              '300 1   node /Users/me/.local/bin/dsh --profile web --port 3080 --no-open'
            ].join('\n')
          }
        }
        return {
          code: 0,
          stdout: 'node 300 user 21u IPv4 0x2 0t0 TCP 127.0.0.1:3080 (LISTEN)\n'
        }
      }
    })
    await expect(scanner.scan()).resolves.toEqual([])
  })

  it('托管端口上的 dsh 不上报,别的端口照常上报', async () => {
    const scanner = createExternalDshScanner({
      platform: 'linux',
      hubPid: 100,
      managedPorts: () => [3080],
      run: async (command) => {
        if (command === 'ps') {
          return {
            code: 0,
            stdout: [
              '300 1   node /Users/me/.local/bin/dsh --profile web --port 3080 --no-open',
              '400 1   node /Users/me/.local/bin/dsh --profile web --port 3090 --no-open'
            ].join('\n')
          }
        }
        return {
          code: 0,
          stdout: [
            'node 300 user 21u IPv4 0x2 0t0 TCP 127.0.0.1:3080 (LISTEN)',
            'node 400 user 22u IPv4 0x3 0t0 TCP 127.0.0.1:3090 (LISTEN)'
          ].join('\n')
        }
      }
    })
    const found = await scanner.scan()
    expect(found.map((item) => item.pid)).toEqual([400])
  })

  it('接管进来的外部实例不算「Hub 托管」→ 仍能被再次识别', async () => {
    // 接管后的实例在 hub 侧 child 为 null,端口也不在 managedPorts 里;
    // 详情页的接管卡片靠扫描结果出现,排除掉它就再也接管不了。
    const scanner = createExternalDshScanner({
      platform: 'linux',
      hubPid: 100,
      managedPorts: () => [],
      run: async (command) => {
        if (command === 'ps') {
          return {
            code: 0,
            stdout: '300 1   node /tmp/fake-dsh/dsh --profile web --no-open'
          }
        }
        return {
          code: 0,
          stdout: 'node 300 user 21u IPv4 0x2 0t0 TCP 127.0.0.1:60158 (LISTEN)\n'
        }
      }
    })
    const found = await scanner.scan()
    expect(found.map((item) => item.pid)).toEqual([300])
    expect(found[0]?.port).toBe(60158)
  })
})
