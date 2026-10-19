import type { ReactNode } from 'react'
import { isCleartextEndpoint } from '@shared/endpoint'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import UrlDetect from '../UrlDetect'
import type { WizardForm } from './types'

export interface HttpConfigProps {
  t: Translator
  form: WizardForm
  set: (
    key: Exclude<keyof WizardForm, 'useDefaultSpace'>
  ) => (event: { target: { value: string } }) => void
}

/** HTTP 直连端点配置：URL 输入 + 明文告警 + 认证模式探测。 */
export default function HttpConfig({ t, form, set }: HttpConfigProps): ReactNode {
  return (
    <>
      <div className="field mt12">
        <label htmlFor="wizard-url">{t('wizard.urlLabel')}</label>
        <input
          className="input num"
          id="wizard-url"
          placeholder="https://host:8443"
          value={form.endpointUrl}
          onChange={set('endpointUrl')}
          data-testid="wizard-url"
        />
        <span className="hint">{t('wizard.urlHint')}</span>
      </div>
      {/* 直连 HTTP 使用明文数据连接，创建前显示警告。 */}
      {isCleartextEndpoint(form.endpointUrl) && (
        <div className="note n-warn mt12" data-testid="wizard-cleartext-warning">
          <Icon name="alert" />
          <span>{t('wizard.cleartextWarning')}</span>
        </div>
      )}
      <div className="mt12">
        <UrlDetect endpointUrl={form.endpointUrl} />
      </div>
    </>
  )
}
