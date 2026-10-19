import { describe, expect, it } from 'vitest'
import { isEmptyPatch, runtimeWritebackPatch } from './runtime-writeback'

/**
 * 与「空补丁」边界。
 */
describe('runtimeWritebackPatch(运行信息回写决策)', () => {
  it('hub 来源:端口与版本都回写(local)', () => {
    const patch = runtimeWritebackPatch(
      { port: 30501, version: '0.1.5', runtimeSource: 'hub' },
      'local'
    )
    expect(patch).toEqual({ port: 30501, dshVersion: '0.1.5' })
  })

  it('ssh 传输:端口写 localPort(隧道本地口),不是 port', () => {
    const patch = runtimeWritebackPatch(
      { port: 41111, version: '0.1.5', runtimeSource: 'hub' },
      'ssh'
    )
    expect(patch).toEqual({ localPort: 41111, dshVersion: '0.1.5' })
  })

  it('PATH 来源不回写版本，但会回写端口', () => {
    const patch = runtimeWritebackPatch(
      { port: 52300, version: '0.1.5-rc.2', runtimeSource: 'path' },
      'local'
    )
    expect(patch).toEqual({ port: 52300 })
  })

  it('external 接管:端口与版本都不回写', () => {
    const patch = runtimeWritebackPatch({ port: 3080, runtimeSource: 'external' }, 'local')
    expect(patch).toEqual({})
    expect(isEmptyPatch(patch)).toBe(true)
  })

  it('external 重复接管(带空版本串):仍是空补丁,不得落到 store', () => {
    const patch = runtimeWritebackPatch(
      { port: 3080, version: '', runtimeSource: 'external' },
      'local'
    )
    expect(patch).toEqual({})
    expect(isEmptyPatch(patch)).toBe(true)
  })

  it('只有端口没有版本(hub 首启早期事件)→ 只回写端口', () => {
    expect(runtimeWritebackPatch({ port: 30001 }, 'local')).toEqual({ port: 30001 })
  })

  it('只有版本没有端口 → 只回写版本', () => {
    expect(runtimeWritebackPatch({ version: '0.1.5', runtimeSource: 'hub' }, 'local')).toEqual({
      dshVersion: '0.1.5'
    })
  })

  it('空版本串不被当成有效版本(写出空串会把版本「清空」)', () => {
    expect(runtimeWritebackPatch({ version: '' }, 'local')).toEqual({})
  })

  it('既无端口也无版本(如 stopped 事件)→ 空补丁', () => {
    expect(runtimeWritebackPatch({}, 'local')).toEqual({})
    expect(isEmptyPatch(runtimeWritebackPatch({}, undefined))).toBe(true)
  })

  it('transport 未知(记录已被删除)→ 端口按普通字段回写,不误写 localPort', () => {
    expect(runtimeWritebackPatch({ port: 30002 }, undefined)).toEqual({ port: 30002 })
  })

  it('启动命令:本机且非外部接管时回写 runCommand(PATH 来源同样)', () => {
    const command = '/Users/me/.local/bin/dsh --profile web --port 3080 --no-open'
    expect(
      runtimeWritebackPatch(
        { port: 3080, version: '0.1.5', command, runtimeSource: 'hub' },
        'local'
      )
    ).toEqual({ port: 3080, dshVersion: '0.1.5', runCommand: command })
    expect(runtimeWritebackPatch({ port: 3080, command, runtimeSource: 'path' }, 'local')).toEqual({
      port: 3080,
      runCommand: command
    })
  })

  it('启动命令:外部接管、非本机实例与空串都不回写', () => {
    expect(
      runtimeWritebackPatch(
        { port: 3080, command: '/tmp/dsh --profile web', runtimeSource: 'external' },
        'local'
      )
    ).toEqual({})
    expect(
      runtimeWritebackPatch({ command: '/tmp/dsh --profile web', runtimeSource: 'hub' }, 'ssh')
    ).toEqual({})
    expect(runtimeWritebackPatch({ command: '' }, 'local')).toEqual({})
  })
})
