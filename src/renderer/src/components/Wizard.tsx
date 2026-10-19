import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { DshVersionCatalog } from '@shared/contracts'
import { buildVersionOptions } from '../lib/version-options'
import { useAppStore } from '../store'
import { Modal } from './Modal'
import type { MessageKey } from '@shared/i18n/messages'
import StepTransport from './wizard/StepTransport'
import LocalConfig from './wizard/LocalConfig'
import SshConfig from './wizard/SshConfig'
import HttpConfig from './wizard/HttpConfig'
import StepConfirm from './wizard/StepConfirm'
import { useCreateInstance } from './wizard/useCreateInstance'
import {
  EMPTY_FORM,
  type ExternalWorkspace,
  type WizardForm,
  type WizardTransport
} from './wizard/types'

const STEP_KEYS: MessageKey[] = ['wizard.stepTransport', 'wizard.stepConfig', 'wizard.stepConfirm']

/** 创建向导：选择类型、填写表单并确认创建；本地实例创建后自动启动并打开窗口。 */
export default function Wizard(): ReactNode {
  const t = useAppStore((state) => state.t)
  const setWizardOpen = useAppStore((state) => state.setWizardOpen)
  const instances = useAppStore((state) => state.instances)
  const toast = useAppStore((state) => state.toast)
  const existingSpaceId = useAppStore((state) => state.wizardExistingSpaceId)

  const [step, setStep] = useState(1)
  const [transport, setTransport] = useState<WizardTransport>('local')
  const [form, setForm] = useState<WizardForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [localLaunchers, setLocalLaunchers] = useState<
    Array<{ launcher: WizardForm['launcher']; version: string }>
  >([])
  const [externalWorkspace, setExternalWorkspace] = useState<ExternalWorkspace | null>(null)
  const [useExistingExternal, setUseExistingExternal] = useState(false)
  const [localProbeDone, setLocalProbeDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  /** 版本下拉数据源；null = 尚未取到。 */
  const [versionCatalog, setVersionCatalog] = useState<DshVersionCatalog | null>(null)
  /** 版本列表获取失败原因；非 null 时在下拉下方提示。 */
  const [versionCatalogError, setVersionCatalogError] = useState<string | null>(null)
  /** 用户是否手动选过版本；选过则本地版本不再覆盖默认值。 */
  const [versionTouched, setVersionTouched] = useState(false)
  /** 自增触发版本目录重取（切换安装镜像后按新源刷新）。 */
  const [catalogEpoch, setCatalogEpoch] = useState(0)

  // Escape 关闭由 Modal 的窗口级关闭栈统一处理（只关最上层），此处不再单独监听。

  useEffect(() => {
    if (step !== 2 || transport !== 'local' || localProbeDone) return
    let cancelled = false
    void Promise.all([
      window.dshHub?.runtime.probeLocalDsh(),
      window.dshHub?.runtime.scanExternal()
    ]).then(([runtime, external]) => {
      if (!cancelled) {
        setLocalLaunchers(runtime?.ok ? runtime.value : [])
        setExternalWorkspace(
          external?.ok
            ? ((external.value.find((item) => item.port !== null) as
                ExternalWorkspace | undefined) ?? null)
            : null
        )
        setLocalProbeDone(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [step, transport, localProbeDone])

  // 本地实例：向导一打开就预取版本目录（走到第 2 步时通常已就绪）；切换安装镜像后按新源重取。
  useEffect(() => {
    if (transport !== 'local') return
    let cancelled = false
    setVersionCatalogError(null)
    void window.dshHub?.runtime.listDshVersions().then((result) => {
      if (cancelled) return
      if (result?.ok) setVersionCatalog(result.value)
      else setVersionCatalogError(result?.message ?? t('common.unknown'))
    })
    return () => {
      cancelled = true
    }
  }, [transport, catalogEpoch, t])

  // 版本默认与本地版本相同：本机探测到的 dsh 优先，其次 hub 已安装的最新；用户改过不覆盖。
  useEffect(() => {
    if (versionTouched || form.version !== '') return
    const preset =
      localLaunchers.find((item) => item.launcher === 'dsh')?.version ??
      versionCatalog?.installed[0]
    if (preset) {
      setForm((current) => (current.version === '' ? { ...current, version: preset } : current))
    }
  }, [versionTouched, form.version, localLaunchers, versionCatalog])

  // 加载当前设置以初始化安装镜像默认值
  useEffect(() => {
    if (settingsLoaded) return
    void window.dshHub?.settings.get().then((result) => {
      if (result.ok) {
        setForm((current) => ({
          ...current,
          registry: current.registry === '' ? (result.value.npmRegistry ?? '') : current.registry
        }))
        setSettingsLoaded(true)
      }
    })
  }, [settingsLoaded])

  /** 镜像选择落盘；写失败以 toast 提示，避免用户以为已生效。成功后按新源重取版本列表。 */
  const persistRegistry = (url: string): void => {
    void window.dshHub?.settings.update({ npmRegistry: url }).then((result) => {
      if (!result.ok) toast('err', t('settings.saveFailed'), result.message)
      else setCatalogEpoch((epoch) => epoch + 1)
    })
  }

  const set =
    (key: Exclude<keyof WizardForm, 'useDefaultSpace'>) =>
    (event: { target: { value: string } }) => {
      const value = event.target.value
      setForm((current) => ({ ...current, [key]: value }))
      if (key === 'name' && value.trim() !== '') setError(null)
    }

  const reusableExternalInstance =
    transport === 'local' && useExistingExternal && externalWorkspace
      ? instances.find(
          (instance) =>
            instance.transport === 'local' &&
            instance.address === `127.0.0.1:${externalWorkspace.port}`
        )
      : undefined
  const configuredName = reusableExternalInstance?.name ?? form.name

  // 版本下拉：registry 最近 10 个（从新到旧、最新在上）；本地版本/当前选中值不在其中时补在末尾。
  const localDshVersion = localLaunchers.find((item) => item.launcher === 'dsh')?.version
  const versionOptions = buildVersionOptions(
    versionCatalog?.versions ?? [],
    localDshVersion,
    form.version
  )

  const { validate, submit } = useCreateInstance({
    transport,
    form,
    useExistingExternal,
    externalWorkspace,
    reusableExternalInstanceId: reusableExternalInstance?.id ?? null,
    existingSpaceId,
    setBusy,
    setError,
    setStep
  })

  return (
    <Modal
      closeLabel={t('common.close')}
      wide
      title={t('wizard.title')}
      sub={t('wizard.sub')}
      onClose={() => setWizardOpen(false)}
      testId="wizard"
      footer={
        <>
          <span className="modal-foot-copy meta">
            {step === 2 && t('wizard.nextShortcut')}
            {error && <span className="err">{error}</span>}
          </span>
          <div className="right">
            {step > 1 && (
              <button
                className="btn btn-secondary"
                onClick={() => setStep(step - 1)}
                disabled={busy}
              >
                {t('wizard.prev')}
              </button>
            )}
            {step < 3 ? (
              <button
                className="btn btn-primary"
                onClick={() => {
                  // 仅在填写配置和创建前校验表单。
                  if (step === 1) {
                    setError(null)
                    setStep(2)
                    return
                  }
                  const problem = validate()
                  if (problem) setError(problem)
                  else setStep(step + 1)
                }}
                disabled={busy}
              >
                {t('wizard.next')}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={() => void submit()}
                disabled={busy}
                data-testid="wizard-create"
              >
                {busy ? t('wizard.creating') : t('wizard.create')}
              </button>
            )}
          </div>
        </>
      }
    >
      <div className="stepper">
        {STEP_KEYS.map((labelKey, index) => {
          const n = index + 1
          const cls = n === step ? 'on' : n < step ? 'done' : ''
          return (
            <div key={labelKey} style={{ display: 'contents' }}>
              <span className={`step ${cls}`}>
                <b>{n}</b>
                {t(labelKey)}
              </span>
              {n < 3 && <span className="step-line" />}
            </div>
          )
        })}
      </div>

      {step === 1 && <StepTransport t={t} transport={transport} onSelect={setTransport} />}

      {step === 2 && (
        <div data-testid="wizard-step-2">
          <div className="field">
            <label htmlFor="wizard-name">{t('wizard.nameLabel')}</label>
            <input
              className="input"
              id="wizard-name"
              placeholder={t('wizard.namePlaceholder')}
              value={configuredName}
              onChange={set('name')}
              disabled={reusableExternalInstance !== undefined}
              data-testid="wizard-name"
            />
            <span className="hint">{t('wizard.nameHint')}</span>
          </div>

          {transport === 'local' && (
            <LocalConfig
              t={t}
              form={form}
              set={set}
              setForm={setForm}
              external={{
                workspace: externalWorkspace,
                useExisting: useExistingExternal,
                setUseExisting: setUseExistingExternal
              }}
              versions={{
                localLaunchers,
                versionOptions,
                catalog: versionCatalog,
                catalogError: versionCatalogError,
                setVersionTouched
              }}
              persistRegistry={persistRegistry}
            />
          )}

          {transport === 'ssh' && <SshConfig t={t} form={form} set={set} />}

          {transport === 'http' && <HttpConfig t={t} form={form} set={set} />}
        </div>
      )}

      {step === 3 && (
        <StepConfirm
          t={t}
          transport={transport}
          form={form}
          configuredName={configuredName}
          useExistingExternal={useExistingExternal}
          externalWorkspace={externalWorkspace}
          localLaunchersCount={localLaunchers.length}
        />
      )}
    </Modal>
  )
}
