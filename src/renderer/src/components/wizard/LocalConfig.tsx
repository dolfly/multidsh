import type { ReactNode } from 'react'
import { REGISTRY_PRESETS, registryPresetKey } from '@shared/settings'
import { LAUNCHERS } from '@shared/local-launch'
import type { Translator } from '@shared/i18n'
import { Icon } from '../../lib/icons'
import type { DshVersionCatalog } from '@shared/contracts'
import { useAppStore } from '../../store'
import type { ExternalWorkspace, WizardForm } from './types'

/** 外部 dsh 接管相关字段。 */
export interface ExternalAdoption {
  workspace: ExternalWorkspace | null
  useExisting: boolean
  setUseExisting: (value: boolean) => void
}

/** 版本目录与启动器探测结果（高级设置的版本/启动器下拉数据源）。 */
export interface VersionCatalogState {
  localLaunchers: Array<{ launcher: WizardForm['launcher']; version: string }>
  versionOptions: string[]
  catalog: DshVersionCatalog | null
  catalogError: string | null
  setVersionTouched: (value: boolean) => void
}

export interface LocalConfigProps {
  t: Translator
  form: WizardForm
  set: (key: Exclude<keyof WizardForm, 'useDefaultSpace'>) => (event: { target: { value: string } }) => void
  setForm: (updater: (current: WizardForm) => WizardForm) => void
  external: ExternalAdoption
  versions: VersionCatalogState
  persistRegistry: (url: string) => void
}

