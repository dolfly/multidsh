import { describe, expect, it } from 'vitest'
import { selectDshWebProcesses } from './dsh-processes'
import { collectDescendants, parseProcessTable } from './process-table'
import { DSH_BIN, PATCH, REAL_PS } from './external-dsh.testkit'

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
