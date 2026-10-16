import { describe, expect, it } from 'vitest'
import { createTranslator, interpolate, translate } from './index'
import { MESSAGES, MESSAGE_KEYS } from './messages'

describe('i18n 目录（双语）', () => {
  it('每条文案都有 zh 与 en,且都非空', () => {
    for (const key of MESSAGE_KEYS) {
      const message = MESSAGES[key]
      expect(message.zh.trim(), `${key}.zh 不能为空`).not.toBe('')
      expect(message.en.trim(), `${key}.en 不能为空`).not.toBe('')
    }
  })

  it('除品牌名外,en 文案不含中日韩字符(防漏译:直接抄了中文)', () => {
    const han = /[\u4e00-\u9fff]/
    const allowed = new Set(['app.name'])
    for (const key of MESSAGE_KEYS) {
      if (allowed.has(key)) continue
      expect(han.test(MESSAGES[key].en), `${key}.en 疑似漏译:${MESSAGES[key].en}`).toBe(false)
    }
  })

  it('占位符在两种语言里一致(漏一处会导致插值静默失效)', () => {
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()
    for (const key of MESSAGE_KEYS) {
      expect(placeholders(MESSAGES[key].zh), `${key} 的占位符不一致`).toEqual(
        placeholders(MESSAGES[key].en)
      )
    }
  })

  it('zh 与 en 都非空且互不相同(除非故意同形)', () => {
    const identical = MESSAGE_KEYS.filter((key) => MESSAGES[key].zh === MESSAGES[key].en)
    // 品牌名、明确保留的技术术语、以及无需翻译的示例值可同形。
    expect(identical.sort()).toEqual([
      'app.name',
      'detail.plugin.confirmSourceNpm',
      'detail.plugin.field.github',
      'detail.plugin.field.npm',
      'detail.plugin.source.github',
      'detail.plugin.source.npm',
      'edit.profileLabel',
      'transport.ssh',
      'wizard.profileLabel',
      'wizard.userPlaceholder'
    ])
  })
})

describe('translate / createTranslator', () => {
  it('按语言返回对应文案', () => {
    expect(translate('zh', 'nav.settings')).toBe('设置')
    expect(translate('en', 'nav.settings')).toBe('Settings')
  })

  it('插值替换占位符', () => {
    const t = createTranslator('zh')
    expect(t('auth.locked', { seconds: 30 })).toBe('失败次数过多，请等待 30s')
    expect(createTranslator('en')('auth.lockButton', { seconds: 12 })).toBe('Locked 12s')
  })

  it('缺参时保留占位符原样(不渲染 undefined)', () => {
    expect(interpolate('等待 {seconds}s', {})).toBe('等待 {seconds}s')
    expect(interpolate('等待 {seconds}s', { seconds: 0 })).toBe('等待 0s')
    expect(interpolate('无占位符')).toBe('无占位符')
  })

  it('多占位符各自替换', () => {
    expect(interpolate('{a} + {b} = {c}', { a: 1, b: 2, c: 3 })).toBe('1 + 2 = 3')
  })

  it('未知 key 返回 key 本身(便于在 UI 上直接看出漏配)', () => {
    // 绕过类型约束模拟运行期的脏数据
    expect(translate('zh', 'nope.missing' as never)).toBe('nope.missing')
  })

  it('同一语言的两个 translator 行为一致(纯函数)', () => {
    const a = createTranslator('en')
    const b = createTranslator('en')
    expect(a('common.cancel')).toBe(b('common.cancel'))
  })
})
