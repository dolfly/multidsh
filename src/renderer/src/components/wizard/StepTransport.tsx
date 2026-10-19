import type { ReactNode } from 'react'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import { TYPE_INFO } from '../../lib/format'
import type { MessageKey } from '@shared/i18n/messages'
import type { WizardTransport } from './types'

const CARD_COPY: Record<WizardTransport, { titleKey: MessageKey; descKey: MessageKey }> = {
  local: { titleKey: 'wizard.typeLocal', descKey: 'wizard.typeLocalDesc' },
  ssh: { titleKey: 'wizard.typeSsh', descKey: 'wizard.typeSshDesc' },
  http: { titleKey: 'wizard.typeHttp', descKey: 'wizard.typeHttpDesc' }
}

function TypeCard(props: {
  t: Translator
  transport: WizardTransport
  pressed: boolean
  onClick: () => void
}): ReactNode {
  const { t, transport } = props
  return (
    <button
      className="type-card"
      data-transport={transport}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      data-testid={`type-${transport}`}
    >
      <span className="tc-icon">
        <Icon name={TYPE_INFO[transport].icon} />
      </span>
      <b>{t(TYPE_INFO[transport].labelKey)}</b>
      <span>{t(CARD_COPY[transport].titleKey)}</span>
      <span>{t(CARD_COPY[transport].descKey)}</span>
    </button>
  )
}

export interface StepTransportProps {
  t: Translator
  transport: WizardTransport
  onSelect: (transport: WizardTransport) => void
}

/** 第 1 步：选择实例传输类型。 */
export default function StepTransport({ t, transport, onSelect }: StepTransportProps): ReactNode {
  return (
    <div className="type-cards" data-testid="wizard-step-1">
      <TypeCard
        t={t}
        transport="local"
        pressed={transport === 'local'}
        onClick={() => onSelect('local')}
      />
      <TypeCard
        t={t}
        transport="ssh"
        pressed={transport === 'ssh'}
        onClick={() => onSelect('ssh')}
      />
      <TypeCard
        t={t}
        transport="http"
        pressed={transport === 'http'}
        onClick={() => onSelect('http')}
      />
    </div>
  )
}
