import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  PluginAutoDisabled,
  PluginInfo,
  PluginInstallPlan,
  PluginRegistryOption,
  PluginUpdateCheck
} from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import { fmtLogTime } from '../../lib/format'
import { runWithConcurrency } from '../../lib/concurrency'
import { ackAutoDisabled, isAutoDisabledAcked } from '../../lib/auto-disabled-ack'
import { useAppStore } from '../../store'
import {
  classifyCheckOutcome,
  initialCheckState,
  pluginApplyNotice,
  pruneChecks,
  restoreChecks,
  type PluginCheckState
} from '../../lib/plugins-card-state'
import InstallPluginDialog from './InstallPluginDialog'
import type { InstallConfirmation } from './InstallPluginDialog'
import UpgradeConfirmDialog from './UpgradeConfirmDialog'
import type { UpgradeOutcome } from './UpgradeConfirmDialog'
import {
  PluginRow,
  RemovePluginModal,
  RestartPromptModal,
  type RemoveTarget,
  type RowBusy
} from './plugins-card-parts'

const BRIDGE = window.dshHub

/**
 * 一键检查的并发度：每个检查是一个独立的 `dsh plugin view` 子进程（联网），
 * 串行太慢、无上限并发会同时拉起过多子进程与请求，取一个折中的小并发。
 */
const CHECK_CONCURRENCY = 4

/** 升级二次确认目标：点行内「升级到 x」后先确认再执行。 */
interface UpgradeTarget {
  name: string
  version: string
}

/** 重启提醒目标（改动含 host 半后弹出）。 */
interface RestartPrompt {
  name: string
}

