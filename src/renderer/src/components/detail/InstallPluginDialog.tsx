import { useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { PluginInstallPlan, PluginRegistryOption } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import { pluginRegistryFromUrl } from '@shared/settings'
import { Icon } from '../../lib/icons'
import { Modal } from '../Modal'
import { InfoTip } from '../InfoTip'
import { useAppStore } from '../../store'
import InstallConfirmPanel from './InstallConfirmPanel'
import { REGISTRY_CHOICES, registryLabel } from './registry-choices'

const BRIDGE = window.dshHub

/** 安装成功交给卡片的确认结果：勾选值、安装源与主进程给出的生效口径。 */
export interface InstallConfirmation {
  /** 安装后是否启用（确认区勾选值；false = 装完落在禁用态）。 */
  enable: boolean
  /** 本次解析与安装所用的安装源档位（解析时选定的档位，第二步不再展示下拉）。 */
  registry: PluginRegistryOption
  /** applied = 已即时生效；restart-required = 需重启实例。 */
  application: 'applied' | 'restart-required'
}

/**
 * 安装插件对话框：第一步输入插件标识与安装源并「确定」，主进程解析出版本后进入第二步确认。
 *
 * 输入内容一旦变化立即作废已确认的计划（确认区与在途的更新内容取数一并失效），回到第一步。
 * 解析与安装都由本对话框发起，卡片只负责成功后的刷新与生效提示；解析/安装失败就地显示。
 */
export default function InstallPluginDialog(props: {
  t: Translator
  instanceId: string
  onClose: () => void
  /** 点击「安装」：信息栏留痕（对话框不写日志）。 */
  onInstallStart: (plan: PluginInstallPlan) => void
  /** 安装成功：刷新列表与生效提示；完成后对话框自行关闭。 */
  onInstalled: (plan: PluginInstallPlan, confirmation: InstallConfirmation) => Promise<void>
  /** 安装失败：信息栏留痕；错误文案同时就地显示在对话框内。 */
  onInstallFailed: (plan: PluginInstallPlan, message: string) => void
}): ReactNode {
  const { t, instanceId, onClose, onInstallStart, onInstalled, onInstallFailed } = props
  const closeLabel = useAppStore((state) => state.t('common.close'))
  const npmRegistry = useAppStore((state) => state.settings.npmRegistry)

  const [spec, setSpec] = useState('')
  // 默认安装源跟随应用设置的镜像档位（打开对话框时读取；设置改动后重开生效）。
  const [registry, setRegistry] = useState<PluginRegistryOption>(() =>
    pluginRegistryFromUrl(npmRegistry)
  )
  /** 已解析出的计划：非 null 即处于第二步；输入变更立即作废回第一步。 */
  const [plan, setPlan] = useState<PluginInstallPlan | null>(null)
  /** 解析与安装共用一把锁：进行中按钮禁用且不可关闭。 */
  const [busy, setBusy] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  /** 安装后启用：默认勾选（取消则只安装，装完落在禁用态）。 */
  const [enableAfter, setEnableAfter] = useState(true)
  const [riskAccepted, setRiskAccepted] = useState(false)
  /** 曾因输入变更作废过确认区：footer 提示改为「需重新确定」。 */
  const [reconfirmNeeded, setReconfirmNeeded] = useState(false)
  /** 最新输入：解析期间又编辑时，用它丢弃对应旧输入的解析结果。 */
  const specRef = useRef('')

  const changeSpec = (value: string): void => {
    specRef.current = value
    setSpec(value)
    setResolveError(null)
    setInstallError(null)
    if (plan !== null) {
      // 输入即作废已确认的计划：确认区、风险勾选与在途取数都不再适用。
      setPlan(null)
      setRiskAccepted(false)
      setReconfirmNeeded(true)
    }
  }

  const resolve = async (): Promise<void> => {
    const bridge = BRIDGE
    const value = spec.trim()
    if (!bridge || value === '' || busy) return
    const usedRegistry = registry
    setBusy(true)
    setResolveError(null)
    setInstallError(null)
    const result = await bridge.plugin.resolveInstall(instanceId, value, { registry: usedRegistry })
    setBusy(false)
    // 解析期间输入又变了：结果对应旧输入，丢弃（重新点「确定」即可）。
    if (specRef.current.trim() !== value) return
    if (!result.ok) {
      setResolveError(result.message)
      return
    }
    setPlan(result.value)
    setRiskAccepted(false)
    setReconfirmNeeded(false)
  }

  const install = async (): Promise<void> => {
    const bridge = BRIDGE
    const confirmed = plan
    if (!bridge || confirmed === null || busy) return
    // 不兼容：未勾选风险确认时不允许提交（按钮同时禁用，这里再兜一层）。
    if (confirmed.compatible === false && !riskAccepted) return
    setBusy(true)
    setInstallError(null)
    onInstallStart(confirmed)
    const result = await bridge.plugin.install(instanceId, confirmed.installSpec, {
      enable: enableAfter,
      registry
    })
    if (!result.ok) {
      setBusy(false)
      setInstallError(result.message)
      onInstallFailed(confirmed, result.message)
      return
    }
    await onInstalled(confirmed, {
      enable: enableAfter,
      registry,
      application: result.value.application
    })
    setBusy(false)
    onClose()
  }

  const close = (): void => {
    if (!busy) onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    if (plan === null) void resolve()
    else void install()
  }

  const reinstall =
    plan !== null && plan.targetVersion !== null && plan.installedVersion === plan.targetVersion
  const actionLabel =
    plan === null
      ? ''
      : reinstall
        ? t('detail.plugin.reinstallAction', { version: plan.targetVersion ?? plan.installSpec })
        : t('detail.plugin.installAction', { version: plan.targetVersion ?? plan.installSpec })
  const submitDisabled =
    busy || (plan === null ? spec.trim() === '' : plan.compatible === false && !riskAccepted)

  return (
    <Modal
      title={t('detail.plugin.installTitle')}
      onClose={close}
      closeLabel={closeLabel}
      className="modal-plugin"
      testId="install-plugin-dialog"
      footer={
        <>
          <span className="meta">
            {plan !== null || reconfirmNeeded
              ? t('detail.plugin.confirmInputChanged')
              : t('detail.plugin.installResolveHint')}
          </span>
          <span className="right">
            <button
              className="btn btn-secondary btn-sm"
              onClick={close}
              disabled={busy}
              data-testid="install-plugin-cancel"
            >
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void (plan === null ? resolve() : install())}
              disabled={submitDisabled}
              data-testid="install-plugin-submit"
            >
              {/* 两个候选文案叠放，按钮宽度取最长者：第一步与第二步切换、忙碌态切换都不跳动。 */}
              <span className="btn-swap">
                <span className="btn-swap-cell" data-active={!busy}>
                  {plan === null ? t('detail.plugin.installResolve') : actionLabel}
                </span>
                <span className="btn-swap-cell" data-active={busy}>
                  {plan === null
                    ? t('detail.plugin.installResolving')
                    : t('detail.plugin.installing')}
                </span>
              </span>
            </button>
          </span>
        </>
      }
    >
      <label className="field">
        <span>{t('detail.plugin.installLabel')}</span>
        <input
          className="input"
          value={spec}
          autoFocus
          placeholder={t('detail.plugin.installPlaceholder')}
          onChange={(event) => changeSpec(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid="install-plugin-input"
        />
      </label>
      {plan === null && <p className="meta mt8">{t('detail.plugin.installHint')}</p>}
      {resolveError !== null && (
        <p className="meta err-text mt8" data-testid="install-plugin-resolve-error">
          {t('detail.plugin.resolveFailed', { msg: resolveError })}
        </p>
      )}

      {/* 安装源只在第一步选择：解析与安装必须同源，选定后不再在第二步改。 */}
      {plan === null && (
        <div className="field mt12">
          <label htmlFor="install-plugin-registry">{t('detail.plugin.installSource')}</label>
          <select
            className="input"
            id="install-plugin-registry"
            value={registry}
            disabled={busy}
            onChange={(event) => setRegistry(event.target.value as PluginRegistryOption)}
            data-testid="install-plugin-source"
          >
            {REGISTRY_CHOICES.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {t(choice.labelKey)}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="note n-warn mt12" data-testid="install-plugin-safety">
        <Icon name="alert" />
        <span>{t('detail.plugin.installSafety')}</span>
      </div>

      {plan !== null && (
        <>
          <InstallConfirmPanel
            t={t}
            instanceId={instanceId}
            plan={plan}
            mode="install"
            registryLabel={registryLabel(t, registry)}
            riskAccepted={riskAccepted}
            onRiskChange={setRiskAccepted}
          />
          <div className="row mt12" style={{ gap: 6, alignItems: 'center' }}>
            <label className="check">
              <input
                type="checkbox"
                checked={enableAfter}
                onChange={(event) => setEnableAfter(event.target.checked)}
                data-testid="install-confirm-enable-after"
              />
              <span>{t('detail.plugin.confirmEnableAfter')}</span>
            </label>
            {/* 取消勾选的后果收进气泡（贴在正文底部，向上并向右展开），不占确认区版面。 */}
            <InfoTip
              text={t('detail.plugin.confirmEnableAfterHint')}
              label={t('common.hint')}
              placement="above-start"
            />
          </div>
          {installError !== null && (
            <p className="meta err-text mt8" data-testid="install-plugin-error">
              {t('detail.plugin.installFailed', { msg: installError })}
            </p>
          )}
        </>
      )}
    </Modal>
  )
}
