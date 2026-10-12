import { describe, expect, it } from 'vitest'
import {
  canOfferUpgrade,
  initialCheckState,
  pluginSourceKey,
  pluginApplyNotice,
  pruneChecks,
  restoreChecks,
  showsIncompatibleWarning,
  showsUnknownCompatibility,
  showsUpToDate,
  type PluginCheckState
} from './plugins-card-state'
import type { PluginInfo, PluginUpdateCheck } from '@shared/contracts'

function check(overrides: Partial<PluginUpdateCheck>): PluginUpdateCheck {
  return {
    name: 'p',
    current: '1.0.0',
    latest: '1.1.0',
    hasUpdate: true,
    compatible: true,
    dshPeer: '>=0.1.7-rc.2',
    dshVersion: '0.1.7-rc.2',
    publishedAt: null,
    ...overrides
  }
}

function done(result: PluginUpdateCheck): PluginCheckState {
  return { status: 'done', result, error: null }
}

describe('canOfferUpgrade', () => {
  it('检查完成、有新版且兼容 → true', () => {
    expect(canOfferUpgrade(done(check({ hasUpdate: true, compatible: true })))).toBe(true)
  })
  it('不兼容 → false', () => {
    expect(canOfferUpgrade(done(check({ hasUpdate: true, compatible: false })))).toBe(false)
  })
  it('无新版 → false', () => {
    expect(canOfferUpgrade(done(check({ hasUpdate: false })))).toBe(false)
  })
  it('未检查 → false', () => {
    expect(canOfferUpgrade(initialCheckState)).toBe(false)
  })
})

describe('showsIncompatibleWarning', () => {
  it('有新版但不兼容 → true', () => {
    expect(showsIncompatibleWarning(done(check({ hasUpdate: true, compatible: false })))).toBe(true)
  })
  it('兼容 → false', () => {
    expect(showsIncompatibleWarning(done(check({ hasUpdate: true, compatible: true })))).toBe(false)
  })
})

describe('showsUnknownCompatibility', () => {
  it('不兼容且 dsh 版本未知 → true（无法判定，非确认不兼容）', () => {
    expect(
      showsUnknownCompatibility(
        done(check({ hasUpdate: true, compatible: false, dshVersion: null }))
      )
    ).toBe(true)
  })
  it('不兼容但 dsh 版本已知 → false', () => {
    expect(
      showsUnknownCompatibility(done(check({ hasUpdate: true, compatible: false })))
    ).toBe(false)
  })
  it('兼容（即使版本未知）→ false', () => {
    expect(
      showsUnknownCompatibility(done(check({ hasUpdate: true, compatible: true, dshVersion: null })))
    ).toBe(false)
  })
})

describe('showsUpToDate', () => {
  it('无新版 → true', () => {
    expect(showsUpToDate(done(check({ hasUpdate: false })))).toBe(true)
  })
  it('有新版 → false', () => {
    expect(showsUpToDate(done(check({ hasUpdate: true })))).toBe(false)
  })
})

describe('pluginSourceKey', () => {
  it('各来源映射', () => {
    expect(pluginSourceKey('npm')).toBe('detail.plugin.source.npm')
    expect(pluginSourceKey('github')).toBe('detail.plugin.source.github')
    expect(pluginSourceKey('file')).toBe('detail.plugin.source.file')
    expect(pluginSourceKey('unknown')).toBe('detail.plugin.source.unknown')
  })
})

describe('pruneChecks', () => {
  const done: PluginCheckState = {
    status: 'done',
    result: {
      name: 'a',
      current: '1.0.0',
      latest: '1.0.0',
      hasUpdate: false,
      compatible: true,
      dshPeer: null,
      dshVersion: null,
      publishedAt: null
    },
    error: null
  }

  it('保留仍在册插件的检查状态，剔除已卸载插件的项', () => {
    const checks = { a: done, b: { ...done }, c: { ...done } }
    const pruned = pruneChecks(checks, ['a', 'c'])
    expect(Object.keys(pruned).sort()).toEqual(['a', 'c'])
    expect(pruned.a).toBe(done)
  })

  it('空在册集合 → 全部剔除', () => {
    expect(pruneChecks({ a: done }, [])).toEqual({})
  })

  it('新装插件不凭空产生检查项（只保留已有）', () => {
    const pruned = pruneChecks({ a: done }, ['a', 'newly-installed'])
    expect(Object.keys(pruned)).toEqual(['a'])
  })
})