/** 本机实例配置：外部 dsh 接管选项 + 高级设置（启动器/版本/配置档案/端口/空间/镜像）。 */
export default function LocalConfig(props: LocalConfigProps): ReactNode {
  const { t, form, set, setForm, external, versions, persistRegistry } = props
  const { workspace: externalWorkspace, useExisting: useExistingExternal, setUseExisting: setUseExistingExternal } =
    external
  // 公共空间（默认 DSH_HOME）的本机绝对路径：Windows 为 C:\Users\<用户>\.dsh，
  // 其它平台为 /Users|home/<用户>/.dsh。向导里直接展示解析后的真实路径，避免 ~/.dsh 歧义。
  const defaultDshHome = useAppStore((state) => state.defaultDshHome)
  const { localLaunchers, versionOptions, catalog: versionCatalog, catalogError: versionCatalogError, setVersionTouched } =
    versions
  return (
    <>
      {externalWorkspace && (
        <div className="note n-info mt12" data-testid="wizard-external-dsh">
          <Icon name="info" />
          <div>
            <b>{t('wizard.externalDetected', { port: externalWorkspace.port })}</b>
            <label className="check mt8">
              <input
                type="checkbox"
                checked={useExistingExternal}
                onChange={(event) => setUseExistingExternal(event.target.checked)}
              />
              {t('wizard.useExistingExternal')}
            </label>
            {useExistingExternal && (
              <div className="field mt8">
                <label htmlFor="wizard-external-access">{t('wizard.externalAccessLabel')}</label>
                <input
                  className="input num"
                  id="wizard-external-access"
                  type="password"
                  value={form.externalAccess}
                  onChange={set('externalAccess')}
                  autoComplete="off"
                  data-testid="wizard-external-access"
                />
                <span className="hint">{t('wizard.externalAccessHint')}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {!useExistingExternal && (
        <details className="adv mt12">
          <summary>{t('wizard.advanced')}</summary>
          <div className="grid-2 mt8">
            <div className="field">
              <label htmlFor="wizard-launcher">{t('wizard.launcherLabel')}</label>
              <select
                className="input"
                id="wizard-launcher"
                value={form.launcher}
                onChange={set('launcher')}
                data-testid="wizard-launcher"
              >
                {/* dsh 恒为默认项（缺失时仍可选，启动会提示下载）；dush/duush 未检测到就不出现。 */}
                {LAUNCHERS.filter(
                  (name) => name === 'dsh' || localLaunchers.some((item) => item.launcher === name)
                ).map((name) => {
                  const detected = localLaunchers.find((item) => item.launcher === name)?.version ?? null
                  return (
                    <option key={name} value={name}>
                      {name}
                      {detected !== null ? ` · ${detected}` : ` · ${t('wizard.launcherMissing')}`}
                    </option>
                  )
                })}
              </select>
              {localLaunchers.length === 0 && <span className="hint">{t('wizard.launcherMissingHint')}</span>}
            </div>
            <div className="field">
              <label htmlFor="wizard-version">{t('wizard.versionLabel')}</label>
              <select
                className="input num"
                id="wizard-version"
                value={form.version}
                onChange={(event) => {
                  setVersionTouched(true)
                  setForm((current) => ({ ...current, version: event.target.value }))
                }}
                disabled={versionCatalog === null && versionCatalogError === null}
                data-testid="wizard-version"
              >
                <option value="">{t('wizard.versionLatest')}</option>
                {versionOptions.map((version) => (
                  <option key={version} value={version}>
                    {version}
                  </option>
                ))}
              </select>
              <span className="hint" data-testid="wizard-version-hint">
                {versionCatalogError !== null
                  ? t('wizard.versionFetchFailed', { msg: versionCatalogError })
                  : versionCatalog === null
                    ? t('wizard.versionLoading')
                    : t('wizard.versionHint')}
              </span>
            </div>
            <div className="field">
              <label htmlFor="wizard-profile">{t('wizard.profileLabel')}</label>
              <input
                className="input num"
                id="wizard-profile"
                placeholder={t('wizard.profilePlaceholder')}
                value={form.profile}
                onChange={set('profile')}
              />
            </div>
            <div className="field">
              <label htmlFor="wizard-port">{t('wizard.portLabel')}</label>
              <input
                className="input num"
                id="wizard-port"
                placeholder={t('wizard.portPlaceholder')}
                value={form.port}
                onChange={set('port')}
              />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="wizard-space">{t('wizard.spaceLabel')}</label>
              <select
                className="input"
                id="wizard-space"
                value={form.useDefaultSpace ? 'shared' : 'isolated'}
                onChange={(event) =>
                  setForm((current) => ({ ...current, useDefaultSpace: event.target.value === 'shared' }))
                }
                data-testid="wizard-space"
              >
                <option value="isolated">{t('wizard.spaceIsolated')}</option>
                <option value="shared">{t('wizard.spaceShared')}</option>
              </select>
              {/* 选公共空间时显示解析后的真实路径（Windows 展开为 C:\Users\<用户>\.dsh）。 */}
              {form.useDefaultSpace && defaultDshHome && (
                <span className="hint num" data-testid="wizard-space-path">
                  {t('wizard.spaceSharedPath', { path: defaultDshHome })}
                </span>
              )}
              <span className="hint">{t('wizard.spaceHint')}</span>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="wizard-registry">{t('wizard.registryLabel')}</label>
              <select
                className="input"
                id="wizard-registry"
                value={registryPresetKey(form.registry)}
                onChange={(event) => {
                  const key = event.target.value
                  if (key === 'custom') return // 仅切出输入框；当前值保持原样，由输入框失焦落盘
                  const url = key === 'system' ? '' : key
                  setForm((current) => ({ ...current, registry: url }))
                  persistRegistry(url)
                }}
                data-testid="wizard-registry"
              >
                <option value="system">{t('wizard.registrySystem')}</option>
                {REGISTRY_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {t(preset.labelKey)}
                  </option>
                ))}
                <option value="custom">{t('wizard.registryCustom')}</option>
              </select>
              {registryPresetKey(form.registry) === 'custom' && (
                <input
                  className="input num mt4"
                  id="wizard-registry-url"
                  placeholder="https://registry.npmmirror.com"
                  value={form.registry}
                  onChange={(event) => {
                    const url = event.target.value.trim()
                    setForm((current) => ({ ...current, registry: url }))
                  }}
                  onBlur={() => persistRegistry(form.registry)}
                  data-testid="wizard-registry-url"
                />
              )}
              <span className="hint">{t('wizard.registryHint')}</span>
            </div>
          </div>
        </details>
      )}
    </>
  )
}
