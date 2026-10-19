import type { ReactNode } from 'react'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import KeyPreview from '../KeyPreview'
import type { WizardForm } from './types'

export interface SshConfigProps {
  t: Translator
  form: WizardForm
  set: (
    key: Exclude<keyof WizardForm, 'useDefaultSpace'>
  ) => (event: { target: { value: string } }) => void
}

/** SSH 隧道实例配置：主机 / 用户 / 端口 + 密钥预览与 agent 提示。 */
export default function SshConfig({ t, form, set }: SshConfigProps): ReactNode {
  return (
    <>
      <div className="grid-2 mt12">
        <div className="field">
          <label htmlFor="wizard-host">{t('wizard.hostLabel')}</label>
          <input
            className="input"
            id="wizard-host"
            placeholder={t('wizard.hostPlaceholder')}
            value={form.host}
            onChange={set('host')}
            data-testid="wizard-host"
          />
        </div>
        <div className="field">
          <label htmlFor="wizard-user">{t('wizard.userLabel')}</label>
          <input
            className="input"
            id="wizard-user"
            placeholder={t('wizard.userPlaceholder')}
            value={form.username}
            onChange={set('username')}
            data-testid="wizard-user"
          />
        </div>
        <div className="field">
          <label htmlFor="wizard-ssh-port">{t('wizard.sshPortLabel')}</label>
          <input
            className="input num"
            id="wizard-ssh-port"
            value={form.sshPort}
            onChange={set('sshPort')}
          />
        </div>
        <div className="field">
          <label htmlFor="wizard-remote-port">{t('wizard.remotePortLabel')}</label>
          <input
            className="input num"
            id="wizard-remote-port"
            value={form.remotePort}
            onChange={set('remotePort')}
          />
        </div>
      </div>
      <div className="mt12">
        <KeyPreview host={form.host} username={form.username} sshPort={form.sshPort} />
      </div>
      <div className="hintbar mt12">
        <Icon name="info" />
        <span>{t('wizard.sshAgentHint')}</span>
      </div>
    </>
  )
}
