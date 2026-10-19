import { describe, expect, it } from 'vitest'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  createExternalDshScanner,
  isDshWebCommand,
  parseDshWebProcesses,
  parseListeningPorts,
  parseWindowsListeningPorts,
  patchOf,
  portOf,
  WIN_PROCESS_SCRIPT
} from './external-dsh'

/**
 *   node ~/.local/bin/dsh web --patch ~/.dush/cordis.dush.patch.yml --no-open
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
const DSH_WEB_CMD = `node ${DSH_BIN} web --patch ${PATCH} --no-open`

const REAL_PS = [
  '  1 /sbin/launchd',
  `  84758 ${DSH_WEB_CMD}`,
  `  34325 bash -c cd ${REPO_ROOT} && ps -axo pid=,command= | grep "dsh web"`,
  '  34327 grep dsh web',
  '  9001 node /Applications/DSH Hub.app/Contents/Resources/app.asar/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js --profile default --host 127.0.0.1 --port 30501 --no-open'
].join('\n')

describe('isDshWebCommand(命令行判定)', () => {
  it('识别真实 dush 形态:dsh web --patch …', () => {
    expect(isDshWebCommand(DSH_WEB_CMD)).toBe(true)
  })

  it('识别 hub 运行时入口形态:@deepseek-ai/dsh/lib/bin.js web', () => {
    expect(
      isDshWebCommand(
        'node /opt/hub/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 52300'
      )
    ).toBe(true)
  })

  it('排除 shell/grep 包装(它们把 dsh web 当参数)', () => {
    expect(isDshWebCommand('grep dsh web')).toBe(false)
    expect(isDshWebCommand('bash -c ps -axo pid=,command= | grep "dsh web"')).toBe(false)
    expect(isDshWebCommand('/bin/zsh -lc command -v dsh; dsh --version')).toBe(false)
  })

  it('排除 hub 自己 spawn 的进程(无 web 子命令)', () => {
    expect(
      isDshWebCommand(
        'node /…/runtimes/0.1.5/node_modules/@deepseek-ai/dsh/lib/bin.js --profile default --host 127.0.0.1 --port 30501 --no-open'
      )
    ).toBe(false)
  })

  it('排除无关进程与「目录名里带 dsh」的干扰项', () => {
    expect(isDshWebCommand('/usr/sbin/cupsd')).toBe(false)
    expect(
      isDshWebCommand(`node ${join(HOME, 'dsh-plugins/dsh-hub-desktop/out/main/index.js')}`)
    ).toBe(false)
    expect(isDshWebCommand(`node ${DSH_BIN} --version`)).toBe(false)
  })

  it('识别 Windows 路径形态:\\dsh web 与 @deepseek-ai\\dsh\\lib\\bin.js web', () => {
    expect(isDshWebCommand('node C:\\Users\\me\\.local\\bin\\dsh web --no-open')).toBe(true)
    expect(
      isDshWebCommand(
        'node C:\\opt\\hub\\runtimes\\0.1.5\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 52300'
      )
    ).toBe(true)
    expect(isDshWebCommand('C:\\Windows\\system32\\cmd.exe /c dsh --version')).toBe(false)
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

describe('parseDshWebProcesses(ps 解析)', () => {
  it('从真实 ps 输出中只挑出 dsh web 进程,并解析 patch', () => {
    const found = parseDshWebProcesses(REAL_PS)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      pid: 84758,
      patch: PATCH,
      port: null // 命令行没写 --port → 交 lsof 兜底
    })
    // DSH_BIN 由 join 生成(Windows 下为反斜杠),REAL_PS 用同一变量构造,直接比对
    expect(found[0]?.command).toContain(`${DSH_BIN} web`)
  })

  it('同一 pid 只上报一次;空输出返回空数组', () => {
    const dup = parseDshWebProcesses(
      ['1 node /x/dsh web', '1 node /x/dsh web --patch /p.yml', ''].join('\n')
    )
    expect(dup).toHaveLength(1)
    expect(parseDshWebProcesses('')).toEqual([])
  })

  it('超长命令行被截断(供 UI 展示,不撑破布局)', () => {
    const long = `node /x/dsh web --patch /${'a'.repeat(400)}.yml`
    const found = parseDshWebProcesses(`1 ${long}`)
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
      platform: 'win32',
      run: async (command) => {
        if (command === 'powershell.exe') {
          return { code: 0, stdout: `84758\tnode C:\\Users\\me\\.local\\bin\\dsh web --no-open\n` }
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
        port: null,
        patch: null,
        command: 'node C:\\Users\\me\\.local\\bin\\dsh web --no-open'
      }
    ])
  })

  it('PowerShell 查询脚本把命令行内的换行/制表符折叠成空格', () => {
    // Win32_Process.CommandLine 原样保留 `-e` 脚本里的换行:条目一旦断行,
    // `dsh web` 参数会落在无 pid 的续行上,被逐行解析器丢弃(POSIX 的 ps 会自行折叠)
    expect(WIN_PROCESS_SCRIPT).toContain('[char]9')
    expect(WIN_PROCESS_SCRIPT).toContain("-replace '[\\r\\n\\t]+'")
  })

  it('win32 分支由 netstat 确认端口', async () => {
    const scanner = createExternalDshScanner({
      platform: 'win32',
      run: async (command) => {
        if (command === 'powershell.exe') {
          return {
            code: 0,
            stdout: `84758\tC:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 3080\n`
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
        port: 3080,
        patch: null,
        command:
          'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js web --port 3080'
      }
    ])
  })
})

describe('createExternalDshScanner(注入 IO)', () => {
  it('ps 找到进程且命令行无 --port → 用 lsof 补端口', async () => {
    const scanner = createExternalDshScanner({
      platform: 'linux',
      run: async (command) => {
        if (command === 'ps') {
          return {
            code: 0,
            stdout: `  84758 ${DSH_WEB_CMD}\n`
          }
        }
        return { code: 0, stdout: `node 84758 ${USER} 21u IPv4 0x2 0t0 TCP *:3080 (LISTEN)\n` }
      }
    })
    await expect(scanner.scan()).resolves.toEqual([
      {
        pid: 84758,
        port: 3080,
        patch: PATCH,
        command: DSH_WEB_CMD
      }
    ])
  })

  it('命令行带 --port 时仍由 lsof 确认 PID 的监听端口', async () => {
    const calls: string[] = []
    const scanner = createExternalDshScanner({
      platform: 'linux',
      run: async (command) => {
        calls.push(command)
        if (command === 'ps') return { code: 0, stdout: '1 node /x/dsh web --port 52300\n' }
        return { code: 0, stdout: 'node 1 user 21u IPv4 0x2 0t0 TCP 127.0.0.1:52301 (LISTEN)\n' }
      }
    })
    const found = await scanner.scan()
    expect(found[0]?.port).toBe(52301)
    expect(calls).toEqual(['ps', 'lsof'])
  })

  it('命令行端口没有对应的 PID 监听 socket 时不返回可打开端口', async () => {
    const scanner = createExternalDshScanner({
      platform: 'linux',
      run: async (command) =>
        command === 'ps'
          ? { code: 0, stdout: '1 node /x/dsh web --port 52300\n' }
          : { code: 0, stdout: 'node 2 user 21u IPv4 0x2 0t0 TCP 127.0.0.1:52300 (LISTEN)\n' }
    })
    await expect(scanner.scan()).resolves.toMatchObject([{ pid: 1, port: null }])
  })

  it('ps 失败 / lsof 失败都退化为空数组或 null 端口,不抛异常', async () => {
    const failing = createExternalDshScanner({
      platform: 'linux',
      run: async () => {
        throw new Error('ps not available')
      }
    })
    await expect(failing.scan()).resolves.toEqual([])

    const lsofFails = createExternalDshScanner({
      platform: 'linux',
      run: async (command) => {
        if (command === 'ps') return { code: 0, stdout: '1 node /x/dsh web\n' }
        throw new Error('lsof failed')
      }
    })
    await expect(lsofFails.scan()).resolves.toEqual([
      { pid: 1, port: null, patch: null, command: 'node /x/dsh web' }
    ])
  })

  it('没有 dsh web 进程时返回空数组', async () => {
    const scanner = createExternalDshScanner({
      platform: 'linux',
      run: async () => ({ code: 0, stdout: '1 /sbin/launchd\n2 node /x/other.js\n' })
    })
    await expect(scanner.scan()).resolves.toEqual([])
  })

  it('win32 进程查询失败时返回空数组,不抛异常', async () => {
    const scanner = createExternalDshScanner({
      platform: 'win32',
      run: async () => {
        throw new Error('powershell 不可用')
      }
    })
    await expect(scanner.scan()).resolves.toEqual([])
  })
})
