import { contextBridge, ipcRenderer } from 'electron'
import type { Settings } from '@shared/settings'
import {
  IPC,
  type AppInfo,
  type AppUpdateCheck,
  type DshHubBridge,
  type PingResult
} from '@shared/bridge'
import {
  AUTH_IPC,
  INSTANCE_IPC,
  INSTANCE_RUNTIME_IPC,
  SPACE_IPC,
  HTTP_IPC,
  INSTANCE_STATUS_EVENT,
  DSH_VERSION_IPC,
  DSH_VERSION_PROGRESS_EVENT,
  PLUGIN_IPC,
  WORKSPACE_HOTKEY_EVENT,
  SETTINGS_IPC,
  SSH_IPC,
  VAULT_IPC,
  type AuthStateSnapshot,
  type EnvironmentRefreshResult,
  type HostKeyDecision,
  type HttpAuthDetection,
  type RuntimeConfirmPromptPayload,
  type IpcResult,
  type PluginRegistryOption,
  type SshHostKeyForgetInput,
  type SshKeyPreviewInput,
  type SshKeyPreviewResult,
  type VaultPolicy,
  type VaultStatusSnapshot,
  type WorkspaceTooltip
} from '@shared/contracts'

/**
 * 订阅主进程事件，返回取消订阅函数。
 * 只把载荷转给渲染层，不透传 IpcRendererEvent（其中含 sender 等能力对象）。
 */
