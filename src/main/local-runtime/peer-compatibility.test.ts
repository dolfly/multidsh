import { describe, expect, it } from 'vitest'
import { dshPeerRange, evaluateDshPeers, githubUrlFrom, isDshPeerName, npmUrlFrom, satisfiesDshPeer } from './peer-compatibility'

describe('satisfiesDshPeer', () => {
  it('空/缺省范围视为无约束', () => {
    expect(satisfiesDshPeer(null, '0.1.7-rc.2')).toBe(true)
    expect(satisfiesDshPeer('', '0.1.7-rc.2')).toBe(true)
    expect(satisfiesDshPeer('*', '0.1.7-rc.2')).toBe(true)
  })

  it('范围非空但当前版本未知 → 不满足（宁可报不兼容）', () => {
    expect(satisfiesDshPeer('>=0.1.7-rc.2', null)).toBe(false)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '')).toBe(false)
  })

  it('>= 下限：prerelease 参与比较', () => {
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.7-rc.2')).toBe(true)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.7-rc.3')).toBe(true)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.7')).toBe(true)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.7-rc.1')).toBe(false)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.6')).toBe(false)
  })

  it('> < <= = 运算符', () => {
    expect(satisfiesDshPeer('>0.1.6', '0.1.7')).toBe(true)
    expect(satisfiesDshPeer('>0.1.7', '0.1.7')).toBe(false)
    expect(satisfiesDshPeer('<0.2.0', '0.1.9')).toBe(true)
    expect(satisfiesDshPeer('<=0.1.7', '0.1.7')).toBe(true)
    expect(satisfiesDshPeer('=0.1.7', '0.1.7')).toBe(true)
    expect(satisfiesDshPeer('=0.1.7', '0.1.8')).toBe(false)
  })

  it('裸版本按精确相等', () => {
    expect(satisfiesDshPeer('0.1.7', '0.1.7')).toBe(true)
    expect(satisfiesDshPeer('0.1.7', '0.1.8')).toBe(false)
  })

  it('caret ^ 范围', () => {
    expect(satisfiesDshPeer('^0.1.7', '0.1.9')).toBe(true)
    expect(satisfiesDshPeer('^0.1.7', '0.2.0')).toBe(false)
    expect(satisfiesDshPeer('^1.2.0', '1.9.9')).toBe(true)
    expect(satisfiesDshPeer('^1.2.0', '2.0.0')).toBe(false)
    expect(satisfiesDshPeer('^1.2.0', '1.1.0')).toBe(false)
  })

  it('caret 0.x 段数差异：^0 / ^0.0 / ^0.0.3 / ^0.x 上界各异（npm semver 语义）', () => {
    // ^0 := >=0.0.0 <1.0.0（dsh 为 0.x 时声明 ^0 = 任意 0.x，不应被误拦）
    expect(satisfiesDshPeer('^0', '0.1.9')).toBe(true)
    expect(satisfiesDshPeer('^0', '0.0.1')).toBe(true)
    expect(satisfiesDshPeer('^0', '1.0.0')).toBe(false)
    // ^0.0 := >=0.0.0 <0.1.0
    expect(satisfiesDshPeer('^0.0', '0.0.9')).toBe(true)
    expect(satisfiesDshPeer('^0.0', '0.1.0')).toBe(false)
    // ^0.0.3 := >=0.0.3 <0.0.4
    expect(satisfiesDshPeer('^0.0.3', '0.0.3')).toBe(true)
    expect(satisfiesDshPeer('^0.0.3', '0.0.4')).toBe(false)
    // ^0.x := >=0.0.0 <1.0.0（通配 minor 覆盖任意 0.x）
    expect(satisfiesDshPeer('^0.x', '0.2.0')).toBe(true)
    expect(satisfiesDshPeer('^0.x', '1.0.0')).toBe(false)
  })

  it('tilde ~ 范围', () => {
    expect(satisfiesDshPeer('~1.2.3', '1.2.9')).toBe(true)
    expect(satisfiesDshPeer('~1.2.3', '1.3.0')).toBe(false)
    expect(satisfiesDshPeer('~1.2', '1.2.5')).toBe(true)
    expect(satisfiesDshPeer('~1', '1.9.0')).toBe(true)
    expect(satisfiesDshPeer('~1', '2.0.0')).toBe(false)
    // ~0.0.3 := >=0.0.3 <0.1.0（tilde 的 patch 不参与上界）
    expect(satisfiesDshPeer('~0.0.3', '0.0.5')).toBe(true)
    expect(satisfiesDshPeer('~0.0.3', '0.1.0')).toBe(false)
    expect(satisfiesDshPeer('~0.0.3', '0.0.1')).toBe(false)
    // ~0.2 := >=0.2.0 <0.3.0
    expect(satisfiesDshPeer('~0.2', '0.2.9')).toBe(true)
    expect(satisfiesDshPeer('~0.2', '0.3.0')).toBe(false)
    // minor 通配退到 major 级：~1.x := >=1.0.0 <2.0.0、~0.x := >=0.0.0 <1.0.0
    expect(satisfiesDshPeer('~1.x', '1.9.0')).toBe(true)
    expect(satisfiesDshPeer('~1.x', '2.0.0')).toBe(false)
    expect(satisfiesDshPeer('~0.x', '0.9.0')).toBe(true)
    expect(satisfiesDshPeer('~0.x', '1.0.0')).toBe(false)
  })

  it('空格分隔的交集：两条件都要满足', () => {
    expect(satisfiesDshPeer('>=0.1.7-rc.2 <0.2.0', '0.1.9')).toBe(true)
    expect(satisfiesDshPeer('>=0.1.7-rc.2 <0.2.0', '0.2.0')).toBe(false)
    expect(satisfiesDshPeer('>=0.1.7-rc.2 <0.2.0', '0.1.6')).toBe(false)
  })

  it('|| 分隔的并集：任一子范围满足即可（memory-plugin 真实范围）', () => {
    const range = '>=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1 || ^0.1.7-rc.2'
    expect(satisfiesDshPeer(range, '0.1.7-rc.2')).toBe(true)
    expect(satisfiesDshPeer(range, '0.1.9')).toBe(true)
    expect(satisfiesDshPeer(range, '0.2.0')).toBe(false)
  })

  it('v 前缀被剥离', () => {
    expect(satisfiesDshPeer('>=v0.1.7', 'v0.1.7')).toBe(true)
  })

  it('git-panel 真实 peer：>=0.1.7-rc.2', () => {
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.7-rc.2')).toBe(true)
    expect(satisfiesDshPeer('>=0.1.7-rc.2', '0.1.5')).toBe(false)
  })
})

