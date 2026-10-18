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
import { Modal } from '../Modal'
import { HoverTip } from '../InfoTip'
import { useAppStore } from '../../store'
import {
  canOfferUpgrade,
  classifyCheckOutcome,
  initialCheckState,
  pluginApplyNotice,
  pluginSourceKey,
  pruneChecks,
  restoreChecks,
  showsIncompatibleWarning,
  showsUnknownCompatibility,
  showsUpToDate,
  type PluginCheckState
} from '../../lib/plugins-card-state'
import InstallPluginDialog from './InstallPluginDialog'
import type { InstallConfirmation } from './InstallPluginDialog'
import UpgradeConfirmDialog from './UpgradeConfirmDialog'
import type { UpgradeOutcome } from './UpgradeConfirmDialog'
import Switch from '../Switch'

const BRIDGE = window.dshHub

/**
 * 一键检查的并发度：每个检查是一个独立的 `dsh plugin view` 子进程（联网），
 * 串行太慢、无上限并发会同时拉起过多子进程与请求，取一个折中的小并发。
 */
const CHECK_CONCURRENCY = 4

/** 一行插件的可变操作态：检查/升级/卸载进行中标记。 */
interface RowBusy {
  upgrading: boolean
  removing: boolean
  toggling: boolean
}

/** 卸载二次确认目标。 */
interface RemoveTarget {
  name: string
}

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
  const workspaceConnected = useAppStore(
    (state) => state.workspaceConnected[instanceId] ?? false
  )
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
          const acked = disabled.length > 0 && isAutoDisabledAcked(localStorage, instanceId, dshVersion)
          setAutoDisabled(disabled.length > 0 && !acked ? disabled : null)
          // 同一次自动禁用只提示一次：发送权记在 store 里（同步判定），
          // 因此并发的两次加载（dev StrictMode 会双调用挂载 effect）与组件重挂载都不会重复弹。
          if (disabled.length > 0 && !acked && notifyAutoDisabledOnce(instanceId, dshVersion)) {
            const list = disabled.map((item) => item.name).join(t('common.listSeparator'))
            logActivity(t('detail.plugin.log.autoDisabled', { dshVersion, list }))
            toast('err', t('detail.plugin.autoDisabledTitle'), t('detail.plugin.autoDisabledBody', {
              dshVersion,
              list
            }))
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
      setChecks((prev) => ({ ...prev, [name]: { status: 'done', result: result.value, error: null } }))
      logCheckOutcome(result.value)
    } else {
      setChecks((prev) => ({ ...prev, [name]: { status: 'error', result: null, error: result.message } }))
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
        setChecks((prev) => ({ ...prev, [plugin.name]: { status: 'checking', result: null, error: null } }))
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
          else if (outcome === 'incompatible') incompatible.push(`${plugin.name} ${result.value.latest}`)
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
          t('detail.plugin.log.checkAllUpdates', { count: updated.length, list: updated.join(separator) })
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
          t('detail.plugin.log.checkAllFailed', { count: failed.length, list: failed.join(separator) })
        )
      }
    } finally {
      setCheckingAll(false)
    }
  }

  /**
   * 改动后的提示：按 dsh 的生效语义（主进程算出的 application）与实例运行状态决定——
   * 未运行 → 已保存，下次启动生效；applied → 已即时生效；restart-required → 提示重启。
   * 「是否需要重启」与插件有没有 host 半无关：升级/替换已装包时即使有 HMR 也必须重启。
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
      enabled ? t('detail.plugin.log.enabling', { name }) : t('detail.plugin.log.disabling', { name })
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
      logActivity(t('detail.plugin.log.exemptionGranted', { name, version: pluginVersion, dshVersion }))
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

/** 单个插件行：图标 + 名称/版本/来源 + 操作列 + 手风琴详情。 */
function PluginRow(props: {
  t: Translator
  plugin: PluginInfo
  expanded: boolean
  onToggle: () => void
  check: PluginCheckState
  busy: RowBusy
  /** 批量（系统）检查进行中：锁定单行检查按钮，同一时刻只让系统检查在跑。 */
  locked: boolean
  onCheck: () => void
  onUpgrade: (version: string) => void
  onToggleEnabled: (enabled: boolean) => void
  onRemove: () => void
  onOpenLink: (url: string | null) => void
}): ReactNode {
  const {
    t,
    plugin,
    expanded,
    onToggle,
    check,
    busy,
    locked,
    onCheck,
    onUpgrade,
    onToggleEnabled,
    onRemove,
    onOpenLink
  } = props
  const disabled = plugin.enabled === false
  // 不兼容/无法判定共用同一组参数：标题与正文复用一次计算，避免两处 t() 调用漂移。
  const incompatibleText =
    check.result === null
      ? ''
      : t(
          showsUnknownCompatibility(check) ? 'detail.plugin.incompatibleUnknown' : 'detail.plugin.incompatible',
          {
            latest: check.result.latest,
            peer: check.result.dshPeer ?? '—',
            current: check.result.dshVersion ?? '—'
          }
        )
  return (
    <li
      className={disabled ? 'plugin-row plugin-row--disabled' : 'plugin-row'}
      data-testid={`plugin-row-${plugin.name}`}
    >
      <div className="plugin-row-head">
        <button
          className="plugin-expand"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={plugin.name}
          data-testid={`plugin-expand-${plugin.name}`}
        >
          {plugin.iconDataUri ? (
            <img className="plugin-icon" src={plugin.iconDataUri} alt="" width={20} height={20} />
          ) : (
            <span className="plugin-icon plugin-icon-fallback" aria-hidden="true">
              <Icon name="hub" size={16} />
            </span>
          )}
          {/* 有本地化名称则名称为主、包名作二级标题跟随；无名称则包名作主标题。 */}
          <span className="plugin-title-group">
            <span className="plugin-name">{plugin.title ?? plugin.name}</span>
            {plugin.title && <span className="plugin-pkgname num">{plugin.name}</span>}
          </span>
          <span className="badge num">{plugin.version}</span>
          <span className="plugin-source">{t(pluginSourceKey(plugin.installSource))}</span>
          {disabled && (
            <span className="badge plugin-disabled-badge" data-testid={`plugin-disabled-${plugin.name}`}>
              {t('detail.plugin.disabled')}
            </span>
          )}
        </button>
        <div className="row plugin-actions" style={{ gap: 8 }}>
          {/* 检查结果内联在操作行最左，不换行占整行：已最新 / 不兼容警告 / 检查失败。 */}
          {showsUpToDate(check) && (
            <span className="meta plugin-status-inline" data-testid={`plugin-uptodate-${plugin.name}`}>
              {t('detail.plugin.uptodate')}
            </span>
          )}
          {showsIncompatibleWarning(check) && check.result !== null && (
            // 行内宽度有限必然截断：完整说明由 hover/聚焦气泡给出（原 title 由气泡取代）。
            <HoverTip text={incompatibleText}>
              <span
                className="meta err-text plugin-status-inline"
                data-testid={`plugin-incompatible-${plugin.name}`}
              >
                {incompatibleText}
              </span>
            </HoverTip>
          )}
          {check.status === 'error' && check.error !== null && (
            <HoverTip text={t('detail.plugin.checkFailed', { msg: check.error })}>
              <span
                className="meta err-text plugin-status-inline"
                data-testid={`plugin-check-error-${plugin.name}`}
              >
                {t('detail.plugin.checkFailed', { msg: check.error })}
              </span>
            </HoverTip>
          )}
          {plugin.githubUrl && (
            <button
              className="btn btn-ghost btn-sm btn-icon plugin-link"
              onClick={() => onOpenLink(plugin.githubUrl)}
              aria-label={t('detail.plugin.field.github')}
              title={t('detail.plugin.field.github')}
              data-testid={`plugin-github-${plugin.name}`}
            >
              <Icon name="github" />
            </button>
          )}
          {/* 启用/禁用开关：开=已加载。纯 client 插件不由清单控制，开关置灰并说明原因。 */}
          <Switch
            checked={!disabled}
            onChange={(next) => onToggleEnabled(next)}
            disabled={plugin.enabled === null || busy.toggling}
            title={plugin.enabled === null ? t('detail.plugin.cannotDisable') : t('detail.plugin.enableToggle')}
            ariaLabel={t('detail.plugin.enableToggle')}
            testId={`plugin-toggle-${plugin.name}`}
          />
          <button
            className="btn btn-secondary btn-sm plugin-check-btn"
            onClick={onCheck}
            disabled={check.status === 'checking' || locked}
            title={locked ? t('detail.plugin.checkLocked') : undefined}
            data-testid={`plugin-check-${plugin.name}`}
          >
            <Icon name="sync" />
            {/* 两个候选文案叠放在同一 grid 单元，宽度取最大值：切「检查中…/检查升级」按钮不跳动，
                中英文各自按各自的最长文案自适应。 */}
            <span className="btn-swap">
              <span className="btn-swap-cell" data-active={check.status !== 'checking'}>
                {t('detail.plugin.checkUpdate')}
              </span>
              <span className="btn-swap-cell" data-active={check.status === 'checking'}>
                {t('detail.plugin.checking')}
              </span>
            </span>
          </button>
          {canOfferUpgrade(check) && check.result !== null && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onUpgrade(check.result!.latest)}
              disabled={busy.upgrading}
              data-testid={`plugin-upgrade-${plugin.name}`}
            >
              <Icon name="refresh" />
              {busy.upgrading
                ? t('detail.plugin.upgrading')
                : t('detail.plugin.upgradeTo', { version: check.result.latest })}
            </button>
          )}
          <button
            className="btn btn-danger btn-sm btn-icon plugin-remove-btn"
            onClick={onRemove}
            disabled={busy.removing}
            aria-label={t('detail.plugin.remove')}
            title={busy.removing ? t('detail.plugin.removing') : t('detail.plugin.remove')}
            data-testid={`plugin-remove-${plugin.name}`}
          >
            <Icon name="trash" />
          </button>
        </div>
      </div>

      {expanded && (
        <PluginDetail t={t} plugin={plugin} check={check} onOpenLink={onOpenLink} />
      )}
    </li>
  )
}

