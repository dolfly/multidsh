import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { VaultStatusSnapshot, LocalSpaceSnapshot } from '@shared/contracts'
import { LANGUAGES, THEMES } from '@shared/settings'
import type { LanguagePreference, Theme } from '@shared/settings'
import { Icon } from '../lib/icons'
import { InfoTip } from './InfoTip'
import { Modal } from './Modal'
import { useAppStore } from '../store'

const BRIDGE = window.dshHub

/**
 * 设置页：语言、主题、原生偏好、数据目录和凭据存储。
 * 设置更改在持久化成功后显示确认。
 */
export default function SettingsView(): ReactNode {
  const t = useAppStore((state) => state.t)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const toast = useAppStore((state) => state.toast)
  const userDataPath = useAppStore((state) => state.userDataPath)
  const createWithExistingSpace = useAppStore((state) => state.createWithExistingSpace)
  const openDetail = useAppStore((state) => state.openDetail)
  const [vault, setVault] = useState<VaultStatusSnapshot | null>(null)
  const [spaces, setSpaces] = useState<LocalSpaceSnapshot[]>([])
  const [trashTarget, setTrashTarget] = useState<LocalSpaceSnapshot | null>(null)
  /** 重新检测环境后、正在运行且可重启的本机实例 id；非 null 时弹出重启确认框。 */
  const [restartPrompt, setRestartPrompt] = useState<string[] | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    void BRIDGE?.vault.status().then((result) => {
      if (result.ok) setVault(result.value)
    })
  }, [])

  useEffect(() => {
    void BRIDGE?.spaces.list().then((result) => {
      if (result.ok) setSpaces(result.value)
    })
  }, [])

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  const formatTime = (value: string): string => new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(value))

  const totalSpaceBytes = spaces.reduce((total, space) => total + space.sizeBytes, 0)

  const trashSpace = (): void => {
    const space = trashTarget
    if (!space || space.inUse) return
    void BRIDGE?.spaces.trash(space.id).then((result) => {
      if (!result.ok) {
        toast('err', t('spaces.trashFailed'), result.message)
        return
      }
      setSpaces((current) => current.filter((item) => item.id !== space.id))
      setTrashTarget(null)
      toast('ok', t('spaces.trashed'))
    })
  }
  const apply = (patch: Parameters<typeof updateSettings>[0]): void => {
    // 仅在设置持久化成功后显示确认。
    void updateSettings(patch).then(
      () => toast('ok', t('settings.saved')),
      (error: unknown) => toast('err', t('settings.saveFailed'), String(error))
    )
  }

  const clearVault = (): void => {
    void BRIDGE?.vault.clear().then((result) => {
      if (result.ok) {
        setVault(result.value)
        toast('ok', t('settings.cleared'))
      }
    })
  }

  /**
   * 主进程自行解析数据目录，渲染层不传路径，避免将通道用于打开任意文件。
   */
  const openDataDir = (): void => {
    void BRIDGE?.settings.openDataDir().then((result) => {
      if (result && !result.ok) toast('err', t('settings.openDataDirFailed'), result.message)
    })
  }

  /** 打开应用内「关于」叠加窗口；Windows/Linux 无菜单栏，设置页承担此入口。 */
  const openAbout = (): void => {
    void BRIDGE?.openAbout()
  }

  /**
   * 重新检测本机环境（PATH / 登录 shell）：失效主进程缓存并重解析。
   * 若有正在运行、可重启的本机实例，弹出确认框由用户决定是否立即重启生效。
   */
  const refreshEnv = (): void => {
    if (refreshing) return
    setRefreshing(true)
    void BRIDGE?.settings
      .refreshEnvironment()
      .then((result) => {
        if (!result) return
        if (!result.ok) {
          toast('err', t('settings.refreshEnvFailed'), result.message)
          return
        }
        if (result.value.length > 0) setRestartPrompt(result.value)
        else toast('ok', t('settings.refreshEnvDone'))
      })
      .finally(() => setRefreshing(false))
  }

  /** 用户确认后重启运行中的本机实例，使新环境立即生效。 */
  const restartForEnv = (): void => {
    const ids = restartPrompt ?? []
    setRestartPrompt(null)
    if (ids.length === 0) return
    void Promise.all(ids.map((id) => BRIDGE?.runtime.restart(id))).then((results) => {
      const failed = results.some((result) => result && !result.ok)
      if (failed) toast('err', t('settings.refreshEnvRestartFailed'))
      else toast('ok', t('settings.refreshEnvRestarted', { count: ids.length }))
    })
  }

  return (
    <section data-testid="view-settings">
      <h2 className="h2">{t('settings.title')}</h2>

      <div className="grid-2 mt12 settings-align">
        <div className="card">
          <div className="card-head">
            <h3>{t('settings.language')}</h3>
            <span className="meta">{t('settings.languageHint')}</span>
          </div>
          <div className="row mt12" style={{ gap: 8 }}>
            {LANGUAGES.map((language: LanguagePreference) => (
              <button
                key={language}
                className={`btn btn-sm ${settings.language === language ? 'btn-primary' : 'btn-secondary'}`}
                data-testid={`settings-language-${language}`}
                onClick={() => apply({ language })}
              >
                {language === 'system'
                  ? t('settings.languageSystem')
                  : language === 'zh'
                    ? t('settings.languageChinese')
                    : t('settings.languageEnglish')}
              </button>
            ))}
          </div>

          <div className="card-head mt12">
            <h3>{t('settings.theme')}</h3>
          </div>
          <div className="row mt12" style={{ gap: 8 }}>
            {THEMES.map((theme: Theme) => (
              <button
                key={theme}
                className={`btn btn-sm ${settings.theme === theme ? 'btn-primary' : 'btn-secondary'}`}
                data-testid={`settings-theme-${theme}`}
                onClick={() => apply({ theme })}
              >
                {theme === 'system'
                  ? t('settings.themeSystem')
                  : theme === 'light'
                    ? t('settings.themeLight')
                    : t('settings.themeDark')}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          {/*
            标题行右侧挂控件，说明正文收进标题旁的 info 气泡（hover/点击展开），
            卡片里只保留标题与控件，不再为长说明占行。
          */}
          <div className="card-head">
            <h3>{t('settings.general')}</h3>
          </div>
          <label className="row" style={{ gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              data-testid="settings-tray"
              checked={settings.tray}
              onChange={(event) => apply({ tray: event.target.checked })}
            />
            <span>{t('settings.tray')}</span>
          </label>
          <label className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              data-testid="settings-autostart"
              checked={settings.autoStart}
              onChange={(event) => apply({ autoStart: event.target.checked })}
            />
            <span>{t('settings.autoStart')}</span>
          </label>
          <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
            <label className="row" style={{ gap: 8, alignItems: 'center', flex: 1, minWidth: 0 }}>
              <input
                type="checkbox"
                data-testid="settings-prevent-sleep"
                checked={settings.preventSleepWhenRunning}
                onChange={(event) => apply({ preventSleepWhenRunning: event.target.checked })}
              />
              <span>{t('settings.preventSleepWhenRunning')}</span>
            </label>
            <InfoTip
              text={t('settings.preventSleepWhenRunningHint')}
              label={t('common.hint')}
            />
          </div>
          <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
            <label className="row" style={{ gap: 8, alignItems: 'center', flex: 1, minWidth: 0 }}>
              <input
                type="checkbox"
                data-testid="settings-inherit-shell-env"
                checked={settings.inheritShellEnv}
                onChange={(event) => apply({ inheritShellEnv: event.target.checked })}
              />
              <span>{t('settings.inheritShellEnv')}</span>
            </label>
            <InfoTip text={t('settings.inheritShellEnvHint')} label={t('common.hint')} />
          </div>

          {/* 环境重新检测是一次性动作：按钮固定在标题行右侧，说明收进标题旁的气泡。 */}
          <div className="card-head mt12">
            <div className="row" style={{ gap: 6, minWidth: 0 }}>
              <h3>{t('settings.refreshEnv')}</h3>
              <InfoTip text={t('settings.refreshEnvHint')} label={t('common.hint')} />
            </div>
            <button
              className="btn btn-secondary btn-sm"
              data-testid="settings-refresh-env"
              disabled={refreshing}
              onClick={refreshEnv}
            >
              <Icon name="refresh" /> {t('settings.refreshEnvAction')}
            </button>
          </div>

          {/* 缓存数量同样标题在上、控件在标题行右侧，与上方动作行保持一致。 */}
          <div className="card-head mt12">
            <div className="row" style={{ gap: 6, minWidth: 0 }}>
              <h3>{t('settings.workspaceCache')}</h3>
              <InfoTip text={t('settings.workspaceCacheHint')} label={t('common.hint')} />
            </div>
            <input
              className="input"
              type="number"
              min={1}
              max={10}
              step={1}
              value={settings.workspaceCacheSize}
              aria-label={t('settings.workspaceCache')}
              data-testid="settings-workspace-cache-size"
              onChange={(event) => {
                const value = Number(event.target.value)
                if (Number.isInteger(value) && value >= 1 && value <= 10) apply({ workspaceCacheSize: value })
              }}
              style={{ width: 70, flex: 'none' }}
            />
          </div>
        </div>
      </div>

      <div className="card mt12">
        <div className="card-head">
          <h3>{t('settings.dataDir')}</h3>
        </div>
        {/* 设计稿 data-act="open-dir":展示路径 + 「打开」按钮(与行内其它按钮同规格) */}
        <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
          {/* 路径可能很长:允许在任意位置换行,不把「打开」按钮挤出卡片 */}
          <span
            className="meta num"
            style={{ minWidth: 0, overflowWrap: 'anywhere' }}
            data-testid="settings-data-dir"
          >
            {userDataPath ?? '—'}
          </span>
          <button
            className="btn btn-secondary btn-sm"
            data-act="open-dir"
            data-testid="settings-open-data-dir"
            onClick={openDataDir}
          >
            {t('settings.openDataDir')}
          </button>
        </div>
      </div>

      <details className="adv card spaces-card mt12" data-testid="settings-spaces">
        <summary>
          <h3>{t('spaces.title')}</h3>
          <span className="meta num spaces-summary">
            {t('spaces.summary', { count: spaces.length, size: formatSize(totalSpaceBytes) })}
          </span>
        </summary>
        <span className="meta">{t('spaces.description')}</span>
        {spaces.length === 0 ? (
          <p className="meta mt12">{t('spaces.empty')}</p>
        ) : (
          <div className="spaces-table mt12" role="table">
            <div className="spaces-row spaces-head meta" role="row">
              <span role="columnheader">{t('spaces.columnIndex')}</span>
              <span role="columnheader">{t('spaces.columnTitle')}</span>
              <span role="columnheader">{t('spaces.columnSize')}</span>
              <span role="columnheader">{t('spaces.columnModified')}</span>
              <span aria-hidden="true" />
            </div>
            {spaces.map((space, index) => (
              <div className="spaces-row" key={space.id} role="row">
                <span className="meta num" role="cell">{index + 1}</span>
                <span role="cell" style={{ minWidth: 0 }}>
                  {space.instanceName ? (
                    <>
                      <strong>{space.instanceName}</strong>
                      <span className="meta num" style={{ display: 'block', marginTop: 2, overflowWrap: 'anywhere' }}>{space.id}</span>
                    </>
                  ) : (
                    <span className="num" style={{ overflowWrap: 'anywhere' }}>{space.id}</span>
                  )}
                </span>
                <span className="meta num" role="cell">{t('spaces.size', { size: formatSize(space.sizeBytes) })}</span>
                <span className="meta num" role="cell">{t('spaces.modifiedAt', { time: formatTime(space.modifiedAt) })}</span>
                <span className="spaces-actions" role="cell">
                  {space.inUse ? (
                    <button className="btn btn-secondary btn-sm" onClick={() => openDetail(space.id)}>
                      {t('spaces.instanceDetail')}
                    </button>
                  ) : (
                    <>
                      <button className="btn btn-secondary btn-sm" onClick={() => createWithExistingSpace(space.id)}>
                        {t('spaces.createInstance')}
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => setTrashTarget(space)}>
                        <Icon name="trash" /> {t('spaces.delete')}
                      </button>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </details>

      <div className="grid-2 mt12">
        <div className="card" data-testid="settings-vault">
          <div className="card-head">
            <h3>{t('vault.title')}</h3>
            <span className="meta">
              {vault?.degraded ? t('vault.backendMemory') : t('vault.backendKeychain')}
            </span>
          </div>
          {vault?.degraded && (
            <div className="note n-warn mt12">
              <Icon name="alert" />
              <span>{t('vault.degraded')}</span>
            </div>
          )}
          <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
            <button
              className="btn btn-secondary btn-sm"
              data-testid="settings-clear-vault"
              onClick={clearVault}
            >
              <Icon name="trash" /> {t('settings.clearCredentials')}
            </button>
            <span className="meta">
              {vault && vault.rememberedInstances.length > 0
                ? t('vault.remembered')
                : t('vault.notRemembered')}
            </span>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>{t('about.open')}</h3>
            <span className="meta">{t('about.sectionHint')}</span>
          </div>
          <div className="row mt12" style={{ gap: 8, alignItems: 'center' }}>
            <button
              className="btn btn-secondary btn-sm"
              data-testid="settings-open-about"
              onClick={openAbout}
            >
              <Icon name="info" /> {t('about.open')}
            </button>
          </div>
        </div>
      </div>
      {trashTarget && (
        <Modal
          title={t('spaces.trashTitle')}
          closeLabel={t('common.close')}
          closeButtonInTabOrder={false}
          onClose={() => setTrashTarget(null)}
          testId="settings-confirm-trash-space"
          footer={
            <div className="right">
              <button className="btn btn-secondary btn-sm" onClick={() => setTrashTarget(null)}>{t('common.cancel')}</button>
              <button className="btn btn-danger btn-sm" onClick={trashSpace}>{t('spaces.delete')}</button>
            </div>
          }
        >
          <p className="meta">{t('spaces.trashConfirm')}</p>
          <p className="meta num mt12" style={{ overflowWrap: 'anywhere' }}>{trashTarget.id}</p>
        </Modal>
      )}
      {restartPrompt && restartPrompt.length > 0 && (
        <Modal
          title={t('settings.refreshEnvRestartTitle')}
          closeLabel={t('common.close')}
          closeButtonInTabOrder={false}
          onClose={() => setRestartPrompt(null)}
          testId="settings-confirm-restart-env"
          footer={
            <div className="right">
              <button className="btn btn-secondary btn-sm" onClick={() => setRestartPrompt(null)}>
                {t('settings.refreshEnvRestartLater')}
              </button>
              <button className="btn btn-primary btn-sm" data-testid="settings-restart-env-confirm" onClick={restartForEnv}>
                {t('settings.refreshEnvRestartConfirm')}
              </button>
            </div>
          }
        >
          <p className="meta">{t('settings.refreshEnvRestartBody', { count: restartPrompt.length })}</p>
        </Modal>
      )}
    </section>
  )
}
