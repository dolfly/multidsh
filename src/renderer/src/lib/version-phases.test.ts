import { describe, expect, it } from 'vitest'
import { MESSAGES } from '@shared/i18n/messages'
import { PHASE_KEYS, REASON_KEYS } from './version-phases'

/**
 * 版本文案映射的三方闭合：契约枚举（键）↔ 映射表 ↔ messages 文案键。
 * 枚举↔映射由 version-phases.ts 的 `satisfies` 在编译期双向钉死；
 * 这里补运行时的「每个映射值都真实存在 zh/en 文案」——防止只改文案键名导致
 * 界面直接显示原始 key。生产侧 reason 由 register.test 的三条 check 分支覆盖。
 */
describe('版本文案映射闭合', () => {
  it('REASON_KEYS 键集 = 契约 reason 全集，且每个值都有文案', () => {
    expect(Object.keys(REASON_KEYS).sort()).toEqual([
      'global-unmanaged',
      'not-local',
      'runtime-external'
    ])
    for (const key of Object.values(REASON_KEYS)) {
      expect(MESSAGES[key], `缺少文案键 ${key}`).toBeDefined()
    }
  })

  it('PHASE_KEYS 键集 = 除 error 外的全部进度阶段，且每个值都有文案', () => {
    expect(Object.keys(PHASE_KEYS).sort()).toEqual([
      'checking',
      'done',
      'downloading',
      'installing'
    ])
    for (const key of Object.values(PHASE_KEYS)) {
      expect(MESSAGES[key], `缺少文案键 ${key}`).toBeDefined()
    }
  })
})
