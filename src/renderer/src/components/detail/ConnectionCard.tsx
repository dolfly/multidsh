import type { ReactNode } from 'react'
import { isCleartextEndpoint } from '@shared/endpoint'
import type { AuthPhase, InstanceRecord } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import { addressOf } from '../../lib/format'
import { showAuthActions } from '../../lib/auth-actions'

export interface ConnectionCardProps {
  t: Translator
  record: InstanceRecord
  authPhase: AuthPhase | undefined
  /** 是否显示「在浏览器中打开」：本机与 http/https 实例支持；本机需处于运行态。 */
  canOpenInBrowser: boolean
  onLogin: () => void
  onCopyAddress: () => void
  onOpenInBrowser: () => void
  /** 打开本机实例的数据目录；仅本机实例提供，非本机为 undefined 时不显示按钮。 */
  onOpenDirectory?: () => void
  onDisconnect: () => void
  onLogout: () => void
}

/** 连接方式卡：地址/端口/认证模式等事实文本，登录/复制地址/在浏览器中打开/打开目录/断开/登出操作。 */
export default function ConnectionCard(props: ConnectionCardProps): ReactNode {
  const {
    t,
    record,
    authPhase,
    canOpenInBrowser,
    onLogin,
    onCopyAddress,
    onOpenInBrowser,
    onOpenDirectory,
    onDisconnect,
    onLogout
  } = props
  return (
    <div className="card selectable">
      <div className="card-head">
        <h3>{t('detail.connection')}</h3>
        <span className="meta">
          {record.transport === 'local'
            ? t('detail.loopback')
            : record.transport === 'ssh'
              ? t('detail.tunnelEncrypted')
              : t('detail.direct')}
        </span>
      </div>
      <dl className="kv">
        <dt>{t('detail.address')}</dt>
        <dd className="num">{addressOf(record)}</dd>
        {record.transport === 'ssh' && (
          <>
            <dt>{t('detail.sshPort')}</dt>
            <dd className="num">{record.port}</dd>
            <dt>{t('detail.remotePort')}</dt>
            <dd className="num">{record.remotePort}</dd>
            <dt>{t('detail.tunnel')}</dt>
            <dd className="num">
              {record.localPort ? `127.0.0.1:${record.localPort}` : t('detail.unassigned')}
            </dd>
            <dt>{t('detail.identityFile')}</dt>
            <dd className="num">{record.identityFile ?? t('detail.defaultAgentFirst')}</dd>
          </>
        )}
        {record.transport === 'http' && (
          <>
            <dt>{t('detail.authMode')}</dt>
            <dd>
              {record.authMode === 'none'
                ? t('detail.authNone')
                : record.authMode === 'gateway'
                  ? t('detail.authGateway')
                  : t('detail.authAuto')}
            </dd>
          </>
        )}
      </dl>
      {/* 直连 HTTP 使用明文数据连接，显示可访问的常驻警告。 */}
      {record.transport === 'http' && isCleartextEndpoint(record.endpointUrl) && (
        <span
          className="warn-pill"
          data-testid="cleartext-warning"
          data-tip={t('detail.cleartextWarning')}
          aria-label={t('detail.cleartextWarning')}
          tabIndex={0}
        >
          <Icon name="alert" />
          <span>{t('detail.cleartextBadge')}</span>
        </span>
      )}
      <div className="row mt12">
        {showAuthActions(record) && (
          <button className="btn btn-primary btn-sm" data-testid="login-btn" onClick={onLogin}>
            <Icon name="key" /> {/* 已连接时显示“重新登录”，否则显示“登录”。 */}
            {authPhase === 'connected' ? t('detail.relogin') : t('detail.login')}
          </button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={onCopyAddress}>
          <Icon name="copy" /> {t('detail.address')}
        </button>
        {canOpenInBrowser && (
          <button
            className="btn btn-secondary btn-sm"
            data-testid="open-in-browser-btn"
            onClick={onOpenInBrowser}
          >
            <Icon name="external" /> {t('detail.openInBrowser')}
          </button>
        )}
        {onOpenDirectory && (
          <button
            className="btn btn-secondary btn-sm"
            data-testid="open-instance-dir-btn"
            onClick={onOpenDirectory}
          >
            <Icon name="folder" /> {t('detail.openDir')}
          </button>
        )}
        <button
          className="btn btn-secondary btn-sm"
          data-testid="disconnect-view-btn"
          onClick={onDisconnect}
        >
          <Icon name="close" /> {t('detail.disconnect')}
        </button>
        {/* 仅在已连接时显示登出操作。 */}
        {showAuthActions(record) && authPhase === 'connected' && (
          <button className="btn btn-secondary btn-sm" data-testid="logout-btn" onClick={onLogout}>
            <Icon name="close" /> {t('detail.logout')}
          </button>
        )}
      </div>
    </div>
  )
}