/** 最小插件信息（restoreChecks 只用 name 与已装 version）。 */
function plugin(name: string, version: string): PluginInfo {
  return {
    name,
    version,
    title: null,
    description: null,
    author: null,
    license: null,
    npmUrl: null,
    githubUrl: null,
    iconDataUri: null,
    dependencies: [],
    dshPeer: null,
    nodeEngine: null,
    hasHostSide: true,
    hasClientSide: false,
    installSource: 'npm',
    enabled: true,
    publishedAt: null
  }
}

describe('restoreChecks（由持久化快照恢复标记）', () => {
  it('无快照时全部未检查', () => {
    expect(restoreChecks([plugin('a', '1.0.0')], null)).toEqual({})
  })

  it('记录与已装版本一致且候选更高 → 恢复为「可升级」', () => {
    const restored = restoreChecks([plugin('a', '1.0.0')], {
      lastCheckedAt: '2026-09-29T10:00:00.000Z',
      updates: {
        a: {
          current: '1.0.0',
          latest: '1.2.0',
          compatible: true,
          dshPeer: null,
          dshVersion: '0.2.0-rc.1'
        }
      },
      checking: [],
      autoDisabled: []
    })
    expect(restored.a?.status).toBe('done')
    expect(restored.a?.result).toMatchObject({ current: '1.0.0', latest: '1.2.0', hasUpdate: true })
  })

  it('记录来自更早的已装版本（已升级过）→ 不显示标记', () => {
    const restored = restoreChecks([plugin('a', '1.2.0')], {
      lastCheckedAt: null,
      updates: {
        a: { current: '1.0.0', latest: '1.2.0', compatible: true, dshPeer: null, dshVersion: null }
      },
      checking: [],
      autoDisabled: []
    })
    expect(restored.a).toBeUndefined()
  })

  it('已装版本高于记录中的候选（手动装了更新版）→ 丢弃陈旧标记', () => {
    const restored = restoreChecks([plugin('a', '1.1.17')], {
      lastCheckedAt: null,
      updates: {
        a: {
          current: '1.1.13',
          latest: '1.1.15',
          compatible: false,
          dshPeer: null,
          dshVersion: '0.2.1-alpha.2'
        }
      },
      checking: [],
      autoDisabled: []
    })
    expect(restored.a).toBeUndefined()
  })

  it('在飞检查 → 恢复为「检查中…」，优先于持久化记录', () => {
    const restored = restoreChecks([plugin('a', '1.0.0')], {
      lastCheckedAt: null,
      updates: {
        a: { current: '1.0.0', latest: '1.2.0', compatible: true, dshPeer: null, dshVersion: null }
      },
      checking: ['a'],
      autoDisabled: []
    })
    expect(restored.a).toEqual({ status: 'checking', result: null, error: null })
  })

  it('快照里有但列表已无的插件被忽略', () => {
    const restored = restoreChecks([plugin('b', '1.0.0')], {
      lastCheckedAt: null,
      updates: {
        a: { current: '1.0.0', latest: '9.9.9', compatible: true, dshPeer: null, dshVersion: null }
      },
      checking: [],
      autoDisabled: []
    })
    expect(restored).toEqual({})
  })
})

describe('pluginApplyNotice（改动后的提示方案）', () => {
  it('实例未运行 → 已保存，下次启动生效（没有可重启的 Host）', () => {
    expect(pluginApplyNotice({ running: false, application: 'applied' })).toBe('saved')
    expect(pluginApplyNotice({ running: false, application: 'restart-required' })).toBe('saved')
  })

  it('运行中 + applied（全新安装且 HMR 可用）→ 已即时生效', () => {
    expect(pluginApplyNotice({ running: true, application: 'applied' })).toBe('applied')
  })

  it('运行中 + restart-required（升级/替换已装包，或 profile 无 HMR）→ 需重启', () => {
    expect(pluginApplyNotice({ running: true, application: 'restart-required' })).toBe('restart-required')
  })
})