/** 实例详情的插件管理卡：列表 + 手风琴详情 + 检查升级/卸载/安装 + host 半重启提醒。 */
export default function PluginsCard(props: { t: Translator; instanceId: string }): ReactNode {
  const { t, instanceId } = props
  const toast = useAppStore((state) => state.toast)
  const language = useAppStore((state) => state.language)
  const setPendingOpen = useAppStore((state) => state.setPendingOpen)
  const appendActivity = useAppStore((state) => state.appendActivity)
  /** 领取「已自动禁用」提示的发送权（每实例每个 dsh 版本只发一次）。 */
  const notifyAutoDisabledOnce = useAppStore((state) => state.notifyAutoDisabledOnce)
  const workspaceConnected = useAppStore((state) => state.workspaceConnected[instanceId] ?? false)
  /** 实例是否运行中：决定改动提示是「已保存」还是「已生效/需重启」。 */
  const instanceRunning = useAppStore((state) => state.statuses[instanceId]?.status === 'running')

  /** 把一条插件操作日志写入实例底部信息栏（与运行时状态同一时间线）。 */
  const logActivity = useCallback(
    (detail: string): void => {
      appendActivity(instanceId, { source: 'runtime', at: new Date().toISOString(), detail })
    },
    [appendActivity, instanceId]
  )

  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, PluginCheckState>>({})
  const [busy, setBusy] = useState<Record<string, RowBusy>>({})
  const [showInstall, setShowInstall] = useState(false)
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null)
  const [upgradeTarget, setUpgradeTarget] = useState<UpgradeTarget | null>(null)
  const [restartPrompt, setRestartPrompt] = useState<RestartPrompt | null>(null)
  /** 上次「检查更新」完成时刻（对整卡的批量或单条检查都刷新）；null = 本会话尚未检查。 */
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null)
  /** 上次运行时核对中被自动禁用的插件（界面提示用）；null = 无。 */
  const [autoDisabled, setAutoDisabled] = useState<PluginAutoDisabled[] | null>(null)
  const [checkingAll, setCheckingAll] = useState(false)

  /**
   * 拉取插件列表与持久化的检查状态。keepChecks=true 时保留内存里的检查结果（只按最新列表
   * 剪除已卸载插件的项），用于安装/升级/卸载后刷新；缺省（初次加载 / 手动刷新）用持久化状态
   * 重建——用户切走再回来（或重启应用）仍能看到可升级标记与「检查中…」。
   */
  const load = useCallback(
    async (options?: { keepChecks?: boolean }): Promise<void> => {
      if (!BRIDGE) return
      setLoading(true)
      setLoadError(null)
      const [result, state] = await Promise.all([
        BRIDGE.plugin.list(instanceId, language),
        BRIDGE.plugin.checkState(instanceId)
      ])
      setLoading(false)
      if (result.ok) {
        setPlugins(result.value)
        if (options?.keepChecks) {
          const names = result.value.map((plugin) => plugin.name)
          setChecks((prev) => pruneChecks(prev, names))
        } else {
          setChecks(restoreChecks(result.value, state.ok ? state.value : null))
        }
        if (state.ok) {
          setLastCheckedAt(state.value.lastCheckedAt)
          const disabled = state.value.autoDisabled
          const dshVersion = disabled[0]?.dshVersion ?? ''
          // 用户已确认过这一批（「知道了」记在 localStorage，刷新与应用重启后依然有效）时，
          // 提示条与一次性提示都不再出现；dsh 版本再次变更会重新提示。
          const acked =
            disabled.length > 0 && isAutoDisabledAcked(localStorage, instanceId, dshVersion)
          setAutoDisabled(disabled.length > 0 && !acked ? disabled : null)
          // 同一次自动禁用只提示一次：发送权记在 store 里（同步判定），
          // 因此并发的两次加载（dev StrictMode 会双调用挂载 effect）与组件重挂载都不会重复弹。
          if (disabled.length > 0 && !acked && notifyAutoDisabledOnce(instanceId, dshVersion)) {
            const list = disabled.map((item) => item.name).join(t('common.listSeparator'))
            logActivity(t('detail.plugin.log.autoDisabled', { dshVersion, list }))
            toast(
              'err',
              t('detail.plugin.autoDisabledTitle'),
              t('detail.plugin.autoDisabledBody', {
                dshVersion,
                list
              })
            )
          }
        }
      } else {
        setLoadError(result.message)
        setPlugins([])
        // 列表都拿不到属于异常信息：写入信息栏留痕，界面同时显示行内错误。
        logActivity(t('detail.plugin.log.loadFailed', { msg: result.message }))
      }
    },
    [instanceId, language, logActivity, t, toast, notifyAutoDisabledOnce]
  )

  useEffect(() => {
    void load()
  }, [load])

  /** 「知道了」：记下这一批的确认（刷新与应用重启后都不再提示），并立即收起提示条。 */
  const dismissAutoDisabled = (): void => {
    const dshVersion = autoDisabled?.[0]?.dshVersion ?? ''
    if (dshVersion !== '') ackAutoDisabled(localStorage, instanceId, dshVersion)
    setAutoDisabled(null)
  }

  const rowBusy = (name: string): RowBusy =>
    busy[name] ?? { upgrading: false, removing: false, toggling: false }
  const setRowBusy = (name: string, patch: Partial<RowBusy>): void =>
    setBusy((prev) => ({ ...prev, [name]: { ...rowBusy(name), ...patch } }))

  const checkOf = (name: string): PluginCheckState => checks[name] ?? initialCheckState

  /**
   * 一次检查结果写入底部信息栏：有更新与异常（不兼容 / 无法判定）各记一条；
   * 「已是最新」不记 —— 每次检查都写会让信息栏被无信息量的行刷满。
   */
  const logCheckOutcome = (result: PluginUpdateCheck): void => {
    const outcome = classifyCheckOutcome(result)
    if (outcome === 'update') {
      logActivity(
        t('detail.plugin.log.updateAvailable', {
          name: result.name,
          latest: result.latest,
          current: result.current
        })
      )
    } else if (outcome === 'incompatible') {
      logActivity(
        t('detail.plugin.log.incompatible', {
          name: result.name,
          latest: result.latest,
          peer: result.dshPeer ?? '—',
          current: result.dshVersion ?? '—'
        })
      )
    }
  }

  /** 检查单个插件；返回是否成功（供批量检查汇总）。 */
  const runCheck = async (name: string): Promise<void> => {
    if (!BRIDGE) return
    setChecks((prev) => ({ ...prev, [name]: { status: 'checking', result: null, error: null } }))
    const result = await BRIDGE.plugin.check(instanceId, name)
    if (result.ok) {
      setChecks((prev) => ({
        ...prev,
        [name]: { status: 'done', result: result.value, error: null }
      }))
      logCheckOutcome(result.value)
    } else {
      setChecks((prev) => ({
        ...prev,
        [name]: { status: 'error', result: null, error: result.message }
      }))
      logActivity(t('detail.plugin.log.checkFailed', { name, msg: result.message }))
    }
    setLastCheckedAt(new Date().toISOString())
  }

  /**
   * 一键批量检查所有插件更新：小并发（CHECK_CONCURRENCY）同时进行，避免串行过慢，
   * 也不至于同时拉起过多子进程；批量期间单行检查按钮锁定，保证同一时刻只有系统检查在跑。
   * 用户切换界面时本函数继续执行到结束（结果由主进程落盘，回来仍能看到标记）。
   * 信息栏按类别汇总各记一行（可升级 / 不兼容 / 失败），不逐插件刷屏。
   */
  const runCheckAll = async (): Promise<void> => {
    if (!BRIDGE || plugins === null || checkingAll) return
    setCheckingAll(true)
    try {
      const targets = [...plugins]
      for (const plugin of targets) {
        setChecks((prev) => ({
          ...prev,
          [plugin.name]: { status: 'checking', result: null, error: null }
        }))
      }
      const updated: string[] = []
      const incompatible: string[] = []
      const failed: string[] = []
      await runWithConcurrency(targets, CHECK_CONCURRENCY, async (plugin) => {
        const result = await BRIDGE.plugin.check(instanceId, plugin.name)
        if (result.ok) {
          setChecks((prev) => ({
            ...prev,
            [plugin.name]: { status: 'done', result: result.value, error: null }
          }))
          const outcome = classifyCheckOutcome(result.value)
          if (outcome === 'update') updated.push(`${plugin.name} ${result.value.latest}`)
          else if (outcome === 'incompatible')
            incompatible.push(`${plugin.name} ${result.value.latest}`)
        } else {
          setChecks((prev) => ({
            ...prev,
            [plugin.name]: { status: 'error', result: null, error: result.message }
          }))
          failed.push(`${plugin.name}: ${result.message}`)
        }
      })
      setLastCheckedAt(new Date().toISOString())
      const separator = t('common.listSeparator')
      if (updated.length > 0) {
        logActivity(
          t('detail.plugin.log.checkAllUpdates', {
            count: updated.length,
            list: updated.join(separator)
          })
        )
      }
      if (incompatible.length > 0) {
        logActivity(
          t('detail.plugin.log.checkAllIncompatible', {
            count: incompatible.length,
            list: incompatible.join(separator)
          })
        )
      }
      if (failed.length > 0) {
        logActivity(
          t('detail.plugin.log.checkAllFailed', {
            count: failed.length,
            list: failed.join(separator)
          })
        )
      }
    } finally {
      setCheckingAll(false)
    }
  }

  /**
   * 改动后的提示：按 dsh 的生效语义（主进程算出的 application）与实例运行状态决定——
   * 未运行 → 已保存，下次启动生效；applied → 已即时生效；restart-required → 提示重启。
   * 「是否需要重启」只看该 profile 是否可用 HMR，与插件有没有 host 半、是否替换已装包无关。
   */
  const afterMutation = (name: string, application: 'applied' | 'restart-required'): void => {
    const notice = pluginApplyNotice({ running: instanceRunning, application })
    if (notice === 'restart-required') {
      logActivity(t('detail.plugin.log.restartHint', { name }))
      setRestartPrompt({ name })
      return
    }
    if (notice === 'saved') {
      logActivity(t('detail.plugin.log.savedHint', { name }))
      toast('ok', t('detail.plugin.mutationDone'), t('detail.plugin.savedHint', { name }))
      return
    }
    logActivity(t('detail.plugin.log.appliedHint', { name }))
    toast('ok', t('detail.plugin.mutationDone'), t('detail.plugin.appliedHint', { name }))
  }

  /**
   * 升级执行与收尾：留痕、清掉该插件的检查标记、刷新列表，最后按生效口径提示。
   * 失败把 message 交回二次确认对话框就地显示，对话框据此保持打开。
   * `registry` 是二次确认里选定的安装源，与解析所用同源。
   */
  const performUpgrade = async (
    name: string,
    version: string,
    registry: PluginRegistryOption
  ): Promise<UpgradeOutcome> => {
    if (!BRIDGE) return { ok: false }
    setRowBusy(name, { upgrading: true })
    logActivity(t('detail.plugin.log.upgrading', { name, version }))
    const result = await BRIDGE.plugin.upgrade(instanceId, name, version, { registry })
    setRowBusy(name, { upgrading: false })
    if (!result.ok) {
      logActivity(t('detail.plugin.log.upgradeFailed', { name, msg: result.message }))
      toast('err', t('detail.plugin.upgradeFailed', { msg: result.message }))
      return { ok: false, message: result.message }
    }
    logActivity(t('detail.plugin.log.upgraded', { name, version }))
    // 升级后该插件版本已变，自身旧检查结果失效——清掉它，其它插件的检查状态保留。
    setChecks((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    await load({ keepChecks: true })
    afterMutation(name, result.value.application)
    return { ok: true }
  }

  /** 启用/禁用插件：改 profile 的加载清单，禁用后仍在列表可见（可升级/卸载/再启用）。
   *  启用不兼容插件时，主进程先授予 allow-version --accept-risk 豁免，这里把该操作写入信息栏。 */
  const runToggle = async (name: string, enabled: boolean): Promise<void> => {
    if (!BRIDGE) return
    setRowBusy(name, { toggling: true })
    logActivity(
      enabled
        ? t('detail.plugin.log.enabling', { name })
        : t('detail.plugin.log.disabling', { name })
    )
    const result = await BRIDGE.plugin.setEnabled(instanceId, name, enabled)
    setRowBusy(name, { toggling: false })
    if (!result.ok) {
      const key = enabled ? 'detail.plugin.log.enableFailed' : 'detail.plugin.log.disableFailed'
      const toastKey = enabled ? 'detail.plugin.enableFailed' : 'detail.plugin.disableFailed'
      logActivity(t(key, { name, msg: result.message }))
      toast('err', t(toastKey, { msg: result.message }))
      return
    }
    logActivity(t(enabled ? 'detail.plugin.log.enabled' : 'detail.plugin.log.disabled', { name }))
    // 启用不兼容插件时主进程已授予精确版本豁免（用户接受风险）：信息栏留痕，并再次明示风险。
    if (enabled && result.value.exemptionGranted !== null) {
      const { pluginVersion, dshVersion } = result.value.exemptionGranted
      logActivity(
        t('detail.plugin.log.exemptionGranted', { name, version: pluginVersion, dshVersion })
      )
      toast(
        'warn',
        t('detail.plugin.exemptionGrantedTitle'),
        t('detail.plugin.exemptionGrantedBody', { name, version: pluginVersion, dshVersion })
      )
    }
    await load({ keepChecks: true })
    afterMutation(name, result.value.application)
  }

  const confirmRemove = async (): Promise<void> => {
    if (!BRIDGE || !removeTarget) return
    const { name } = removeTarget
    setRemoveTarget(null)
    setRowBusy(name, { removing: true })
    logActivity(t('detail.plugin.log.removing', { name }))
    const result = await BRIDGE.plugin.remove(instanceId, name)
    setRowBusy(name, { removing: false })
    if (!result.ok) {
      logActivity(t('detail.plugin.log.removeFailed', { name, msg: result.message }))
      toast('err', t('detail.plugin.removeFailed', { msg: result.message }))
      return
    }
    logActivity(t('detail.plugin.log.removed', { name }))
    await load({ keepChecks: true })
    afterMutation(name, result.value.application)
  }

  /** 安装开始：信息栏留痕（安装由对话框执行，失败错误就地显示在对话框内）。 */
  const logInstallStart = (plan: PluginInstallPlan): void => {
    logActivity(t('detail.plugin.log.installing', { spec: plan.installSpec }))
  }

  /** 安装成功：留痕 + 刷新列表 + 生效提示（对话框随后自行关闭）。 */
  const finishInstall = async (
    plan: PluginInstallPlan,
    confirmation: InstallConfirmation
  ): Promise<void> => {
    logActivity(t('detail.plugin.log.installed', { spec: plan.installSpec }))
    await load({ keepChecks: true })
    afterMutation(plan.packageName ?? plan.installSpec, confirmation.application)
  }

  /** 安装失败：信息栏留痕（错误同时就地显示在对话框内）。 */
  const logInstallFailed = (plan: PluginInstallPlan, message: string): void => {
    logActivity(t('detail.plugin.log.installFailed', { spec: plan.installSpec, msg: message }))
  }

  const confirmRestart = (): void => {
    if (!restartPrompt || !BRIDGE) return
    setRestartPrompt(null)
    // 重启期间工作区开着则置 pendingOpen，由 running 状态事件自动重开（与详情页重启同路径）。
    if (workspaceConnected) setPendingOpen(instanceId)
    void BRIDGE.runtime.restart(instanceId).then((result) => {
      if (!result.ok) toast('err', t('detail.restartFailed'), result.message)
    })
  }

  const openLink = (url: string | null): void => {
    if (!url || !BRIDGE) return
    void BRIDGE.plugin.openExternal(url).then((result) => {
      if (!result.ok) toast('err', t('detail.plugin.openLinkFailed'), result.message)
    })
  }

  return (
    <div className="card plugins-card selectable" data-testid="plugins-card">
      <div className="card-head">
        <h3>{t('detail.plugin.title')}</h3>
        <div className="row" style={{ gap: 8 }}>
          {/* 上次检查更新时刻：本会话内任一检查（单条或批量）完成即刷新，紧邻刷新按钮左侧。 */}
          {lastCheckedAt !== null && (
            <span className="meta plugin-last-checked" data-testid="plugins-last-checked">
              {t('detail.plugin.lastChecked', { time: fmtLogTime(lastCheckedAt) })}
            </span>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => void load()}
            disabled={loading}
            data-testid="plugins-refresh-btn"
          >
            <Icon name="refresh" /> {t('detail.plugin.refresh')}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void runCheckAll()}
            disabled={checkingAll || plugins === null || plugins.length === 0}
            data-testid="plugins-check-all-btn"
          >
            <Icon name="sync" />
            {checkingAll ? t('detail.plugin.checkingAll') : t('detail.plugin.checkAll')}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setShowInstall(true)}
            data-testid="plugins-install-btn"
          >
            <Icon name="plus" /> {t('detail.plugin.install')}
          </button>
        </div>
      </div>

      {autoDisabled !== null && (
        <div className="plugin-auto-disabled" data-testid="plugins-auto-disabled">
          <Icon name="alert" />
          <div className="plugin-auto-disabled-body">
            <strong>{t('detail.plugin.autoDisabledTitle')}</strong>
            <span className="meta">
              {t('detail.plugin.autoDisabledBody', {
                dshVersion: autoDisabled[0]?.dshVersion ?? '',
                list: autoDisabled.map((item) => item.name).join(t('common.listSeparator'))
              })}
            </span>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={dismissAutoDisabled}
            data-testid="plugins-auto-disabled-dismiss"
          >
            {t('detail.plugin.autoDisabledDismiss')}
          </button>
        </div>
      )}

      {loadError !== null && (
        <p className="meta err-text" data-testid="plugins-load-error">
          {t('detail.plugin.loadFailed', { msg: loadError })}
        </p>
      )}

      {loadError === null && loading && plugins === null && (
        <p className="meta">{t('detail.plugin.loading')}</p>
      )}

      {loadError === null && plugins !== null && plugins.length === 0 && (
        <p className="meta" data-testid="plugins-empty">
          {t('detail.plugin.empty')}
        </p>
      )}

      {plugins !== null && plugins.length > 0 && (
        <ul className="plugin-list" data-testid="plugin-list">
          {plugins.map((plugin) => (
            <PluginRow
              key={plugin.name}
              t={t}
              plugin={plugin}
              expanded={expanded === plugin.name}
              onToggle={() => setExpanded((prev) => (prev === plugin.name ? null : plugin.name))}
              check={checkOf(plugin.name)}
              busy={rowBusy(plugin.name)}
              locked={checkingAll}
              onCheck={() => void runCheck(plugin.name)}
              onUpgrade={(version) => setUpgradeTarget({ name: plugin.name, version })}
              onToggleEnabled={(enabled) => void runToggle(plugin.name, enabled)}
              onRemove={() => setRemoveTarget({ name: plugin.name })}
              onOpenLink={openLink}
            />
          ))}
        </ul>
      )}

      {showInstall && (
        <InstallPluginDialog
          t={t}
          instanceId={instanceId}
          onClose={() => setShowInstall(false)}
          onInstallStart={logInstallStart}
          onInstalled={finishInstall}
          onInstallFailed={logInstallFailed}
        />
      )}

      {upgradeTarget !== null && (
        <UpgradeConfirmDialog
          t={t}
          instanceId={instanceId}
          name={upgradeTarget.name}
          version={upgradeTarget.version}
          onClose={() => setUpgradeTarget(null)}
          onConfirm={(registry) =>
            performUpgrade(upgradeTarget.name, upgradeTarget.version, registry)
          }
        />
      )}

      {removeTarget !== null && (
        <RemovePluginModal
          t={t}
          target={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onConfirm={() => void confirmRemove()}
        />
      )}

      {restartPrompt !== null && (
        <RestartPromptModal
          t={t}
          name={restartPrompt.name}
          onClose={() => setRestartPrompt(null)}
          onConfirm={confirmRestart}
        />
      )}
    </div>
  )
}
