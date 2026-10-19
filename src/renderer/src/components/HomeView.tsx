import { useState } from 'react'
import type { ReactNode } from 'react'
import type { InstanceSummary } from '@shared/contracts'
import { Icon } from '../lib/icons'
import { TYPE_INFO, toDisplayStatus, toStatusInfo } from '../lib/format'
import type { DisplayStatusInfo } from '../lib/format'
import { useAppStore } from '../store'
import { DeleteConfirmModal } from './DeleteConfirmModal'
import type { MessageKey } from '@shared/i18n/messages'

/** 总览页：统计卡和全部实例表格。 */
export default function HomeView(): ReactNode {
  const loaded = useAppStore((state) => state.loaded)
  if (!loaded) return <SkeletonHome />
  return <HomeContent />
}

function HomeContent(): ReactNode {
  const t = useAppStore((state) => state.t)
  const instances = useAppStore((state) => state.instances)
  const statuses = useAppStore((state) => state.statuses)
  const workspaceConnected = useAppStore((state) => state.workspaceConnected)
  const openDetail = useAppStore((state) => state.openDetail)
  const removeInstance = useAppStore((state) => state.removeInstance)
  const refreshList = useAppStore((state) => state.refreshList)
  const [deleteTarget, setDeleteTarget] = useState<InstanceSummary | null>(null)
  const [trashSpace, setTrashSpace] = useState(false)

  const connected = instances.filter(
    (item) =>
      toDisplayStatus(statuses[item.id]?.status, workspaceConnected[item.id] ?? true) ===
      'connected'
  ).length
  const attention = instances.filter(
    (item) => toDisplayStatus(statuses[item.id]?.status) === 'error'
  ).length

  const deleteInstance = async (): Promise<void> => {
    if (!deleteTarget) return
    const removed = await removeInstance({
      id: deleteTarget.id,
      name: deleteTarget.name,
      trashSpace
    })
    if (!removed) return
    setDeleteTarget(null)
    setTrashSpace(false)
    await refreshList()
  }

  return (
    <section data-od-id="view-home" data-testid="view-home">
      <div className="page-head">
        <p className="eyebrow">INSTANCE OVERVIEW</p>
        <h1>{t('home.heroTitle', { n: connected })}</h1>
        <p className="lead">{t('home.heroBody')}</p>
      </div>
      <div className="grid-3 mt24">
        <StatCard n={instances.length} label={t('home.statInstances')} />
        <StatCard n={connected} label={t('home.statConnected')} />
        <StatCard n={attention} label={t('home.statAttention')} />
      </div>
      <div className="card mt20">
        <div className="card-head">
          <h3>{t('home.allInstances')}</h3>
          <span className="meta">{t('home.liveStatus')}</span>
        </div>
        <table className="ds-table" data-testid="instances-table">
          <thead>
            <tr>
              <th>{t('home.colInstance')}</th>
              <th>{t('home.colType')}</th>
              <th>{t('home.colStatus')}</th>
              <th>{t('home.colAddress')}</th>
              <th className="num-col">{t('home.colVersion')}</th>
              <th className="num-col">{t('home.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {/* 状态事件更新切片引用后，表格会重新渲染当前状态。 */}
            {instances.map((item) => (
              <TableRow
                key={item.id}
                item={item}
                info={toStatusInfo(statuses[item.id]?.status, workspaceConnected[item.id] ?? true)}
                version={statuses[item.id]?.version ?? item.version}
                onDetail={() => openDetail(item.id)}
                onDelete={() => setDeleteTarget(item)}
              />
            ))}
          </tbody>
        </table>
      </div>
      {deleteTarget && (
        <DeleteConfirmModal
          testId="home-confirm-delete"
          name={deleteTarget.name}
          showTrashSpace={deleteTarget.transport === 'local' && !deleteTarget.useDefaultSpace}
          trashSpace={trashSpace}
          onTrashSpaceChange={setTrashSpace}
          onClose={() => {
            setDeleteTarget(null)
            setTrashSpace(false)
          }}
          onConfirm={() => void deleteInstance()}
        />
      )}
    </section>
  )
}

function StatCard(props: { n: number; label: string }): ReactNode {
  return (
    <div className="card stat">
      <div className="stat-num num">{props.n}</div>
      <p className="stat-label">{props.label}</p>
    </div>
  )
}

function TableRow(props: {
  item: InstanceSummary
  info: DisplayStatusInfo
  version?: string
  onDetail: () => void
  onDelete: () => void
}): ReactNode {
  const t = useAppStore((state) => state.t)
  return (
    <tr>
      <td>
        <button className="row" onClick={props.onDetail} style={{ gap: 7 }}>
          {/* 使用共享映射提供状态圆点修饰类。 */}
          <span className={`status-dot ${props.info.dotClass}`} aria-hidden="true" />
          <span>{props.item.name}</span>
        </button>
      </td>
      <td>
        <span className="badge">
          <Icon name={TYPE_INFO[props.item.transport].icon} size={11} />
          {t(TYPE_INFO[props.item.transport].labelKey)}
        </span>
      </td>
      <td>
        <span className={`chip ${props.info.chipClass}`}>{t(props.info.labelKey)}</span>
      </td>
      <td className="meta">{props.item.address}</td>
      <td className="num-col meta">{props.version ?? '—'}</td>
      <td className="num-col">
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button
            className="btn btn-ghost btn-sm"
            onClick={props.onDetail}
            data-testid={`detail-${props.item.id}`}
          >
            {t('home.viewDetail')}
          </button>
          <button
            className="btn btn-danger btn-sm"
            onClick={props.onDelete}
            data-testid={`delete-${props.item.id}`}
            aria-label={t('detail.deleteInstance')}
          >
            <Icon name="trash" />
          </button>
        </div>
      </td>
    </tr>
  )
}

/** 首次加载时显示统计卡和表格行占位，避免空白闪烁。 */
function SkeletonHome(): ReactNode {
  const t = useAppStore((state) => state.t)
  return (
    <section data-testid="view-home-skeleton" aria-busy="true" aria-label={t('home.loadingList')}>
      <div className="page-head">
        <div className="skel" style={{ width: 150, height: 13 }} />
        <div className="skel" style={{ width: 260, height: 26, marginTop: 8 }} />
        <div className="skel" style={{ width: '70%', maxWidth: 560, height: 13, marginTop: 10 }} />
      </div>
      <div className="grid-3 mt24 skel-stats">
        {[0, 1, 2].map((i) => (
          <div className="card" key={i}>
            <div className="skel skel-stat-line" />
            <div className="skel" style={{ width: '64%', height: 11 }} />
          </div>
        ))}
      </div>
      <div className="card mt20">
        <div className="card-head">
          <div className="skel" style={{ width: 90, height: 15 }} />
        </div>
        <table className="ds-table">
          <thead>
            <tr>
              {[
                'home.colInstance',
                'home.colType',
                'home.colStatus',
                'home.colAddress',
                'home.colVersion',
                'home.colActions'
              ].map((head) => (
                <th key={head}>{t(head as MessageKey)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3].map((row) => (
              <tr className="skel-row" key={row}>
                <td>
                  <div className="skel skel-cell" style={{ width: '52%' }} />
                </td>
                <td>
                  <div className="skel skel-cell" style={{ width: 44 }} />
                </td>
                <td>
                  <div className="skel skel-cell" style={{ width: 64 }} />
                </td>
                <td>
                  <div className="skel skel-cell" style={{ width: '68%' }} />
                </td>
                <td>
                  <div className="skel skel-cell" style={{ width: 48 }} />
                </td>
                <td>
                  <div className="skel skel-cell" style={{ width: 56, marginLeft: 'auto' }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
