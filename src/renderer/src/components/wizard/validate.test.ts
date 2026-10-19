import { describe, expect, it } from 'vitest'
import { validateWizardForm } from './validate'
import { EMPTY_FORM } from './types'
import type { WizardTransport } from './types'

/** 翻译函数替身：直接回传 key，断言据此判定命中的是哪条错误。 */
const t = ((key: string) => key) as never

function run(args: {
  transport: WizardTransport
  form?: Partial<typeof EMPTY_FORM>
  useExistingExternal?: boolean
  hasReusableExternal?: boolean
}): string | null {
  return validateWizardForm({
    t,
    transport: args.transport,
    form: { ...EMPTY_FORM, ...args.form },
    useExistingExternal: args.useExistingExternal ?? false,
    hasReusableExternal: args.hasReusableExternal ?? false
  })
}

describe('validateWizardForm', () => {
  it('名称为空即报错（无可复用外部实例时）', () => {
    expect(run({ transport: 'local' })).toBe('wizard.errName')
    // 纯空白也算空
    expect(run({ transport: 'local', form: { name: '   ' } })).toBe('wizard.errName')
  })

  it('可复用外部实例存在时名称可空（沿用被接管实例名称）', () => {
    expect(
      run({ transport: 'local', useExistingExternal: true, hasReusableExternal: true })
    ).toBeNull()
  })

  it('local 接管外部：无可复用实例时 externalAccess 必填', () => {
    expect(run({ transport: 'local', form: { name: 'a' }, useExistingExternal: true })).toBe(
      'wizard.errExternalAccess'
    )
    // 填了 token 即通过
    expect(
      run({
        transport: 'local',
        form: { name: 'a', externalAccess: ' tok ' },
        useExistingExternal: true
      })
    ).toBeNull()
    // 有可复用实例时不要求 externalAccess
    expect(
      run({
        transport: 'local',
        useExistingExternal: true,
        hasReusableExternal: true
      })
    ).toBeNull()
  })

  it('local 非接管：非法 profile 报错，空 profile 与合法 profile 放行', () => {
    expect(run({ transport: 'local', form: { name: 'a', profile: '../etc' } })).toBe(
      'wizard.errProfile'
    )
    expect(run({ transport: 'local', form: { name: 'a', profile: '' } })).toBeNull()
    expect(run({ transport: 'local', form: { name: 'a', profile: 'web' } })).toBeNull()
  })

  it('ssh：host 与 username 依次必填，齐备即通过', () => {
    expect(run({ transport: 'ssh', form: { name: 'a' } })).toBe('wizard.errHost')
    expect(run({ transport: 'ssh', form: { name: 'a', host: 'h' } })).toBe('wizard.errUsername')
    expect(run({ transport: 'ssh', form: { name: 'a', host: 'h', username: 'u' } })).toBeNull()
  })

  it('http：endpointUrl 解析失败返回解析错误文案，合法端点通过', () => {
    const bad = run({ transport: 'http', form: { name: 'a', endpointUrl: 'ftp://nope' } })
    expect(bad).not.toBeNull()
    expect(
      run({ transport: 'http', form: { name: 'a', endpointUrl: 'https://gw.example.com/dsh' } })
    ).toBeNull()
  })
})
