import { isValidProfile } from '@shared/contracts'
import { tryParseEndpoint } from '@shared/endpoint'
import type { Translator } from '@shared/i18n'
import type { WizardForm, WizardTransport } from './types'

/**
 * 向导第 2 步的表单校验（纯函数）：返回首个错误的本地化文案，null 表示通过。
 * `reusableExternalInstance` 存在时名称可空（沿用被接管实例的名称）。
 */
export function validateWizardForm(args: {
  t: Translator
  transport: WizardTransport
  form: WizardForm
  useExistingExternal: boolean
  hasReusableExternal: boolean
}): string | null {
  const { t, transport, form, useExistingExternal, hasReusableExternal } = args
  if (!form.name.trim() && !hasReusableExternal) return t('wizard.errName')
  if (
    transport === 'local' &&
    useExistingExternal &&
    !hasReusableExternal &&
    !form.externalAccess.trim()
  ) {
    return t('wizard.errExternalAccess')
  }
  if (
    transport === 'local' &&
    !useExistingExternal &&
    form.profile.trim() !== '' &&
    !isValidProfile(form.profile)
  ) {
    return t('wizard.errProfile')
  }
  if (transport === 'ssh') {
    if (!form.host.trim()) return t('wizard.errHost')
    if (!form.username.trim()) return t('wizard.errUsername')
  }
  if (transport === 'http') {
    const parsed = tryParseEndpoint(form.endpointUrl)
    if (!parsed.ok) return parsed.message
  }
  return null
}
