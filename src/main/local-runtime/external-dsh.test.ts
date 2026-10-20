import { describe, expect, it } from 'vitest'
import { createExternalDshScanner } from './external-dsh'
import { DSH_PROFILE_CMD, PATCH, USER, windowsProcessLine } from './external-dsh.testkit'

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

describe('createExternalDshScanner(win32 分支)', () => {
  it('pid 无监听端口 → scan 返回 port=null', async () => {
    const scanner = createExternalDshScanner({
      hubPid: 100,
      platform: 'win32',
      run: async (command) => {
        if (command === 'powershell.exe') {
          return {
            code: 0,
            stdout: `${windowsProcessLine(84758, 1, 'node C:\\Users\\me\\.local\\bin\\dsh --profile web --no-open')}\n`
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

  it('win32 分支由 netstat 确认端口', async () => {
    const scanner = createExternalDshScanner({
      hubPid: 100,
      platform: 'win32',
      run: async (command) => {
        if (command === 'powershell.exe') {
          return {
            code: 0,
            stdout: `${windowsProcessLine(84758, 1, 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js --profile web --port 3080')}\n`
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
})
