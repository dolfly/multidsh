import { describe, expect, it } from 'vitest'
import { diffEnvironment, emptyEnvironmentDiff, type EnvSnapshot } from './env-diff'

function snapshot(path: string | null, env: Record<string, string> | null): EnvSnapshot {
  return { path, env: env === null ? null : new Map(Object.entries(env)) }
}

describe('diffEnvironment（登录环境刷新前后差异）', () => {
  // 夹具里的 PATH 用 `:` 拼的 POSIX 形态，必须显式传 darwin/linux：
  // 缺省按 process.platform 选分隔符，在 Windows CI 上整串会被当成一个条目。
  it('PATH 按条目集合对比：只列新增项，顺序调整不算变化', () => {
    const before = snapshot('/usr/bin:/opt/homebrew/bin', null)

    const added = diffEnvironment(
      before,
      snapshot('/usr/bin:/opt/homebrew/bin:/usr/local/bin', null),
      'darwin'
    )
    expect(added.pathComparable).toBe(true)
    expect(added.pathAdded).toEqual(['/usr/local/bin'])
    expect(added.pathRemoved).toEqual([])

    const removed = diffEnvironment(before, snapshot('/usr/bin', null), 'darwin')
    expect(removed.pathRemoved).toEqual(['/opt/homebrew/bin'])
    expect(removed.pathAdded).toEqual([])

    const reordered = diffEnvironment(
      before,
      snapshot('/opt/homebrew/bin:/usr/bin', null),
      'darwin'
    )
    expect(reordered.pathAdded).toEqual([])
    expect(reordered.pathRemoved).toEqual([])
  })

  it('win32 用 ; 分隔，比较时统一斜杠并忽略大小写（与 mergeLoginPath 同口径）', () => {
    const before = snapshot('C:\\Windows;C:\\Tools', null)
    const after = snapshot('C:\\Windows;c:/tools;D:\\New', null)
    const diff = diffEnvironment(before, after, 'win32')
    expect(diff.pathAdded).toEqual(['D:\\New'])
    expect(diff.pathRemoved).toEqual([])
  })

  it('变量只回传名字（新增/删除/变更），PATH 不在变量里重复计数', () => {
    const before = snapshot('/a', { PATH: '/a', HTTP_PROXY: 'http://old', KEEP: '1' })
    const after = snapshot('/a:/b', { PATH: '/a:/b', HTTP_PROXY: 'http://new', NEW_VAR: 'x' })
    const diff = diffEnvironment(before, after, 'darwin')
    expect(diff.varsComparable).toBe(true)
    expect(diff.varsAdded).toEqual(['NEW_VAR'])
    expect(diff.varsRemoved).toEqual(['KEEP'])
    expect(diff.varsChanged).toEqual(['HTTP_PROXY'])
    expect(diff.pathAdded).toEqual(['/b'])
    // 差异对象只有名字与条目，没有任何 value 字段可携带变量值。
    expect(Object.keys(diff).sort()).toEqual([
      'pathAdded',
      'pathComparable',
      'pathRemoved',
      'varsAdded',
      'varsChanged',
      'varsComparable',
      'varsRemoved'
    ])
  })

  it('任一侧解析失败 → 该侧不可比且列表为空；两侧各自独立判定', () => {
    // 基线侧整体不可用：PATH 与变量都不可比，所有列表为空
    const unavailable = diffEnvironment({ path: null, env: null }, snapshot('/a', { X: '1' }))
    expect(unavailable.pathComparable).toBe(false)
    expect(unavailable.varsComparable).toBe(false)
    expect(unavailable.pathAdded).toEqual([])
    expect(unavailable.pathRemoved).toEqual([])
    expect(unavailable.varsAdded).toEqual([])
    expect(unavailable.varsRemoved).toEqual([])
    expect(unavailable.varsChanged).toEqual([])

    // PATH 不可比、变量可比：两组开关各自独立
    const mixed = diffEnvironment(
      { path: null, env: new Map() },
      { path: '/a', env: new Map([['Y', '1']]) }
    )
    expect(mixed.pathComparable).toBe(false)
    expect(mixed.varsComparable).toBe(true)
    expect(mixed.varsAdded).toEqual(['Y'])
  })

  it('emptyEnvironmentDiff 全空且两侧都不可比', () => {
    expect(emptyEnvironmentDiff()).toEqual({
      pathComparable: false,
      varsComparable: false,
      pathAdded: [],
      pathRemoved: [],
      varsAdded: [],
      varsRemoved: [],
      varsChanged: []
    })
  })
})
