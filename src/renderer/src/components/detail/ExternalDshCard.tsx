import type { ReactNode } from 'react'
import type { ExternalDshWebSnapshot } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'

export interface ExternalDshCardProps {
  t: Translator
  items: ExternalDshWebSnapshot[]
  accessById: Record<number, string>
  setAccess: (updater: (current: Record<number, string>) => Record<number, string>) => void
  adopting: number | null
  onAdopt: (pid: number, port: number | null) => void
}

/** 未纳管的本机 dsh web 进程列表：逐项填 token 后接管。 */
export default function ExternalDshCard(props: ExternalDshCardProps): ReactNode {
  const { t, items, accessById, setAccess, adopting, onAdopt } = props
  return (
    <div className="card" data-testid="external-dsh-card">
      <div className="card-head">
        <h3>{t('detail.externalTitle')}</h3>
        <span className="meta">{t('detail.externalCount', { n: items.length })}</span>
      </div>
      <p className="meta" style={{ marginBottom: 10 }}>
        {t('detail.externalBody')}
      </p>
      {items.map((item) => (
        <div key={item.pid} className="row-between ext-row">
          <div style={{ minWidth: 0 }}>
            <div className="num" style={{ fontSize: 12.5 }}>
              127.0.0.1:{item.port} <span className="meta">· pid {item.pid}</span>
            </div>
            <div
              className="meta"
              style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={item.command}
            >
              {item.patch
                ? `${t('detail.externalPatch')} ${item.patch}`
                : t('detail.externalNoPatch')}
            </div>
            <input
              className="input num mt8"
              value={accessById[item.pid] ?? ''}
              onChange={(event) =>
                setAccess((current) => ({ ...current, [item.pid]: event.target.value }))
              }
              autoComplete="off"
              type="password"
              aria-label={t('wizard.externalAccessLabel')}
              data-testid={`external-access-${item.pid}`}
            />
          </div>
          <button
            className="btn btn-primary btn-sm"
            data-testid={`adopt-btn-${item.pid}`}
            disabled={adopting !== null}
            onClick={() => onAdopt(item.pid, item.port)}
          >
            <Icon name="external" />{' '}
            {adopting === item.pid ? t('detail.adopting') : t('detail.adopt')}
          </button>
        </div>
      ))}
    </div>
  )
}
