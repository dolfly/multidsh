/**
 * 渲染进程 ↔ 主进程桥接面（白名单）。
 *
 * 框架无关：不 import electron，主进程 / 预加载 / 渲染进程共享同一份类型与通道名，
 * 符合全局规则 5（registry / transport / auth / shared 不依赖 electron）。
 *
 * 实例注册表相关类型与通道常量见 `./contracts.ts`；本文件只承载桥接面本身。
 */

import type { Settings } from './settings'
import type {
  AskpassPromptPayload,
  AuthSignalEvent,
  AuthStateEvent,
  AuthStateSnapshot,
  CreateInstanceInput,
  DshVersionCatalog,
  DshVersionCheck,
  DshVersionProgressEvent,
  EnvironmentRefreshResult,
  ExternalDshWebSnapshot,
  HostKeyDecision,
  HostKeyPromptPayload,
  HttpAuthDetection,
  InstanceRecord,
  InstanceStatusEvent,
  InstanceSummary,
  LocalLauncherSnapshot,
  LocalSpaceSnapshot,
  PluginInfo,
  PluginInstallOptions,
  PluginInstallPlan,
  PluginMutationResult,
  PluginPackageInfo,
  PluginRegistryOptions,
  PluginCheckSnapshot,
  PluginEnableResult,
  PluginUpdateCheck,
  VaultPolicy,
  VaultStatusSnapshot,
  IpcResult,
  PatchInstanceInput,
  RuntimeConfirmPromptPayload,
  SshHostKeyForgetInput,
  SshKeyPreviewInput,
  SshKeyPreviewResult,
  WorkspaceHotkeyEvent,
  WorkspaceTooltip,
  WorkspaceViewBounds
} from './contracts'

export const IPC = {
  /** 返回应用信息（版本 / 平台 / 数据目录），同时充当主进程存活探针 */
  info: 'app:info',
  /** 空回显，用于验证双向 IPC 通路连通 */
  ping: 'app:ping',
  /** 用系统默认浏览器打开项目主页；无参数，URL 由主进程固定 */
  openHomepage: 'app:open-homepage',
  /** 打开应用内「关于」叠加窗口；无参数，窗口由主进程构造 */
  openAbout: 'app:open-about'
} as const

export interface AppInfo {
  /** package.json 版本（app.getVersion()） */
  appVersion: string
  /** 构建期注入的 git 短 hash；无 git 时为 'unknown' */
  buildCommit: string
  /** 构建期注入的打包时刻（pnpm build 执行时间，ISO 8601）；无法注入时为 'unknown' */
  buildTime: string
  platform: string
  arch: string
  /** 渲染引擎版本（Electron 内嵌 Chromium） */
  chrome: string
  electron: string
  node: string
  /** V8 引擎版本 */
  v8: string
  /** 应用数据根目录：实例注册表 / 审计日志 / 隔离的 DSH_HOME 都在其下 */
  userDataPath: string
  /** dsh 公共空间（默认 DSH_HOME）在本机的绝对路径：`~/.dsh` 的 OS 展开形式。 */
  defaultDshHome: string
  /** 系统区域设置（OS preferred languages 首项），供渲染层解析「跟随系统」语言偏好 */
  locale: string
}

export interface PingResult {
  /** 主进程原样回显；未传参时为 null */
  echo: string | null
  /** 主进程响应时间戳（epoch ms） */
  at: number
}