/** 手风琴展开的插件详情。 */
function PluginDetail(props: {
  t: Translator
  plugin: PluginInfo
  check: PluginCheckState
  onOpenLink: (url: string | null) => void
}): ReactNode {
  const { t, plugin, check, onOpenLink } = props
  // 发布时间取已装版本的快照：刚检查完用本次结果，否则用主进程持久化并回填到列表的那条。
  const publishedAt = check.result?.publishedAt ?? plugin.publishedAt
  return (
    <dl className="kv plugin-detail" data-testid={`plugin-detail-${plugin.name}`}>
      {plugin.description && (
        <>
          <dt>{t('detail.plugin.field.description')}</dt>
          <dd>{plugin.description}</dd>
        </>
      )}
      {plugin.author && (
        <>
          <dt>{t('detail.plugin.field.author')}</dt>
          <dd>{plugin.author}</dd>
        </>
      )}
      {plugin.license && (
        <>
          <dt>{t('detail.plugin.field.license')}</dt>
          <dd>{plugin.license}</dd>
        </>
      )}
      {plugin.githubUrl && (
        <>
          <dt>{t('detail.plugin.field.github')}</dt>
          <dd>
            <button className="link-btn" onClick={() => onOpenLink(plugin.githubUrl)}>
              {plugin.githubUrl}
            </button>
          </dd>
        </>
      )}
      {plugin.npmUrl && (
        <>
          <dt>{t('detail.plugin.field.npm')}</dt>
          <dd>
            <button className="link-btn" onClick={() => onOpenLink(plugin.npmUrl)}>
              {plugin.npmUrl}
            </button>
          </dd>
        </>
      )}
      <dt>{t('detail.plugin.field.published')}</dt>
      <dd className="num">{publishedAt !== null ? fmtLogTime(publishedAt) : t('detail.plugin.publishedUnknown')}</dd>
      <dt>{t('detail.plugin.field.compat')}</dt>
      <dd className="num">
        dsh {plugin.dshPeer ?? '—'}
        {plugin.nodeEngine ? ` · node ${plugin.nodeEngine}` : ''}
      </dd>
      <dt>{t('detail.plugin.field.deps')}</dt>
      <dd>{plugin.dependencies.length > 0 ? plugin.dependencies.join(', ') : t('detail.plugin.depsNone')}</dd>
    </dl>
  )
}