describe('isDshPeerName', () => {
  it('识别 dsh 主包与子包', () => {
    expect(isDshPeerName('@deepseek-ai/dsh')).toBe(true)
    expect(isDshPeerName('@deepseek-ai/dsh-llm')).toBe(true)
    expect(isDshPeerName('@deepseek-ai/dsh-client-ui-slots')).toBe(true)
  })
  it('非 dsh peer 返回 false', () => {
    expect(isDshPeerName('@deepseek-ai/cordis')).toBe(false)
    expect(isDshPeerName('react')).toBe(false)
    expect(isDshPeerName('@huanlin/dsh-plugin-better-locale')).toBe(false)
  })
})

describe('evaluateDshPeers', () => {
  it('全部满足 → 空对象（兼容）', () => {
    const peers = { '@deepseek-ai/dsh': '>=0.1.7-rc.2', '@deepseek-ai/dsh-llm': '^0.1.7-rc.1', react: '^18' }
    expect(evaluateDshPeers(peers, '0.1.7-rc.2')).toEqual({})
  })

  it('子包锁 ^0.2.0-rc.1 而实例 0.1.7-rc.2 → 全部 dsh 子包不兼容（better-sidebar 0.24.1 真实场景）', () => {
    const peers = {
      react: '^18.2.0',
      '@deepseek-ai/cordis': '^4.0.4',
      '@deepseek-ai/dsh-llm': '^0.2.0-rc.1',
      '@deepseek-ai/dsh-agent': '^0.2.0-rc.1',
      '@deepseek-ai/dsh-session': '^0.2.0-rc.1'
    }
    const incompatible = evaluateDshPeers(peers, '0.1.7-rc.2')
    expect(Object.keys(incompatible).sort()).toEqual([
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session'
    ])
    // 非 dsh peer（react/cordis）不参与判定。
    expect(incompatible['react']).toBeUndefined()
    expect(incompatible['@deepseek-ai/cordis']).toBeUndefined()
  })

  it('dsh 版本未知 → 全部 dsh peer 视为不兼容', () => {
    const peers = { '@deepseek-ai/dsh': '>=0.1.0', '@deepseek-ai/dsh-llm': '^0.1.0' }
    expect(Object.keys(evaluateDshPeers(peers, null)).sort()).toEqual([
      '@deepseek-ai/dsh',
      '@deepseek-ai/dsh-llm'
    ])
  })

  it('无 peer 或空 → 空对象', () => {
    expect(evaluateDshPeers(null, '0.1.7')).toEqual({})
    expect(evaluateDshPeers({}, '0.1.7')).toEqual({})
  })
})