export interface DshHubBridge {
  /** 主进程返回的应用信息快照 */
  getInfo: () => Promise<IpcResult<AppInfo>>
  /** 双向 IPC 探针 */
  ping: (message?: string) => Promise<IpcResult<PingResult>>
  /** 用系统默认浏览器打开项目主页（无参数，主进程固定 URL） */
  openHomepage: () => Promise<IpcResult<null>>
  /** 打开应用内「关于」叠加窗口（无参数，主进程构造窗口） */
  openAbout: () => Promise<IpcResult<null>>
  /** 已有本机隔离空间；路径只由主进程决定。 */
  spaces: {
    list: () => Promise<IpcResult<LocalSpaceSnapshot[]>>
    trash: (id: string) => Promise<IpcResult<{ trashed: boolean }>>
  }
  /** 实例注册表 CRUD；通道常量与字段模型见 contracts.ts。 */
  instances: {
    list: () => Promise<IpcResult<InstanceSummary[]>>
    get: (id: string) => Promise<IpcResult<InstanceRecord | null>>
    create: (input: CreateInstanceInput) => Promise<IpcResult<InstanceRecord>>
    update: (id: string, patch: PatchInstanceInput) => Promise<IpcResult<InstanceRecord>>
    remove: (
      id: string,
      options?: { trashSpace?: boolean }
    ) => Promise<IpcResult<{ removed: boolean }>>
    /** 按给定 ID 列表重排实例顺序；ID 必须与当前注册表完全一致。 */
    reorder: (orderedIds: string[]) => Promise<IpcResult<InstanceSummary[]>>
    /** 在系统文件管理器中打开本机实例的数据目录；仅本机实例，路径由主进程解析。 */
    openDirectory: (id: string) => Promise<IpcResult<{ opened: boolean }>>
    /** 在系统文件管理器中打开本机实例的日志目录；仅本机实例，路径由主进程解析。 */
    openLogDirectory: (id: string) => Promise<IpcResult<{ opened: boolean }>>
  }
  /** 本地实例运行时控制：start/stop 立即返回，进展经 onInstanceStatus 回推。 */
  runtime: {
    start: (id: string) => Promise<IpcResult<null>>
    stop: (id: string) => Promise<IpcResult<null>>
    /** 重启 hub 托管的本地实例：等待完全停止后重新拉起；外部接管的进程会被拒绝。 */
    restart: (id: string) => Promise<IpcResult<null>>
    openView: (id: string) => Promise<IpcResult<null>>
    /** 重新登录成功后刷新内嵌工作区：注入最新会话 Cookie 并导航回工作区 URL。未缓存视图时为空操作。 */
    reloadView: (id: string) => Promise<IpcResult<null>>
    /**
     * 在系统默认浏览器中打开实例地址。目标 URL 由主进程解析：http/https 用远程地址，
     * 本机实例带上已验证的 BrowserAuth token；token 不经渲染层。
     */
    openInBrowser: (id: string) => Promise<IpcResult<null>>
    updateViewBounds: (bounds: WorkspaceViewBounds) => Promise<IpcResult<null>>
    /** 显示位于原生工作区视图之上的只读名称提示。 */
    showTooltip: (tooltip: WorkspaceTooltip) => Promise<IpcResult<null>>
    hideTooltip: () => Promise<IpcResult<null>>
    hideView: () => Promise<IpcResult<null>>
    /** 销毁指定实例的内嵌工作区；不停止实例进程或清除登录凭据。 */
    disconnectView: (id: string) => Promise<IpcResult<null>>
    probeLocalDsh: () => Promise<IpcResult<LocalLauncherSnapshot[]>>
    /**
     * 列出本机已运行的 dsh web 进程。无参数；返回项包含 pid、监听端口和 `--patch` 路径。
     */
    scanExternal: () => Promise<IpcResult<ExternalDshWebSnapshot[]>>
    /**
     * 接管检测到的外部 dsh web。`access` 是用户提供的 token 或完整 URL，只在主进程会话内保留。
     */
    adoptExternal: (id: string, pid: number, access: string) => Promise<IpcResult<null>>
    /** 检查本实例当前 dsh 版本与最新可用版本；仅 hub 托管的 local 实例可升级。 */
    checkDshVersion: (id: string) => Promise<IpcResult<DshVersionCheck>>
    /** 升级到最新版本；立即返回，进展经 onVersionProgress 回推。 */
    upgradeDshVersion: (id: string) => Promise<IpcResult<null>>
    /** 拉取版本目录（当前镜像的全部版本 + hub 已装版本，均从新到旧）。 */
    listDshVersions: () => Promise<IpcResult<DshVersionCatalog>>
    /** 订阅运行时二次确认请求（dsh 下载 / 系统默认 dsh 全局升级）；返回取消订阅函数。 */
    onRuntimeConfirm: (listener: (payload: RuntimeConfirmPromptPayload) => void) => () => void
    /** 拉取待答确认快照；挂载时补拉，覆盖「事件早于订阅」的时序。 */
    listRuntimeConfirms: () => Promise<IpcResult<RuntimeConfirmPromptPayload[]>>
    /** 回复运行时确认；accepted=false 即取消本次动作（启动取消 / 升级不处理）。 */
    replyRuntimeConfirm: (requestId: string, accepted: boolean) => Promise<IpcResult<null>>
  }
  /** 本机实例的 dsh 插件管理：列表、检查升级、安装、升级、卸载（profile 与 DSH_HOME 由主进程推导）。 */
  plugin: {
    /** 列出实例 profile 已装插件及其元数据；locale 决定 meta 本地化语言（缺省 zh）。 */
    list: (id: string, locale?: 'zh' | 'en') => Promise<IpcResult<PluginInfo[]>>
    /** 检查某插件的最新版本与 dsh peer 兼容性。 */
    check: (id: string, name: string) => Promise<IpcResult<PluginUpdateCheck>>
    /** 读取持久化的检查状态（可升级标记 + 在飞检查），挂载时恢复。 */
    checkState: (id: string) => Promise<IpcResult<PluginCheckSnapshot>>
    /** 安装插件；spec 为 npm 名 / name@version / github: / file: 形态。 */
    install: (
      id: string,
      spec: string,
      options?: PluginInstallOptions
    ) => Promise<IpcResult<PluginMutationResult>>
    /** 安装前解析版本（npm 裸名按 registry 选出版本，不再用 dist-tag `latest` 直装）。 */
    resolveInstall: (
      id: string,
      spec: string,
      options?: PluginRegistryOptions
    ) => Promise<IpcResult<PluginInstallPlan>>
    /** 单个版本的更新内容与近 30 天下载量（确认区懒加载；取不到不算错误）。 */
    packageInfo: (
      id: string,
      name: string,
      version: string
    ) => Promise<IpcResult<PluginPackageInfo>>
    /** 升级到指定版本（显式版本，非 latest；可从所选安装源取该版本）。 */
    upgrade: (
      id: string,
      name: string,
      version: string,
      options?: PluginRegistryOptions
    ) => Promise<IpcResult<PluginMutationResult>>
    /** 卸载插件。 */
    remove: (id: string, name: string) => Promise<IpcResult<PluginMutationResult>>
    /** 启用/禁用插件（改 profile 加载清单，保留依赖；禁用后仍在列表可见）。 */
    setEnabled: (
      id: string,
      name: string,
      enabled: boolean
    ) => Promise<IpcResult<PluginEnableResult>>
    /** 在系统默认浏览器打开插件的 npm / GitHub 链接（仅 https 且经域名白名单）。 */
    openExternal: (url: string) => Promise<IpcResult<null>>
  }
  /** 订阅实例状态事件；返回取消订阅函数（渲染层不接触原始 IPC 事件对象） */
  onInstanceStatus: (listener: (event: InstanceStatusEvent) => void) => () => void
  /** 订阅 dsh 版本升级进度事件；返回取消订阅函数。 */
  onVersionProgress: (listener: (event: DshVersionProgressEvent) => void) => () => void
  /** 订阅工作区白名单快捷键转发(⌘/Ctrl 与其数字组合);返回取消订阅函数。 */
  onWorkspaceHotkey: (listener: (event: WorkspaceHotkeyEvent) => void) => () => void
  /** SSH 传输辅助：密钥预览、主机指纹确认和口令输入。 */
  ssh: {
    /** 只读密钥预览（ssh -G + ssh-add -L）；不含私钥内容 */
    keyPreview: (input: SshKeyPreviewInput) => Promise<IpcResult<SshKeyPreviewResult>>
    /** 订阅指纹确认请求（TOFU；首次/变化双变体） */
    onHostKeyDecision: (listener: (payload: HostKeyPromptPayload) => void) => () => void
    /** 回复指纹确认；decision=trust 才会写入 hub 私有 known_hosts */
    replyHostKey: (requestId: string, decision: HostKeyDecision) => Promise<IpcResult<null>>
    /**
     * 忘记该实例主机的已信任公钥；这是显式且破坏性的恢复操作。
     * 不属于连接确认流程：连接时指纹变化一律拒绝且不改动旧公钥；只有走完本动作后，
     * 下一次连接才会重新走首次 TOFU 确认。
     */
    forgetHostKey: (input: SshHostKeyForgetInput) => Promise<IpcResult<null>>
    /** 订阅口令输入请求（ssh 索要私钥口令/密码）；口令不落盘 */
    onAskpassRequest: (listener: (payload: AskpassPromptPayload) => void) => () => void
    /** 回复口令；secret=null 表示取消 */
    replyAskpass: (requestId: string, secret: string | null) => Promise<IpcResult<null>>
  }
  /** HTTP 直连辅助：端点认证模式只读探测。 */
  http: {
    /** 对草稿 URL 做只读探测；非法 URL 返回 invalid-input 信封。 */
    detect: (endpointUrl: string) => Promise<IpcResult<HttpAuthDetection>>
  }
  /** 认证状态流和登录提交；凭据只在主进程内存中流转。 */
  auth: {
    probe: (instanceId: string) => Promise<IpcResult<AuthStateSnapshot | null>>
    /** 提交密码（可同时带 OTP 完成单请求 2FA） */
    login: (
      instanceId: string,
      password: string,
      otp?: string
    ) => Promise<IpcResult<AuthStateSnapshot | null>>
    /**
     * 使用保险库中保存的密码登录。**密码不跨 IPC**——
     * 主进程自行从 vault 读取；渲染层只传可选 OTP。未勾选「记住密码」或无已存
     * 密码时返回 invalid-input。
     */
    loginStored: (instanceId: string, otp?: string) => Promise<IpcResult<AuthStateSnapshot | null>>
    logout: (instanceId: string) => Promise<IpcResult<AuthStateSnapshot | null>>
    /** 订阅状态变化；返回取消订阅函数 */
    onState: (listener: (event: AuthStateEvent) => void) => () => void
    /** 订阅 webview 拦截信号（会话失效/需要验证码/需要改密） */
    onSignal: (listener: (event: AuthSignalEvent) => void) => () => void
  }
  /** 应用设置（非敏感偏好：语言、主题、托盘、自启和通知）。 */
  settings: {
    get: () => Promise<IpcResult<Settings>>
    update: (patch: Partial<Settings>) => Promise<IpcResult<Settings>>
    /**
     * 打开应用数据目录。
     * **没有参数**:目录由主进程自行解析,渲染层无法指定路径。
     */
    openDataDir: () => Promise<IpcResult<null>>
    /**
     * 刷新环境缓存（失效并重新解析登录 PATH / shell 环境）。
     * **没有参数**；返回刷新前后的环境差异，以及正在运行、可由 hub 重启的本机实例 id，
     * 渲染层据此报告变化并提示用户是否重启这些实例。
     */
    refreshEnvironment: () => Promise<IpcResult<EnvironmentRefreshResult>>
  }
  /** 凭据保险库：默认保存密码和会话；用户可显式取消。 */
  vault: {
    status: () => Promise<IpcResult<VaultStatusSnapshot>>
    setPolicy: (instanceId: string, policy: VaultPolicy) => Promise<IpcResult<VaultPolicy>>
    /** 忘掉某实例已记住的凭据(可只忘密码/只忘会话) */
    forget: (
      instanceId: string,
      target?: { password?: boolean; session?: boolean }
    ) => Promise<IpcResult<VaultPolicy>>
    /** 一键清空全部已记住凭据 */
    clear: () => Promise<IpcResult<VaultStatusSnapshot>>
  }
}