/** 卸载二次确认弹窗；含 host 半时附带重启提示。 */
function RemovePluginModal(props: {
  t: Translator
  target: RemoveTarget
  onClose: () => void
  onConfirm: () => void
}): ReactNode {
  const { t, target, onClose, onConfirm } = props
  return (
    <Modal
      title={t('detail.plugin.removeConfirmTitle')}
      onClose={onClose}
      closeLabel={t('common.close')}
      testId="plugin-remove-confirm"
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-danger btn-sm" onClick={onConfirm} data-testid="plugin-remove-confirm-btn">
            {t('detail.plugin.remove')}
          </button>
        </>
      }
    >
      <p className="meta">{t('detail.plugin.removeConfirmBody', { name: target.name })}</p>
    </Modal>
  )
}

/** host 半改动后的重启提醒弹窗。 */
function RestartPromptModal(props: {
  t: Translator
  name: string
  onClose: () => void
  onConfirm: () => void
}): ReactNode {
  const { t, name, onClose, onConfirm } = props
  return (
    <Modal
      title={t('detail.plugin.restartTitle')}
      onClose={onClose}
      closeLabel={t('common.close')}
      testId="plugin-restart-prompt"
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            {t('detail.plugin.restartLater')}
          </button>
          <button className="btn btn-primary btn-sm" onClick={onConfirm} data-testid="plugin-restart-now-btn">
            {t('detail.plugin.restartNow')}
          </button>
        </>
      }
    >
      <p className="meta">{t('detail.plugin.restartBody', { name })}</p>
    </Modal>
  )
}
