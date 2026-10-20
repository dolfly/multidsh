import { describe, expect, it } from 'vitest'
import { selectExternalWorkspaces } from './external-selection'
import type { ExternalWorkspace } from './types'

const ws = (pid: number, port: number): ExternalWorkspace => ({
  pid,
  port,
  patch: null,
  command: `node /x/dsh --profile web --port ${port}`
})

describe('selectExternalWorkspaces(向导里选哪个外部 dsh)', () => {
  it('只有一个候选时直接选它', () => {
    expect(selectExternalWorkspaces([ws(1, 3080)], []).map((item) => item.pid)).toEqual([1])
  })

  it('注册表里已有的本机实例优先被选中', () => {
    const candidates = [ws(1, 3080), ws(2, 30900)]
    // 注册表里已有 127.0.0.1:30900 的本机实例 → 应选它,不按端口大小
    const known = [{ transport: 'local' as const, address: '127.0.0.1:30900' }]
    expect(selectExternalWorkspaces(candidates, known)[0]?.pid).toBe(2)
  })

  it('都不在注册表里时取端口最小的(不依赖扫描返回顺序)', () => {
    const a = ws(1, 30900)
    const b = ws(2, 3080)
    expect(selectExternalWorkspaces([a, b], [])[0]?.pid).toBe(2)
    expect(selectExternalWorkspaces([b, a], [])[0]?.pid).toBe(2)
  })

  it('非本机传输的实例不参与优先判定', () => {
    const candidates = [ws(1, 3080), ws(2, 30900)]
    // ssh/http 实例的地址不参与「本机实例优先」判定
    const known = [
      { transport: 'ssh' as const, address: '127.0.0.1:30900' },
      { transport: 'http' as const, address: '127.0.0.1:30900' }
    ]
    expect(selectExternalWorkspaces(candidates, known)[0]?.pid).toBe(1)
  })

  it('排序不改动传入的数组(避免改掉 React state 的顺序)', () => {
    const candidates = [ws(1, 30900), ws(2, 3080)]
    selectExternalWorkspaces(candidates, [])
    expect(candidates.map((item) => item.pid)).toEqual([1, 2])
  })

  it('空候选返回空数组', () => {
    expect(selectExternalWorkspaces([], [])).toEqual([])
  })
})
