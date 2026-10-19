import type { ReactNode } from 'react'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import { TYPE_INFO } from '../../lib/format'
import type { ExternalWorkspace, WizardForm, WizardTransport } from './types'

export interface StepConfirmProps {
  t: Translator
  transport: WizardTransport
  form: WizardForm
  configuredName: string
  useExistingExternal: boolean
  externalWorkspace: ExternalWorkspace | null
  localLaunchersCount: number
}

/** 第 3 步确认：汇总名称/传输/地址，并按传输给出创建须知。 */
export default function StepConfirm(props: StepConfirmProps): ReactNode {
  const {
    t,
    transport,
    form,
    configuredName,
    useExistingExternal,
    externalWorkspace,
    localLaunchersCount
  } = props
  return (
    <div data-testid="wizard-step-3">
      <p className="meta">{t('wizard.confirmHint')}</p>
      <div className="inset mt12">
        <dl className="kv">
          <dt>{t('wizard.dtName')}</dt>
          <dd>{configuredName}</dd>
          <dt>{t('wizard.dtTransport')}</dt>
          <dd>
            {transport === 'local' && useExistingExternal
              ? t('wizard.currentWorkspace')
              : t(TYPE_INFO[transport].labelKey)}
            {transport === 'ssh' && form.username ? ` · ${form.username}@${form.host}` : ''}
          </dd>
          <dt>{t('wizard.dtAddress')}</dt>
          <dd className="num">
            {transport === 'local'
              ? useExistingExternal && externalWorkspace
                ? `127.0.0.1:${externalWorkspace.port}`
                : t('wizard.autoPort')
              : transport === 'ssh'
                ? `${form.host}:${form.remotePort}`
                : form.endpointUrl}
          </dd>
          {transport === 'local' && useExistingExternal && externalWorkspace && (
            <>
              <dt>PID</dt>
              <dd className="num">{externalWorkspace.pid}</dd>
              <dt>{t('detail.externalPatch')}</dt>
              <dd className="num">
                {externalWorkspace.patch
                  ? t('wizard.externalPatch', { patch: externalWorkspace.patch })
                  : t('wizard.externalNoPatch')}
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="note n-info mt12">
        <Icon
          name={
            transport === 'local'
              ? useExistingExternal
                ? 'info'
                : 'check'
              : transport === 'ssh'
                ? 'shield'
                : 'info'
          }
        />
        <span>
          {transport === 'local'
            ? useExistingExternal
              ? t('wizard.connectExistingNote')
              : localLaunchersCount > 0
                ? t('wizard.createNewNote')
                : t('wizard.noteLocal')
            : transport === 'ssh'
              ? t('wizard.noteSsh')
              : t('wizard.noteHttp')}
        </span>
      </div>
    </div>
  )
}
