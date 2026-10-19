import { useState } from 'react'
import type { ReactNode } from 'react'
import { isValidProfile, type InstanceRecord, type PatchInstanceInput } from '@shared/contracts'
import { LAUNCHERS, type LocalLauncher } from '@shared/local-launch'
import { REGISTRY_PRESETS, isAllowedNpmRegistry, registryPresetKey } from '@shared/settings'
import { Icon } from '../lib/icons'
import { useAppStore } from '../store'
import { Modal } from './Modal'

/**
 * 编辑当前 transport 支持的实例字段。transport 不可变更；如需变更则删除后重建。
 * 端口留空时恢复自动分配；运行中实例的配置在下次启动时生效。
 * 对话框取与「更多」日志浮层一致的 wide 宽度：两列表单字段与长端点输入不被挤压。
 */
export default function EditInstanceDialog({
  record,
  running,
  onClose
}: {
  record: InstanceRecord
  running: boolean
  onClose: () => void
}): ReactNode {
  const t = useAppStore((state) => state.t)
  const refreshList = useAppStore((state) => state.refreshList)
  // 保存后重新读取记录，因为 ensureRecord 只在缓存缺失时读取。
  const reloadRecord = useAppStore((state) => state.reloadRecord)
  const toast = useAppStore((state) => state.toast)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)

  const [name, setName] = useState(record.name)
  const [notes, setNotes] = useState(record.notes ?? '')
  const [authMode, setAuthMode] = useState(record.authMode)
  const [port, setPort] = useState(
    record.transport === 'local' ? (record.port ? String(record.port) : '') : ''
  )
  const [profile, setProfile] = useState(record.transport === 'local' ? (record.profile ?? '') : '')
  const [launcher, setLauncher] = useState<LocalLauncher>(
    record.transport === 'local' ? (record.launcher ?? 'dsh') : 'dsh'
  )
  const [autoStart, setAutoStart] = useState(
    record.transport === 'local' ? record.autoStart : false
  )
  const [host, setHost] = useState(record.transport === 'ssh' ? record.host : '')
  const [username, setUsername] = useState(record.transport === 'ssh' ? record.username : '')
  const [remotePort, setRemotePort] = useState(
    record.transport === 'ssh' ? String(record.remotePort) : ''
  )
  const [identityFile, setIdentityFile] = useState(
    record.transport === 'ssh' ? (record.identityFile ?? '') : ''
  )
  const [endpointUrl, setEndpointUrl] = useState(
    record.transport === 'http' ? record.endpointUrl : ''
  )
  const [busy, setBusy] = useState(false)
  /**
   * 安装镜像（应用级设置，非实例字段）：URL 态（'' = 跟随系统 npm 配置）+ 是否选中「自定义」档。
   * 选中自定义只切出输入框，URL 保持原样，由输入框内容决定落盘值。
   */
  const [registryUrl, setRegistryUrl] = useState(settings.npmRegistry)
  const [registryCustom, setRegistryCustom] = useState(
    registryPresetKey(settings.npmRegistry) === 'custom'
  )

  const save = async (): Promise<void> => {
    if (name.trim() === '') {
      toast('err', t('edit.nameRequired'))
      return
    }
    const patch: PatchInstanceInput = {
      name: name.trim(),
      notes: notes.trim() === '' ? null : notes.trim(),
      authMode
    }
    if (record.transport === 'local') {
      if (profile.trim() !== '' && !isValidProfile(profile)) {
        toast('err', t('edit.failed'), t('edit.profileInvalid'))
        return
      }
      // 安装镜像是应用级设置：先校验并落盘，失败即中止（不动实例记录）。
      const registry = registryUrl.trim()
      if (registry !== '' && !isAllowedNpmRegistry(registry)) {
        toast('err', t('edit.failed'), t('edit.registryInvalid'))
        return
      }
      if (registry !== settings.npmRegistry) {
        setBusy(true)
        try {
          await updateSettings({ npmRegistry: registry })
        } catch (error) {
          setBusy(false)
          toast('err', t('edit.failed'), error instanceof Error ? error.message : undefined)
          return
        }
        setBusy(false)
      }
      patch.port = port.trim() === '' ? null : Number(port.trim())
      patch.profile = profile.trim() === '' ? null : profile.trim()
      patch.launcher = launcher === 'dsh' ? null : launcher
      patch.autoStart = autoStart
    } else if (record.transport === 'ssh') {
      if (host.trim() === '' || username.trim() === '' || remotePort.trim() === '') {
        toast('err', t('edit.sshRequired'))
        return
      }
      patch.host = host.trim()
      patch.username = username.trim()
      patch.remotePort = Number(remotePort.trim())
      patch.identityFile = identityFile.trim() === '' ? null : identityFile.trim()
    } else {
      if (endpointUrl.trim() === '') {
        toast('err', t('edit.endpointRequired'))
        return
      }
      patch.endpointUrl = endpointUrl.trim()
    }
    setBusy(true)
    const result = await window.dshHub?.instances.update(record.id, patch)
    setBusy(false)
    if (result && !result.ok) {
      toast('err', t('edit.failed'), result.message)
      return
    }
    await Promise.all([refreshList(), reloadRecord(record.id)])
    toast('ok', t('edit.saved'))
    onClose()
  }

  return (
    <Modal
      wide
      title={t('edit.title')}
      sub={t('edit.sub', { name: record.name })}
      onClose={onClose}
      testId="edit-dialog"
      closeLabel={t('common.close')}
      footer={
        <div className="right">
          <button className="btn btn-secondary btn-sm" onClick={onClose} data-testid="edit-cancel">
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => void save()}
            disabled={busy}
            data-testid="edit-save"
          >
            <Icon name="check" /> {t('common.save')}
          </button>
        </div>
      }
    >
      <div className="field">
        <label htmlFor="edit-name">{t('edit.nameLabel')}</label>
        <input
          className="input"
          id="edit-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          data-testid="edit-name"
        />
      </div>
      <div className="field mt8">
        <label htmlFor="edit-notes">{t('edit.notesLabel')}</label>
        <textarea
          className="input"
          id="edit-notes"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          data-testid="edit-notes"
        />
      </div>
      <div className="field mt8">
        <label htmlFor="edit-authmode">{t('edit.authModeLabel')}</label>
        <select
          className="input"
          id="edit-authmode"
          value={authMode}
          onChange={(event) => setAuthMode(event.target.value as typeof authMode)}
          data-testid="edit-authmode"
        >
          <option value="auto">{t('edit.authModeAuto')}</option>
          <option value="none">{t('edit.authModeNone')}</option>
          <option value="gateway">{t('edit.authModeGateway')}</option>
        </select>
        <span className="hint">{t('edit.authModeHint')}</span>
      </div>

      {record.transport === 'local' && (
        <div className="grid-2 mt8">
          <div className="field">
            <label htmlFor="edit-port">{t('edit.portLabel')}</label>
            <input
              className="input num"
              id="edit-port"
              inputMode="numeric"
              placeholder={t('edit.portPlaceholder')}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              data-testid="edit-port"
            />
          </div>
          <div className="field">
            <label htmlFor="edit-profile">{t('edit.profileLabel')}</label>
            <input
              className="input"
              id="edit-profile"
              placeholder={t('edit.profilePlaceholder')}
              value={profile}
              onChange={(event) => setProfile(event.target.value)}
              data-testid="edit-profile"
            />
          </div>
          <div className="field">
            <label htmlFor="edit-launcher">{t('edit.launcherLabel')}</label>
            <select
              className="input"
              id="edit-launcher"
              value={launcher}
              onChange={(event) => setLauncher(event.target.value as LocalLauncher)}
              data-testid="edit-launcher"
            >
              {LAUNCHERS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <span className="hint">{t('edit.launcherHint')}</span>
          </div>
          <label
            className="row mt12"
            style={{ gap: 8, alignItems: 'center' }}
            htmlFor="edit-autostart"
          >
            <input
              type="checkbox"
              id="edit-autostart"
              checked={autoStart}
              onChange={(event) => setAutoStart(event.target.checked)}
              data-testid="edit-autostart"
            />
            <span>{t('edit.autoStartLabel')}</span>
          </label>
          {/* 安装镜像是应用级设置（dsh 下载与插件默认源都跟它走），跨两列摆放并明示作用范围。 */}
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="edit-registry">{t('wizard.registryLabel')}</label>
            <select
              className="input"
              id="edit-registry"
              value={registryCustom ? 'custom' : registryPresetKey(registryUrl)}
              onChange={(event) => {
                const key = event.target.value
                // 选「自定义」只切出输入框：URL 保持原样，由输入框编辑。
                if (key === 'custom') {
                  setRegistryCustom(true)
                  return
                }
                setRegistryCustom(false)
                setRegistryUrl(key === 'system' ? '' : key)
              }}
              data-testid="edit-registry"
            >
              <option value="system">{t('wizard.registrySystem')}</option>
              {REGISTRY_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {t(preset.labelKey)}
                </option>
              ))}
              <option value="custom">{t('wizard.registryCustom')}</option>
            </select>
            {registryCustom && (
              <input
                className="input num mt4"
                id="edit-registry-url"
                placeholder="https://registry.npmmirror.com"
                value={registryUrl}
                onChange={(event) => setRegistryUrl(event.target.value.trim())}
                data-testid="edit-registry-url"
              />
            )}
            <span className="hint">{t('wizard.registryHint')}</span>
          </div>
        </div>
      )}

      {record.transport === 'ssh' && (
        <div className="grid-2 mt8">
          <div className="field">
            <label htmlFor="edit-host">{t('edit.hostLabel')}</label>
            <input
              className="input"
              id="edit-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              data-testid="edit-host"
            />
          </div>
          <div className="field">
            <label htmlFor="edit-username">{t('edit.usernameLabel')}</label>
            <input
              className="input"
              id="edit-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              data-testid="edit-username"
            />
          </div>
          <div className="field">
            <label htmlFor="edit-remoteport">{t('edit.remotePortLabel')}</label>
            <input
              className="input num"
              id="edit-remoteport"
              inputMode="numeric"
              value={remotePort}
              onChange={(event) => setRemotePort(event.target.value)}
              data-testid="edit-remoteport"
            />
          </div>
          <div className="field">
            <label htmlFor="edit-identity">{t('edit.identityLabel')}</label>
            <input
              className="input"
              id="edit-identity"
              placeholder={t('edit.identityPlaceholder')}
              value={identityFile}
              onChange={(event) => setIdentityFile(event.target.value)}
              data-testid="edit-identity"
            />
          </div>
        </div>
      )}

      {record.transport === 'http' && (
        <div className="field mt8">
          <label htmlFor="edit-endpoint">{t('edit.endpointLabel')}</label>
          <input
            className="input"
            id="edit-endpoint"
            value={endpointUrl}
            onChange={(event) => setEndpointUrl(event.target.value)}
            data-testid="edit-endpoint"
          />
          <span className="hint">{t('edit.endpointHint')}</span>
        </div>
      )}

      {running && <p className="hint mt8">{t('edit.restartHint')}</p>}
    </Modal>
  )
}
