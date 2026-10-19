import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ExternalDshWebSnapshot } from '@shared/contracts'
import { Icon } from '../lib/icons'
import { STATUS_INFO, TYPE_INFO, addressOf, toDisplayStatus } from '../lib/format'
import { formatActivity } from '../lib/activity-format'
import { useAppStore } from '../store'
import { DeleteConfirmModal } from './DeleteConfirmModal'
import EditInstanceDialog from './EditInstanceDialog'
import VaultCard from './VaultCard'
import { useDshVersionControl } from './useDshVersionControl'
import { showAuthActions } from '../lib/auth-actions'
import ConnectionCard from './detail/ConnectionCard'
import RuntimeCard from './detail/RuntimeCard'
import ExternalTokenEditor from './detail/ExternalTokenEditor'
import ExternalDshCard from './detail/ExternalDshCard'
import ActivityLogBar from './detail/ActivityLogBar'
import PluginsCard from './detail/PluginsCard'

/** 实例详情。 */
export default function DetailView(): ReactNode {
  const selection = useAppStore((state) => state.selection)
  const t = useAppStore((state) => state.t)
  const record = useAppStore((state) => (selection ? state.records[selection] : undefined))
  const status = useAppStore((state) => (selection ? state.statuses[selection] : undefined))
  const workspaceConnected = useAppStore((state) =>
    selection ? (state.workspaceConnected[selection] ?? true) : true
  )
  const authPhase = useAppStore((state) => (selection ? state.authPhases[selection] : undefined))
  const ensureRecord = useAppStore((state) => state.ensureRecord)
  const select = useAppStore((state) => state.select)
  const refreshList = useAppStore((state) => state.refreshList)
  const removeInstance = useAppStore((state) => state.removeInstance)
  const disconnectWorkspace = useAppStore((state) => state.disconnectWorkspace)
  const toast = useAppStore((state) => state.toast)
  const openWorkspace = useAppStore((state) => state.openWorkspace)
  const setPendingOpen = useAppStore((state) => state.setPendingOpen)
  const localHome = useAppStore((state) =>
    selection ? state.instances.find((instance) => instance.id === selection)?.localHome : undefined
  )
  const activity = useAppStore((state) => (selection ? state.activityLog[selection] : undefined))
  const clearActivity = useAppStore((state) => state.clearActivity)
  const [showLogMore, setShowLogMore] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [trashSpace, setTrashSpace] = useState(false)
  const [showEdit, setShowEdit] = useState(false)
  /** 检测尚未由 Hub 管理的本地 dsh web 进程。 */
  const [externalDsh, setExternalDsh] = useState<ExternalDshWebSnapshot[]>([])
  const [adopting, setAdopting] = useState<number | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [externalAccess, setExternalAccess] = useState<Record<number, string>>({})
  const [showExternalTokenEditor, setShowExternalTokenEditor] = useState(false)
  const [externalToken, setExternalToken] = useState('')
  // dsh 版本管理仅本机实例：检查更新对比的是本机 npm 镜像，远程实例版本 hub 无从得知也不受 hub 管。
  const versionControl = useDshVersionControl(
    record && record.transport === 'local' ? record.id : null
  )

  useEffect(() => {
    if (selection) void ensureRecord(selection)
  }, [selection, ensureRecord])

  // 认证相位未知时探测一次，使操作按钮反映当前会话状态。
  useEffect(() => {
    if (!selection || !record) return
    if (!showAuthActions(record)) return
    if (authPhase !== undefined) return
    void window.dshHub?.auth.probe(selection)
  }, [selection, record, authPhase])

  // 本机已在运行的 dsh web:仅本地实例且未运行时探测(探测是只读 ps+lsof,便宜)。
  // 用局部常量做依赖,避免把整个 record 对象拖进依赖数组。
  const runningNow = status?.status === 'running'
  const externalRuntime = status?.runtimeSource === 'external'
  const recordId = record?.id
  const recordTransport = record?.transport
  useEffect(() => {
    if (!recordTransport || recordTransport !== 'local' || runningNow) {
      setExternalDsh([])
      return
    }
    let cancelled = false
    void window.dshHub?.runtime.scanExternal().then((result) => {
      if (cancelled) return
      setExternalDsh(result?.ok ? result.value.filter((item) => item.port !== null) : [])
    })
    return () => {
      cancelled = true
    }
  }, [recordId, recordTransport, runningNow])

  /** 登出会清除主进程客户端和该实例分区的会话 Cookie。 */
  const logout = async (): Promise<void> => {
    if (!record) return
    const result = await window.dshHub?.auth.logout(record.id)
    if (result?.ok) toast('ok', t('detail.loggedOut'), t('detail.loggedOutDetail'))
  }

  if (!selection) return null
  if (!record) {
    return (
      <section data-testid="view-detail-missing">
        <p className="meta">{t('detail.missingHint')}</p>
        <button className="btn btn-secondary btn-sm mt12" onClick={() => select(null)}>
          {t('common.backToOverview')}
        </button>
      </section>
    )
  }

  const display = toDisplayStatus(status?.status, workspaceConnected)
  const info = STATUS_INFO[display]
  const version =
    status?.version ?? (record.transport === 'local' ? record.dshVersion : null) ?? '—'
  /** 最近一次启动命令：运行中以状态事件为准，其后回落到注册表回写的值；外部接管的进程不归 hub 启动。 */
  const runCommand: string | null =
    record.transport === 'local' && status?.runtimeSource !== 'external'
      ? (status?.command ?? record.runCommand ?? null)
      : null

  /** 重启与关闭只针对 hub 拉起的运行中本地进程；外部接管的进程归用户所有。 */
  const canControlRuntime =
    record.transport === 'local' &&
    status?.status === 'running' &&
    status.runtimeSource !== 'external'

  const copyAddress = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(addressOf(record))
      toast('ok', t('detail.addressCopied'))
    } catch {
      toast('err', t('detail.copyFailed'))
    }
  }

  /** 在系统默认浏览器中打开实例地址；URL 由主进程解析（本机带 token，token 不经渲染层）。 */
  const openInBrowser = async (): Promise<void> => {
    const result = await window.dshHub?.runtime.openInBrowser(record.id)
    if (result && !result.ok) toast('err', t('detail.openInBrowserFailed'), result.message)
  }

  /** 在系统文件管理器中打开本机实例的数据目录（DSH_HOME）；路径由主进程解析。 */
  const openInstanceDirectory = async (): Promise<void> => {
    const result = await window.dshHub?.instances.openDirectory(record.id)
    if (result && !result.ok) toast('err', t('detail.openDirFailed'), result.message)
  }

  /** 在系统文件管理器中打开本机实例的日志目录；路径由主进程解析。 */
  const openInstanceLogDirectory = async (): Promise<void> => {
    const result = await window.dshHub?.instances.openLogDirectory(record.id)
    if (result && !result.ok) toast('err', t('detail.openLogDirFailed'), result.message)
  }

  /** 复制全部日志（时间 + 阶段原文，逐行）。 */
  const copyActivity = async (): Promise<void> => {
    if (activity === undefined || activity.length === 0) return
    try {
      await navigator.clipboard.writeText(
        activity.map((line) => formatActivity(t, line)).join('\n')
      )
      toast('ok', t('detail.log.copied'))
    } catch {
      toast('err', t('detail.copyFailed'))
    }
  }

  /** 重启 hub 托管的本地 dsh 进程；进程归用户所有的外部接管实例不提供该操作。 */
  const restartRuntime = async (): Promise<void> => {
    if (restarting) return
    // 在调用前捕获连接态：重启内部的停止事件会先于 IPC 返回把它置为 false
    const wasConnected = workspaceConnected
    setRestarting(true)
    try {
      const result = await window.dshHub?.runtime.restart(record.id)
      if (!result?.ok) {
        toast('err', t('detail.restartFailed'), result?.message)
        return
      }
      // 重启可能分配新端口与新 browser-auth URL：工作区开着时置 pendingOpen，
      // 由 running 状态事件自动重开，避免停留在已失效的旧页面。
      if (wasConnected) setPendingOpen(record.id)
    } finally {
      setRestarting(false)
    }
  }

  /** 关闭本地实例：先断开内嵌工作区，再停止运行时；状态由 stopped 事件推进。 */
  const stopRuntime = async (): Promise<void> => {
    if (stopping) return
    setStopping(true)
    try {
      await disconnectWorkspace(record.id)
      const result = await window.dshHub?.runtime.stop(record.id)
      if (!result?.ok) {
        toast('err', t('detail.stopFailed'), result?.message)
        return
      }
      toast('ok', t('detail.stopped'))
    } finally {
      setStopping(false)
    }
  }

  const deleteInstance = async (): Promise<void> => {
    const removed = await removeInstance({ id: record.id, name: record.name, trashSpace })
    if (!removed) return
    setTrashSpace(false)
    select(null)
    void refreshList()
  }

  /** 更新外部接管 token：重新扫描本机进程按端口匹配后接管。 */
  const updateExternalToken = async (): Promise<void> => {
    const bridge = window.dshHub
    if (!bridge || record.transport !== 'local') return
    const token = externalToken.trim()
    if (token === '') {
      toast('err', t('detail.adoptFailed'), t('wizard.errExternalAccess'))
      return
    }
    const scanned = await bridge.runtime.scanExternal()
    if (!scanned.ok) {
      toast('err', t('detail.adoptFailed'), scanned.message)
      return
    }
    const targetPort = status?.port ?? record.port
    const candidate =
      scanned.value.find((item) => item.port === targetPort) ??
      (scanned.value.length === 1 ? scanned.value[0] : undefined)
    if (!candidate) {
      toast('err', t('detail.adoptFailed'), t('detail.externalTokenBody'))
      return
    }
    setAdopting(candidate.pid)
    const result = await bridge.runtime.adoptExternal(record.id, candidate.pid, token)
    setAdopting(null)
    if (!result.ok) {
      toast('err', t('detail.adoptFailed'), result.message)
      return
    }
    setExternalToken('')
    setShowExternalTokenEditor(false)
    void openWorkspace(record.id)
  }

  /** 从「未纳管进程」列表接管一条：填入的 token 现场提交。 */
  const adoptExternalDsh = (pid: number, port: number | null): void => {
    setAdopting(pid)
    void window.dshHub?.runtime
      .adoptExternal(record.id, pid, externalAccess[pid] ?? '')
      .then((result) => {
        if (result && !result.ok) {
          toast('err', t('detail.adoptFailed'), result.message)
        } else {
          toast('ok', t('detail.adopted'), `127.0.0.1:${port}`)
          void openWorkspace(record.id)
        }
      })
      .finally(() => setAdopting(null))
  }

  const openOrStart = (): void => {
    if (record.transport === 'local') {
      if (status?.status === 'running') {
        void openWorkspace(record.id)
        return
      }
      setPendingOpen(record.id)
      void window.dshHub?.runtime.start(record.id).then((result) => {
        if (!result?.ok) toast('err', t('detail.startFailed'), result?.message)
      })
      return
    }
    void openWorkspace(record.id)
  }

  const openAuthPanel = (): void => {
    window.dispatchEvent(
      new CustomEvent('dsh-hub:open-auth', { detail: { id: record.id, name: record.name } })
    )
  }

  return (
    <section className="detail-page" data-od-id="view-detail" data-testid="view-detail">
      <div className="row-between" style={{ alignItems: 'flex-start' }}>
        <div className="row" style={{ gap: 12 }}>
          <span className="brand-mark">
            <Icon name={TYPE_INFO[record.transport].icon} />
          </span>
          <div>
            <div className="row" style={{ gap: 8 }}>
              <h2>{record.name}</h2>
              <span className="badge">
                <Icon name={TYPE_INFO[record.transport].icon} size={11} />
                {t(TYPE_INFO[record.transport].labelKey)}
              </span>
            </div>
            <p className="meta" style={{ marginTop: 4 }}>
              <span className={`chip ${info.chipClass}`}>
                <span className={`status-dot ${info.dotClass}`} aria-hidden="true" />
                {t(info.labelKey)}
              </span>
            </p>
          </div>
        </div>
        <div className="row">
          <button
            className="btn btn-ghost btn-sm detail-overview-btn"
            onClick={() => select(null)}
            data-testid="detail-overview-btn"
          >
            <Icon name="back" /> {t('detail.overview')}
          </button>
        </div>
      </div>

      <div className="grid-2 mt20">
        <ConnectionCard
          t={t}
          record={record}
          authPhase={authPhase}
          canOpenInBrowser={
            record.transport === 'http' ||
            (record.transport === 'local' && status?.status === 'running')
          }
          onLogin={openAuthPanel}
          onCopyAddress={() => void copyAddress()}
          onOpenInBrowser={() => void openInBrowser()}
          onOpenDirectory={
            record.transport === 'local' ? () => void openInstanceDirectory() : undefined
          }
          onDisconnect={() => void disconnectWorkspace(record.id)}
          onLogout={() => void logout()}
        />

        {/* 凭据默认持久化，用户可在实例详情中显式取消。 */}
        {showAuthActions(record) && <VaultCard key={record.id} instanceId={record.id} />}

        <RuntimeCard
          t={t}
          record={record}
          status={status}
          display={display}
          version={version}
          runCommand={runCommand}
          localHome={localHome}
          control={{ canControl: canControlRuntime, restarting, stopping }}
          versionControl={versionControl}
          actions={{
            openOrStart,
            restart: () => void restartRuntime(),
            stop: () => void stopRuntime(),
            edit: () => setShowEdit(true)
          }}
        />

        {record.transport === 'local' && (externalRuntime || showExternalTokenEditor) && (
          <ExternalTokenEditor
            t={t}
            value={externalToken}
            onChange={setExternalToken}
            onSubmit={() => void updateExternalToken()}
            busy={adopting !== null}
          />
        )}

        {/* 显示尚未由 Hub 管理的本地 dsh web 进程，供用户接管。 */}
        {record.transport === 'local' && externalDsh.length > 0 && (
          <ExternalDshCard
            t={t}
            items={externalDsh}
            accessById={externalAccess}
            setAccess={setExternalAccess}
            adopting={adopting}
            onAdopt={adoptExternalDsh}
          />
        )}
      </div>

      {/* 插件管理：仅本机实例，通过 dsh plugin --profile <p> 列出与增删该实例环境的插件。 */}
      {record.transport === 'local' && <PluginsCard key={record.id} t={t} instanceId={record.id} />}

      <ActivityLogBar
        t={t}
        activity={activity}
        showMore={showLogMore}
        setShowMore={setShowLogMore}
        onCopy={() => void copyActivity()}
        onClear={() => clearActivity(record.id)}
        onOpenLogDir={
          record.transport === 'local' ? () => void openInstanceLogDirectory() : undefined
        }
      />

      <div className="detail-delete" data-testid="detail-delete-area">
        <span className="meta">{t('detail.deleteBody')}</span>
        <button
          className="detail-delete-btn detail-delete-btn--collapsed"
          onClick={() => setConfirmDelete(true)}
          data-testid="delete-btn"
          aria-label={t('detail.deleteInstance')}
          title={t('detail.deleteInstance')}
        >
          <Icon name="trash" />
          <span className="detail-delete-label">{t('detail.deleteInstance')}</span>
        </button>
      </div>

      {confirmDelete && (
        <DeleteConfirmModal
          testId="confirm-delete"
          name={record.name}
          showTrashSpace={record.transport === 'local' && !record.useDefaultSpace}
          trashSpace={trashSpace}
          onTrashSpaceChange={setTrashSpace}
          onClose={() => {
            setConfirmDelete(false)
            setTrashSpace(false)
          }}
          onConfirm={() => void deleteInstance()}
        />
      )}

      {showEdit && (
        <EditInstanceDialog
          key={record.id}
          record={record}
          running={status?.status === 'running'}
          onClose={() => setShowEdit(false)}
        />
      )}
    </section>
  )
}
