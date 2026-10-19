import type { ReactNode } from 'react'
import type { InstanceRecord, InstanceStatusEvent } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import type { DisplayStatus } from '../../lib/format'
import { DshVersionCheckButton, DshVersionPanel } from '../DshVersionControl'
import type { DshVersionControl } from '../useDshVersionControl'

/** 运行时操作回调集合（打开/启动、重启、关闭、编辑）。 */
export interface RuntimeActions {
  openOrStart: () => void
  restart: () => void
  stop: () => void
  edit: () => void
}

/** 运行时控制态：是否可控（hub 托管）、重启/关闭进行中。 */
export interface RuntimeControlState {
  canControl: boolean
  restarting: boolean
  stopping: boolean
}

export interface RuntimeCardProps {
  t: Translator
  record: InstanceRecord
  status: InstanceStatusEvent | undefined
  display: DisplayStatus
  version: string
  runCommand: string | null
  localHome: string | undefined
  control: RuntimeControlState
  versionControl: DshVersionControl | null
  actions: RuntimeActions
}

/** 运行环境卡：版本/端口/数据目录/启动命令，打开工作区、重启、关闭、编辑与检查更新。 */
export default function RuntimeCard(props: RuntimeCardProps): ReactNode {
  const {
    t,
    record,
    status,
    display,
    version,
    runCommand,
    localHome,
    control,
    versionControl,
    actions
  } = props
  const { canControl, restarting, stopping } = control
  return (
    <div className="card runtime-card selectable">
      <div className="card-head">
        <h3>{t('detail.runtime')}</h3>
        <span className="meta">
          {record.transport === 'local' ? t('detail.localSide') : t('detail.remoteSide')}
        </span>
      </div>
      <dl className="kv">
        <dt>{t('detail.dshVersion')}</dt>
        <dd className="num">{version}</dd>
        {record.transport === 'local' && (
          <>
            <dt>{t('detail.port')}</dt>
            {/* 已接管进程的运行端口优先使用状态事件中的端口。 */}
            <dd className="num">{status?.port ?? record.port ?? t('detail.unassigned')}</dd>
            <dt>{t('settings.dataDir')}</dt>
            <dd className="num" title={t('detail.dataDirTitle')}>
              {status?.runtimeSource === 'external'
                ? t('detail.externalDataDir')
                : (localHome ?? `…/homes/${record.id}`)}
            </dd>
            {/* 启动命令仅 hub 拉起的本机进程才有；尚未启动过的实例隐藏该行。 */}
            {runCommand !== null && (
              <>
                <dt>{t('detail.runCommand')}</dt>
                <dd className="num">{runCommand}</dd>
              </>
            )}
          </>
        )}
      </dl>
      {/* dsh 版本管理：检测结果与升级进度留在正文，检查更新按钮在下方操作行。 */}
      <DshVersionPanel control={versionControl} />
      {/*
        分隔线上方 = 数据与检测结果（升级按钮/版本状态），下方 = 操作按钮；
        整组仍贴卡底（贴底与线上的最小间距由 runtime-actions-wrap 提供）。
      */}
      <div className="runtime-actions-wrap">
        <div className="runtime-actions-divider" aria-hidden="true" />
        <div className="row mt12 runtime-actions">
          <button
            className="btn btn-primary btn-sm"
            onClick={actions.openOrStart}
            disabled={display === 'connecting'}
            data-testid="open-view-btn"
          >
            <Icon name="external" />
            {display === 'connecting'
              ? t('detail.openingWorkspace')
              : status?.status === 'running'
                ? t('detail.openWorkspace')
                : t('detail.startWorkspace')}
          </button>
          {/* 重启只针对 hub 拉起的运行中进程；外部接管的进程归用户所有。 */}
          {canControl && (
            <button
              className="btn btn-danger btn-sm"
              onClick={actions.restart}
              disabled={restarting}
              data-testid="restart-btn"
            >
              <Icon name="refresh" /> {restarting ? t('detail.restarting') : t('detail.restart')}
            </button>
          )}
          {/* 关闭实例：断开工作区并停止 hub 托管的运行中进程；外部接管进程归用户所有，不提供。 */}
          {canControl && (
            <button
              className="btn btn-danger btn-sm"
              onClick={actions.stop}
              disabled={stopping}
              data-testid="stop-btn"
            >
              <Icon name="power" /> {stopping ? t('detail.stopping') : t('detail.stop')}
            </button>
          )}
          {/* transport 不可修改；端口留空时自动分配，运行中修改在下次启动生效。 */}
          <button
            className="btn btn-secondary btn-sm"
            onClick={actions.edit}
            data-testid="edit-btn"
          >
            <Icon name="edit" /> {t('edit.openButton')}
          </button>
          {/* 检查更新与编辑同一行，放在编辑之后。 */}
          <DshVersionCheckButton control={versionControl} />
        </div>
      </div>
    </div>
  )
}
