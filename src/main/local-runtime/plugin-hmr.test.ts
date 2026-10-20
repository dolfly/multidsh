import { describe, expect, it } from 'vitest'
import { defaultApplication, profileHasHmr } from './plugin-hmr'

/**
 * 插件改动的 HMR 判定与生效口径。
 *
 * 与 dsh 的 `change()` 同口径：有 HMR 即 applied，仅在 reconcile 报出 restartReason 时才要求重启。
 * 判定不出时按「无 HMR」保守处理 —— 宁可提示重启，也不谎称已生效。
 */

describe('profileHasHmr', () => {
  it('web profile 恒有 HMR（不依赖加载清单）', () => {
    expect(profileHasHmr('web', null)).toBe(true)
    expect(profileHasHmr('web', [])).toBe(true)
  })

  it('加载清单里有 web-app bundle 时有 HMR', () => {
    expect(profileHasHmr('headless', ['@deepseek-ai/dsh-web-app'])).toBe(true)
  })

  it('没有 web-app bundle 时判定不出 → 按「无 HMR」保守处理', () => {
    expect(profileHasHmr('headless', ['@deepseek-ai/dsh-base'])).toBe(false)
    expect(profileHasHmr('headless', [])).toBe(false)
    expect(profileHasHmr('headless', null)).toBe(false)
  })

  it('非 web profile 且加载清单未知时同样按「无 HMR」处理', () => {
    expect(profileHasHmr('sdk', null)).toBe(false)
  })
})

describe('defaultApplication', () => {
  it('有 HMR → 已热生效', () => {
    expect(defaultApplication(true)).toBe('applied')
  })

  it('无 HMR → 需重启 Host', () => {
    expect(defaultApplication(false)).toBe('restart-required')
  })
})