describe('dshPeerRange', () => {
  it('主包已声明 → 取主包范围（优先于子包）', () => {
    const peers = { '@deepseek-ai/dsh': '>=0.1.7-rc.2', '@deepseek-ai/dsh-llm': '^0.2.0-rc.1', react: '^18' }
    expect(dshPeerRange(peers)).toBe('>=0.1.7-rc.2')
  })

  it('只声明子包且锁步一致 → 取公共范围（修复「dsh —」）', () => {
    const peers = {
      react: '^18.2.0',
      '@deepseek-ai/dsh-skill': '0.2.0-rc.1 || 0.2.0-rc.2',
      '@deepseek-ai/dsh-session': '0.2.0-rc.1 || 0.2.0-rc.2',
      '@deepseek-ai/dsh-client-ui-slots': '0.2.0-rc.1 || 0.2.0-rc.2'
    }
    expect(dshPeerRange(peers)).toBe('0.2.0-rc.1 || 0.2.0-rc.2')
  })

  it('子包范围不一致 → 按 peer 名排序去重后以 | 连接', () => {
    const peers = {
      '@deepseek-ai/dsh-session': '^0.2.0',
      '@deepseek-ai/dsh-llm': '^0.1.0'
    }
    expect(dshPeerRange(peers)).toBe('^0.1.0 | ^0.2.0')
  })

  it('无任何 dsh peer / 空 / 空白范围 → null', () => {
    expect(dshPeerRange(null)).toBe(null)
    expect(dshPeerRange({})).toBe(null)
    expect(dshPeerRange({ react: '^18', '@deepseek-ai/cordis': '^4' })).toBe(null)
    expect(dshPeerRange({ '@deepseek-ai/dsh': '  ', '@deepseek-ai/dsh-llm': '' })).toBe(null)
  })
})

describe('githubUrlFrom', () => {
  it('git+https 带 .git 后缀', () => {
    expect(githubUrlFrom({ type: 'git', url: 'git+https://github.com/xbzbing/dsh-git-panel.git' })).toBe(
      'https://github.com/xbzbing/dsh-git-panel'
    )
  })

  it('字符串形态', () => {
    expect(githubUrlFrom('https://github.com/DDDMUC/dsh-free-search.git')).toBe(
      'https://github.com/DDDMUC/dsh-free-search'
    )
  })

  it('git@ SSH 形态', () => {
    expect(githubUrlFrom('git@github.com:owner/repo.git')).toBe('https://github.com/owner/repo')
  })

  it('github: 简写', () => {
    expect(githubUrlFrom('github:owner/repo')).toBe('https://github.com/owner/repo')
  })

  it('非 github 或空 → null', () => {
    expect(githubUrlFrom('https://gitlab.com/a/b.git')).toBe(null)
    expect(githubUrlFrom('')).toBe(null)
    expect(githubUrlFrom(null)).toBe(null)
    expect(githubUrlFrom(undefined)).toBe(null)
  })
})

describe('npmUrlFrom', () => {
  it('scoped 与 unscoped 包名', () => {
    expect(npmUrlFrom('@xbzbing/dsh-git-panel')).toBe('https://www.npmjs.com/package/@xbzbing/dsh-git-panel')
    expect(npmUrlFrom('dsh-free-search')).toBe('https://www.npmjs.com/package/dsh-free-search')
  })

  it('非法名 → null', () => {
    expect(npmUrlFrom('has space')).toBe(null)
    expect(npmUrlFrom('')).toBe(null)
  })
})
