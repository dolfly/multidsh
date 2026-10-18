import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PluginInstallPlan, PluginRegistryOption } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { DEFAULT_PLUGIN_REGISTRY } from '@shared/settings'
import { Icon } from '../../lib/icons'
import { Modal } from '../Modal'
import { useAppStore } from '../../store'
import InstallConfirmPanel from './InstallConfirmPanel'
import { REGISTRY_CHOICES, registryLabel } from './registry-choices'

const BRIDGE = window.dshHub

/** 升级执行结果：!ok 时把主进程的 message 就地显示，对话框保持打开供重试或取消。 */
export interface UpgradeOutcome {
  ok: boolean
  message?: string
}

/**
 * 升级二次确认：点「升级到 x.y.z」后先弹出，解析目标版本并展示与安装第二步同款的确认区。
 *
 * 安装源可在确认前改选：目标版本固定来自检查结果，换源只改变从哪里取该版本，改选即按新源重新解析；
 * 解析与升级必须同源，选定的档位回传给执行方。
 * 只确认目标版本与风险，不改启用态（没有「安装后启用」勾选）；
 * 真正的执行与收尾由调用方负责，失败时对话框保持打开并就地报错。
 */
export default function UpgradeConfirmDialog(props: {
  t: Translator
  instanceId: string
  /** 插件名（不含版本）。 */
  name: string
  /** 目标版本（来自检查结果；升级固定走显式版本分型）。 */
  version: string
  onClose: () => void
  /** 执行升级（留痕、清检查标记、刷新列表与生效提示由调用方完成）；入参是本次选定的安装源。 */
  onConfirm: (registry: PluginRegistryOption) => Promise<UpgradeOutcome>
}): ReactNode {
  const { t, instanceId, name, version, onClose, onConfirm } = props
  const closeLabel = useAppStore((state) => state.t('common.close'))

  const [registry, setRegistry] = useState<PluginRegistryOption>(DEFAULT_PLUGIN_REGISTRY)
  const [plan, setPlan] = useState<PluginInstallPlan | null>(null)
  const [resolving, setResolving] = useState(true)
  const [upgrading, setUpgrading] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [upgradeError, setUpgradeError] = useState<string | null>(null)
  const [riskAccepted, setRiskAccepted] = useState(false)

  useEffect(() => {
    const bridge = BRIDGE
    if (!bridge) return
    let cancelled = false
    setResolving(true)
    setResolveError(null)
    void bridge.plugin.resolveInstall(instanceId, `${name}@${version}`, { registry }).then((result) => {
      if (cancelled) return
      setResolving(false)
      if (!result.ok) {
        setResolveError(result.message)
        return
      }
      setPlan(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [instanceId, name, version, registry])

  /** 改选安装源：当前计划对应旧源，先作废再按新源重新解析（风险勾选与旧的失败信息一并失效）。 */
  const changeRegistry = (next: PluginRegistryOption): void => {
    if (next === registry) return
    setPlan(null)
    setRiskAccepted(false)
    setResolveError(null)
    // 上一次升级的失败原因属于旧源/旧计划：换源后重新解析，不再显示，避免与新结果并存。
    setUpgradeError(null)
    setRegistry(next)
  }

  const upgrade = async (): Promise<void> => {
    if (plan === null || upgrading) return
    // 不兼容：未勾选风险确认时不允许提交（按钮同时禁用，这里再兜一层）。
    if (plan.compatible === false && !riskAccepted) return
    setUpgrading(true)
    setUpgradeError(null)
    const result = await onConfirm(registry)
    setUpgrading(false)
    if (!result.ok) {
      setUpgradeError(result.message ?? '')
      return
    }
    onClose()
  }

  const close = (): void => {
    // 升级执行中不可关闭：结果与收尾都要落到界面上。
    if (!upgrading) onClose()
  }

  const submitDisabled =
    resolving || upgrading || plan === null || (plan.compatible === false && !riskAccepted)

  return (
    <Modal
      title={t('detail.plugin.upgradeTitle')}
      onClose={close}
      closeLabel={closeLabel}
      className="modal-plugin"
      testId="upgrade-confirm-dialog"
      footer={
        <>
          <span className="meta">{t('detail.plugin.upgradeInterruptNote')}</span>
          <span className="right">
            <button
              className="btn btn-secondary btn-sm"
              onClick={close}
              disabled={upgrading}
              data-testid="upgrade-confirm-cancel"
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void upgrade()}
              disabled={submitDisabled}
              data-testid="upgrade-confirm-submit"
            >
              <span className="btn-swap">
                <span className="btn-swap-cell" data-active={!upgrading}>
                  {t('detail.plugin.upgradeTo', { version: plan?.targetVersion ?? version })}
                </span>
                <span className="btn-swap-cell" data-active={upgrading}>
                  {t('detail.plugin.upgrading')}
                </span>
              </span>
            </button>
          </span>
        </>
      }
    >
      {/* 安装源在确认区之前选定：解析与升级必须同源，改选即按新源重新解析。 */}
      <div className="field">
        <label htmlFor="upgrade-plugin-registry">{t('detail.plugin.installSource')}</label>
        <select
          className="input"
          id="upgrade-plugin-registry"
          value={registry}
          disabled={upgrading}
          onChange={(event) => changeRegistry(event.target.value as PluginRegistryOption)}
          data-testid="upgrade-confirm-source"
        >
          {REGISTRY_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {t(choice.labelKey)}
            </option>
          ))}
        </select>
      </div>

      <div className="note n-warn mt12" data-testid="upgrade-confirm-safety">
        <Icon name="alert" />
        <span>{t('detail.plugin.installSafety')}</span>
      </div>

      {resolving && <p className="meta mt12">{t('detail.plugin.installResolving')}</p>}
      {resolveError !== null && (
        <p className="meta err-text mt12" data-testid="upgrade-confirm-resolve-error">
          {t('detail.plugin.resolveFailed', { msg: resolveError })}
        </p>
      )}

      {plan !== null && (
        <>
          <InstallConfirmPanel
            t={t}
            instanceId={instanceId}
            plan={plan}
            mode="upgrade"
            registryLabel={registryLabel(t, registry)}
            riskAccepted={riskAccepted}
            onRiskChange={setRiskAccepted}
          />
          <p className="meta mt8">{t('detail.plugin.upgradeKeepState')}</p>
          {upgradeError !== null && (
            <p className="meta err-text mt8" data-testid="upgrade-confirm-error">
              {t('detail.plugin.upgradeFailedInline', { msg: upgradeError })}
            </p>
          )}
        </>
      )}
    </Modal>
  )
}