const subscribe = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
  const handler = (_event: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/**
 * 白名单桥接：只暴露本文件内显式列出的方法，通道名一律走共享常量，
 * 避免主进程与渲染进程拼错字符串。
 */
const bridge: DshHubBridge = {
  getInfo: () => ipcRenderer.invoke(IPC.info) as Promise<IpcResult<AppInfo>>,
  ping: (message?: string) =>
    ipcRenderer.invoke(IPC.ping, message ?? null) as Promise<IpcResult<PingResult>>,
  // 无参数:目标地址由主进程固定为项目主页,渲染层传不了 URL
  openHomepage: () => ipcRenderer.invoke(IPC.openHomepage) as Promise<IpcResult<null>>,
  // 无参数:关于窗口由主进程构造，渲染层只触发打开动作
  openAbout: () => ipcRenderer.invoke(IPC.openAbout) as Promise<IpcResult<null>>,
  // 无参数:版本由主进程取自身，仓库地址由主进程按 HOMEPAGE_URL 解析
  checkUpdate: () => ipcRenderer.invoke(IPC.checkUpdate) as Promise<IpcResult<AppUpdateCheck>>,
  // 发布说明里的外链:主进程按协议白名单判定后交给系统默认程序
  openExternalLink: (url: string) =>
    ipcRenderer.invoke(IPC.openExternalLink, url) as Promise<IpcResult<null>>,
  spaces: {
    list: () => ipcRenderer.invoke(SPACE_IPC.list),
    trash: (id) => ipcRenderer.invoke(SPACE_IPC.trash, id)
  },
  instances: {
    list: () => ipcRenderer.invoke(INSTANCE_IPC.list),
    get: (id) => ipcRenderer.invoke(INSTANCE_IPC.get, id),
    create: (input) => ipcRenderer.invoke(INSTANCE_IPC.create, input),
    update: (id, patch) => ipcRenderer.invoke(INSTANCE_IPC.update, id, patch),
    remove: (id, options) => ipcRenderer.invoke(INSTANCE_IPC.delete, id, options ?? {}),
    reorder: (orderedIds) => ipcRenderer.invoke(INSTANCE_IPC.reorder, orderedIds),
    openDirectory: (id) => ipcRenderer.invoke(INSTANCE_IPC.openDirectory, id),
    openLogDirectory: (id) => ipcRenderer.invoke(INSTANCE_IPC.openLogDirectory, id)
  },
  runtime: {
    start: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.start, id),
    stop: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.stop, id),
    restart: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.restart, id),
    openView: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.openView, id),
    reloadView: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.reloadView, id),
    openInBrowser: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.openInBrowser, id),
    updateViewBounds: (bounds) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.updateViewBounds, bounds),
    showTooltip: (tooltip: WorkspaceTooltip) =>
      ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.showTooltip, tooltip),
    hideTooltip: () => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.hideTooltip),
    hideView: () => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.hideView),
    disconnectView: (id) => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.disconnectView, id),
    probeLocalDsh: () => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.probeLocalDsh),
    // 扫描不接收渲染层指定的目标；接管只接收 pid，主进程重新确认端口和 patch。
    scanExternal: () => ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.scanExternal),
    adoptExternal: (id: string, pid: number, access: string) =>
      ipcRenderer.invoke(INSTANCE_RUNTIME_IPC.adoptExternal, id, pid, access),
    checkDshVersion: (id: string) => ipcRenderer.invoke(DSH_VERSION_IPC.check, id),
    upgradeDshVersion: (id: string) => ipcRenderer.invoke(DSH_VERSION_IPC.upgrade, id),
    listDshVersions: () => ipcRenderer.invoke(DSH_VERSION_IPC.list),
    onRuntimeConfirm: (listener) => subscribe(DSH_VERSION_IPC.confirmRequest, listener),
    listRuntimeConfirms: () =>
      ipcRenderer.invoke(DSH_VERSION_IPC.confirmList) as Promise<
        IpcResult<RuntimeConfirmPromptPayload[]>
      >,
    replyRuntimeConfirm: (requestId: string, accepted: boolean) =>
      ipcRenderer.invoke(DSH_VERSION_IPC.confirmReply, requestId, accepted)
  },
  plugin: {
    list: (id: string, locale?: 'zh' | 'en') =>
      ipcRenderer.invoke(PLUGIN_IPC.list, id, locale ?? 'zh'),
    check: (id: string, name: string) => ipcRenderer.invoke(PLUGIN_IPC.check, id, name),
    checkState: (id: string) => ipcRenderer.invoke(PLUGIN_IPC.checkState, id),
    install: (
      id: string,
      spec: string,
      options?: { enable?: boolean; registry?: PluginRegistryOption }
    ) => ipcRenderer.invoke(PLUGIN_IPC.install, id, spec, options),
    resolveInstall: (id: string, spec: string, options?: { registry?: PluginRegistryOption }) =>
      ipcRenderer.invoke(PLUGIN_IPC.resolveInstall, id, spec, options),
    packageInfo: (id: string, name: string, version: string) =>
      ipcRenderer.invoke(PLUGIN_IPC.packageInfo, id, name, version),
    upgrade: (
      id: string,
      name: string,
      version: string,
      options?: { registry?: PluginRegistryOption }
    ) => ipcRenderer.invoke(PLUGIN_IPC.upgrade, id, name, version, options),
    remove: (id: string, name: string) => ipcRenderer.invoke(PLUGIN_IPC.remove, id, name),
    setEnabled: (id: string, name: string, enabled: boolean) =>
      ipcRenderer.invoke(PLUGIN_IPC.setEnabled, id, name, enabled),
    openExternal: (url: string) => ipcRenderer.invoke(PLUGIN_IPC.openExternal, url)
  },
  onInstanceStatus: (listener) => subscribe(INSTANCE_STATUS_EVENT, listener),
  onVersionProgress: (listener) => subscribe(DSH_VERSION_PROGRESS_EVENT, listener),
  onWorkspaceHotkey: (listener) => subscribe(WORKSPACE_HOTKEY_EVENT, listener),
  ssh: {
    keyPreview: (input: SshKeyPreviewInput) =>
      ipcRenderer.invoke(SSH_IPC.keyPreview, input) as Promise<IpcResult<SshKeyPreviewResult>>,
    onHostKeyDecision: (listener) => subscribe(SSH_IPC.hostKeyDecision, listener),
    replyHostKey: (requestId: string, decision: HostKeyDecision) =>
      ipcRenderer.invoke(SSH_IPC.hostKeyReply, requestId, decision),
    // 显式恢复动作：删除本机保存的主机指纹，下次连接重新执行 TOFU。
    forgetHostKey: (input: SshHostKeyForgetInput) =>
      ipcRenderer.invoke(SSH_IPC.hostKeyForget, input) as Promise<IpcResult<null>>,
    onAskpassRequest: (listener) => subscribe(SSH_IPC.askpassRequest, listener),
    replyAskpass: (requestId: string, secret: string | null) =>
      ipcRenderer.invoke(SSH_IPC.askpassReply, requestId, secret)
  },
  http: {
    detect: (endpointUrl: string) =>
      ipcRenderer.invoke(HTTP_IPC.detect, endpointUrl) as Promise<IpcResult<HttpAuthDetection>>
  },
  auth: {
    probe: (instanceId: string) =>
      ipcRenderer.invoke(AUTH_IPC.probe, instanceId) as Promise<
        IpcResult<AuthStateSnapshot | null>
      >,
    login: (instanceId: string, password: string, otp?: string) =>
      ipcRenderer.invoke(AUTH_IPC.login, instanceId, password, otp ?? null) as Promise<
        IpcResult<AuthStateSnapshot | null>
      >,
    // 密码不跨 IPC；只传实例 ID 和可选 OTP，由主进程读取已保存的密码。
    loginStored: (instanceId: string, otp?: string) =>
      ipcRenderer.invoke(AUTH_IPC.loginStored, instanceId, otp ?? null) as Promise<
        IpcResult<AuthStateSnapshot | null>
      >,
    logout: (instanceId: string) =>
      ipcRenderer.invoke(AUTH_IPC.logout, instanceId) as Promise<
        IpcResult<AuthStateSnapshot | null>
      >,
    onState: (listener) => subscribe(AUTH_IPC.state, listener),
    onSignal: (listener) => subscribe(AUTH_IPC.signal, listener)
  },
  // 非敏感应用偏好：语言、主题、托盘、自启和通知。
  settings: {
    get: () => ipcRenderer.invoke(SETTINGS_IPC.get) as Promise<IpcResult<Settings>>,
    update: (patch) =>
      ipcRenderer.invoke(SETTINGS_IPC.update, patch) as Promise<IpcResult<Settings>>,
    // 打开数据目录:白名单里**不带任何参数**(路径由主进程解析),渲染层传不了路径
    openDataDir: () => ipcRenderer.invoke(SETTINGS_IPC.openDataDir) as Promise<IpcResult<null>>,
    // 刷新环境缓存:同样**不带参数**;返回环境差异 + 可重启的本机实例 id
    refreshEnvironment: () =>
      ipcRenderer.invoke(SETTINGS_IPC.refreshEnvironment) as Promise<
        IpcResult<EnvironmentRefreshResult>
      >
  },
  // 只暴露状态和管理操作，不提供读取凭据的通道；凭据仅在主进程内使用。
  vault: {
    status: () => ipcRenderer.invoke(VAULT_IPC.status) as Promise<IpcResult<VaultStatusSnapshot>>,
    setPolicy: (instanceId, policy) =>
      ipcRenderer.invoke(VAULT_IPC.setPolicy, instanceId, policy) as Promise<
        IpcResult<VaultPolicy>
      >,
    forget: (instanceId, target) =>
      ipcRenderer.invoke(VAULT_IPC.forget, instanceId, target ?? null) as Promise<
        IpcResult<VaultPolicy>
      >,
    clear: () => ipcRenderer.invoke(VAULT_IPC.clear) as Promise<IpcResult<VaultStatusSnapshot>>
  }
}

contextBridge.exposeInMainWorld('dshHub', bridge)
