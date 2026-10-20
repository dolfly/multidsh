import { describe, expect, it } from 'vitest'
import { collectDescendants, parseProcessTable, WIN_PROCESS_SCRIPT } from './process-table'
import { REAL_PS, windowsProcessLine } from './external-dsh.testkit'

describe('parseProcessTable(进程表解析)', () => {
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
    // Windows 的 CIM 脚本用制表符分隔字段;同一行正则也覆盖它
    const output = [
      windowsProcessLine(100, 200, 'node C:\\Users\\me\\.local\\bin\\dsh --profile web'),
      windowsProcessLine(200, 4, 'C:\\Windows\\system32\\services.exe'),
      '没有制表符的行'
    ].join('\n')
    const entries = parseProcessTable(output)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      pid: 100,
      ppid: 200,
      command: 'node C:\\Users\\me\\.local\\bin\\dsh --profile web'
    })
  })

  it('命令行缺失的行被跳过(Windows 上 CommandLine 为 NULL 的进程)', () => {
    // 那类进程不是 dsh 入口,也不参与判定
    expect(parseProcessTable('1234\t567\t')).toEqual([])
  })
})

describe('collectDescendants(祖先链)', () => {
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
        '300  1   node /x/dsh --profile web --no-open'
      ].join('\n')
    )
    const descendants = collectDescendants(100, entries)
    expect(descendants.has(300)).toBe(false)
  })
})

describe('WIN_PROCESS_SCRIPT(Windows 进程查询脚本)', () => {
  it('把命令行内的换行/制表符折叠成空格', () => {
    // Win32_Process.CommandLine 原样保留 `-e` 脚本里的换行:条目一旦断行,
    // `dsh web` 参数会落在无 pid 的续行上,被逐行解析器丢弃(POSIX 的 ps 会自行折叠)
    expect(WIN_PROCESS_SCRIPT).toContain('[char]9')
    expect(WIN_PROCESS_SCRIPT).toContain("-replace '[\\r\\n\\t]+', ' '")
  })

  it('不按命令行过滤 —— 祖先链必须完整', () => {
    // 只回传含特定关键字的进程会让中间那层缺失,它的子孙接不回 Hub 主进程,
    // Hub 自己的实例反而会被当成外部实例上报。
    expect(WIN_PROCESS_SCRIPT).toContain('Get-CimInstance Win32_Process')
    expect(WIN_PROCESS_SCRIPT).not.toMatch(/Where-Object/)
  })
})
