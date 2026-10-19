/**
 * 实例注册表、IPC 与共享契约的统一入口。
 *
 * 本模块不 import electron；主进程、preload、渲染进程和测试共享模型与 Zod schema。
 * 具体定义按领域拆在同目录的 contracts-*.ts，这里只做 re-export，对外 API 保持不变。
 */
import { z } from 'zod'
import { PLUGIN_REGISTRY_OPTIONS, type PluginRegistryOption } from './settings'
import type { AuthMode, Transport } from './contracts-instance'
import type { LocalLauncher } from './local-launch'

export * from './contracts-instance'
export * from './contracts-ssh'
export * from './contracts-auth'
export { HOMEPAGE_URL, splitSshHostPort, type SshHostPortSplit } from './contracts-util'

// ===== HTTP 直连端点探测 =====

/**
 * 向导和详情页对「直连端点」做一次只读探测，
 * 返回认证模式判定结果供 UI 展示；不建立实例、不写注册表、不携带凭据。
 */
export const HTTP_IPC = {
  detect: 'http:detect'
} as const

export type DetectedAuthMode = 'gateway' | 'none' | 'browser-auth' | 'unreachable' | 'unknown'

export type GatewayEvidence = 'login-page' | 'api-401' | 'onboarding' | 'otp-page'

export interface HttpAuthDetection {
  mode: DetectedAuthMode
  gatewayEvidence: GatewayEvidence | null
  /** 面向用户/日志的一句话证据（不含凭据） */
  evidence: string
  /** 观测状态码（网络错误为 null） */
  status: number | null
  at: string
}

// ===== 列表视图 / IPC =====

export interface InstanceSummary {
  id: string
  name: string
  transport: Transport
  /** 本地实例是否复用用户的 ~/.dsh；仅在 local 时有意义。 */
  useDefaultSpace?: boolean
  /** 本机实例的数据目录（展示用，主进程按平台分隔符拼好）；仅在 local 时存在。 */
  localHome?: string
  authMode: AuthMode
  /** 展示用地址一次算好(避免渲染层为每行再发 get) */
  address: string
  /** 列表快照携带主进程已知的当前运行态，避免 renderer 重载后退回灰色 idle。 */
  runtimeStatus?: InstanceRuntimeStatus
  /**
   * 展示用 dsh 版本：运行中取主进程实时状态的版本，否则回落到本机实例注册表已固定的
   * `dshVersion`；用于 renderer 重载后版本不退回 `—`（'custom' 占位与空值不携带）。
   */
  version?: string
  updatedAt: string
}

/** 实例注册表 CRUD + 排序通道。 */
export const SPACE_IPC = {
  list: 'spaces:list',
  trash: 'spaces:trash'
} as const

export interface LocalSpaceSnapshot {
  id: string
  sizeBytes: number
  modifiedAt: string
  /** 关联的本地实例名称；未关联时为 null。 */
  instanceName: string | null
  /** 是否已被注册表中的本地实例占用。 */
  inUse: boolean
}

export const INSTANCE_IPC = {
  list: 'instances:list',
  get: 'instances:get',
  create: 'instances:create',
  update: 'instances:update',
  delete: 'instances:delete',
  /** 按给定 ID 列表重排实例顺序；ID 必须与当前注册表完全一致。 */
  reorder: 'instances:reorder',
  /** 在系统文件管理器中打开本机实例的数据目录（DSH_HOME）；路径由主进程按实例解析。 */
  openDirectory: 'instances:openDirectory',
  /** 在系统文件管理器中打开本机实例的日志目录；路径由主进程按实例解析。 */
  openLogDirectory: 'instances:openLogDirectory'
} as const

/** 本地运行时控制通道：start/stop 立即返回，进展由 `instance:status` 事件回推。 */
export const INSTANCE_RUNTIME_IPC = {
  start: 'instances:start',
  stop: 'instances:stop',
  /** 重启 hub 托管的本地 dsh 进程：先完全停止再按注册表配置重新拉起。 */
  restart: 'instances:restart',
  openView: 'instances:openView',
  /** 重新登录成功后刷新内嵌工作区：注入最新会话 Cookie 并导航回工作区 URL，取代会话失效前的旧页面。 */
  reloadView: 'instances:reloadView',
  /** 在系统默认浏览器中打开实例地址；URL 由主进程解析，本机实例的 token 不经渲染层。 */
  openInBrowser: 'instances:openInBrowser',
  updateViewBounds: 'instances:updateViewBounds',
  showTooltip: 'instances:showTooltip',
  hideTooltip: 'instances:hideTooltip',
  hideView: 'instances:hideView',
  /** 断开当前实例的内嵌工作区，只销毁 WebContentsView，不停止运行时或清除凭据。 */
  disconnectView: 'instances:disconnectView',
  /** 只读探测本机 dsh/dush/duush 启动器及版本，用于创建本机实例时的选择器。 */
  probeLocalDsh: 'instances:probeLocalDsh',
  /** 探测本机已运行的 dsh web 进程；返回 pid、端口和 patch 路径。 */
  scanExternal: 'instances:scanExternal',
  /** 接管外部 dsh 时提交 token 或完整 URL；主进程重新扫描 PID 并验证回环端口。 */
  adoptExternal: 'instances:adoptExternal'
} as const

/** dsh 版本管理通道：check 立即返回，upgrade 异步执行并经进度事件回推。 */
export const DSH_VERSION_IPC = {
  /** 检查本实例当前 dsh 版本与最新可用版本。 */
  check: 'dsh-version:check',
  /** 升级到最新版本；立即返回，进展由 `dsh:version-progress` 事件回推。 */
  upgrade: 'dsh-version:upgrade',
  /** 拉取版本目录（新建实例的版本下拉数据源）。 */
  list: 'dsh-version:list',
  /** 运行时二次确认请求（主→渲染）：dsh 下载、系统默认 dsh 全局升级。 */
  confirmRequest: 'dsh-version:confirmRequest',
  /** 回复运行时确认（渲染→主）；accepted=false 即取消本次动作。 */
  confirmReply: 'dsh-version:confirmReply',
  /** 拉取待答确认快照：渲染层挂载时补拉，覆盖「事件早于订阅」的时序。 */
  confirmList: 'dsh-version:confirmList'
} as const

/**
 * 运行时二次确认请求（主→渲染）：需要用户拍板的破坏性/耗流量动作。
 * - `dsh-download`：hub 与 PATH 都没有可用 dsh，需下载后才能启动；`registry` 为
 *   生效镜像地址（空串 = 跟随系统 npm 配置），对话框必须展示下载来源；
 * - `system-dsh-upgrade`：公共空间实例升级系统默认 dsh，全局生效。
 */
export type RuntimeConfirmPromptPayload =
  | { requestId: string; kind: 'dsh-download'; version: string; registry: string }
  | { requestId: string; kind: 'system-dsh-upgrade'; latest: string; current: string }

/** 逐分支去掉 requestId（Omit 会把联合压成公共字段，不能直接用在联合上）。 */
type StripRequestId<T> = T extends { requestId: string } ? Omit<T, 'requestId'> : never
/** 待发送的确认请求：requestId 由 prompt broker 补发。 */
export type RuntimeConfirmRequest = StripRequestId<RuntimeConfirmPromptPayload>

/** dsh 版本目录（新建实例的版本下拉数据源）。 */
export interface DshVersionCatalog {
  /** 当前镜像 registry 上的全部可用版本，从新到旧。 */
  versions: string[]
  /** hub 已安装的运行时版本，从新到旧。 */
  installed: string[]
}

/** dsh 版本检查结果。 */
export interface DshVersionCheck {
  /** 当前实例使用的 dsh 版本（状态事件优先，其次注册表）；来源未知时为 null。 */
  current: string | null
  /** npm registry 上的最新可用版本（按版本比较取最大，含 rc/alpha 等预发布渠道）。 */
  latest: string
  /** 是否有可用更新；当前版本未知时按可升级即视为有更新。 */
  hasUpdate: boolean
  /** 是否允许执行升级；false 时 reason 给出原因。 */
  canUpgrade: boolean
  /**
   * 不可升级的原因代码：`runtime-external` = 外部接管的进程归用户所有；
   * `global-unmanaged` = 公共空间实例的系统默认 dsh 缺失或非 npm 全局安装，hub 无法代管。
   */
  reason?: 'not-local' | 'runtime-external' | 'global-unmanaged'
}

/** dsh 版本升级进度阶段。 */
export type DshVersionPhase = 'checking' | 'downloading' | 'installing' | 'done' | 'error'

/** dsh 版本升级进度事件载荷。 */
export interface DshVersionProgressEvent {
  instanceId: string
  phase: DshVersionPhase
  /** 当前阶段的补充说明（如 npm 下载的包路径与已下载包数）。 */
  detail?: string
  /** 目标版本；downloading 及之后的阶段携带。 */
  version?: string
  /** error 阶段的失败原因。 */
  error?: string
  /** 事件产生时间（ISO 8601）。 */
  at: string
}

/** 主进程 → 渲染进程的 dsh 版本升级进度事件。 */
export const DSH_VERSION_PROGRESS_EVENT = 'dsh:version-progress'

/** dsh 插件管理通道（仅本机实例；profile 与 DSH_HOME 由主进程按实例推导）。 */
export const PLUGIN_IPC = {
  /** 列出实例 profile 已装插件及其本地元数据。 */
  list: 'plugin:list',
  /** 检查某插件的最新版本与 dsh peer 兼容性（联网 view）。 */
  check: 'plugin:check',
  /** 读取持久化的检查状态（可升级标记 + 在飞检查），渲染层挂载时恢复。 */
  checkState: 'plugin:checkState',
  /** 安装插件；spec 为 npm 名 / name@version / github: / file: 形态。 */
  install: 'plugin:install',
  /**
   * 安装前解析版本：npm 裸名按 registry 选出版本（不再用 dist-tag `latest` 直装），
   * 返回确认区所需的版本、来源、发布时间与 dsh 兼容信息。
   */
  resolveInstall: 'plugin:resolveInstall',
  /** 单个版本的更新内容与近 30 天下载量（安装确认与升级确认共用，懒加载）。 */
  packageInfo: 'plugin:packageInfo',
  /** 升级到指定版本（显式版本，非 latest；可从所选安装源取该版本）。 */
  upgrade: 'plugin:upgrade',
  /** 卸载插件。 */
  remove: 'plugin:remove',
  /** 启用/禁用插件（改 profile 加载清单，保留依赖）。 */
  setEnabled: 'plugin:setEnabled',
  /** 在系统默认浏览器打开插件的 npm / GitHub 链接（仅 https 且经域名白名单）。 */
  openExternal: 'plugin:openExternal'
} as const

/**
 * 插件安装 spec 校验：npm 包名（scoped/unscoped，可带 @version）、`github:owner/repo`
 * （可带 #ref）、`git+https://…`、`file:` 本地路径。长度封顶，拒绝空白与命令注入面。
 */
export const PLUGIN_SPEC_SCHEMA = z
  .string()
  .trim()
  .min(1, '插件标识不能为空')
  .max(512, '插件标识过长')
  .refine((value) => {
    if (/[\s;&|`$<>]/.test(value)) return false
    if (/^(github:|git\+https:\/\/|file:)/.test(value)) return true
    // npm 包名（可选 scope）+ 可选 @version。
    return /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.+-]+)?$/i.test(value)
  }, '插件标识形态非法（仅支持 npm 名 / name@version / github: / file:）')

/** dsh 插件名校验（scoped / unscoped npm 包名，不含版本）。 */
export const PLUGIN_NAME_SCHEMA = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i, '插件名形态非法')

/** 插件安装源档位校验（枚举；非法取值在 IPC 边界被拒，不会落到命令参数）。 */
export const PLUGIN_REGISTRY_SCHEMA = z.enum(PLUGIN_REGISTRY_OPTIONS)

/**
 * 解析与安装的可选参数：
 * - `enable`：安装后是否启用（缺省 true，与既有行为一致）；
 * - `registry`：安装源档位（缺省 npmmirror，由主进程映射为 URL）。
 */
export const PLUGIN_INSTALL_OPTIONS_SCHEMA = z.object({
  enable: z.boolean().optional(),
  registry: PLUGIN_REGISTRY_SCHEMA.optional()
})

export type PluginInstallOptions = z.infer<typeof PLUGIN_INSTALL_OPTIONS_SCHEMA>

/**
 * 只带安装源档位的可选参数：解析安装版本与升级都用它。
 * 档位是枚举，URL 只在主进程映射（缺省 npmmirror）。
 */
export const PLUGIN_REGISTRY_OPTIONS_SCHEMA = z.object({
  registry: PLUGIN_REGISTRY_SCHEMA.optional()
})

export type PluginRegistryOptions = z.infer<typeof PLUGIN_REGISTRY_OPTIONS_SCHEMA>

/** 安装 spec 的种类；github/file 不联网解析版本，只展示来源。 */
export type PluginInstallKind = 'npm' | 'github' | 'file'

/** 目标版本的来源：用户显式指定 / 主进程按 registry 解析出的最新版 / 无版本（github、file）。 */
export type PluginVersionSource = 'requested' | 'resolved-latest' | 'none'

/**
 * 安装前解析出的计划：确认区据此渲染，安装时回传 `installSpec`。
 * 「用户看到什么就装什么」——installSpec 是所确认的对象，后续 registry 发新版不改变本次选择。
 */
export interface PluginInstallPlan {
  /** 实际交给安装的 spec：npm 恒为 `name@x.y.z`，github/file 原样。 */
  installSpec: string
  /** 用户输入（trim 后）；渲染层用它作废过期结果。 */
  input: string
  kind: PluginInstallKind
  /** npm 包名；github/file 为 null。 */
  packageName: string | null
  /** 目标版本；github/file 为 null。 */
  targetVersion: string | null
  /** registry 的 dist-tags.latest，仅作对照展示；取不到为 null。 */
  latestVersion: string | null
  versionSource: PluginVersionSource
  /** 目标版本发布时间（ISO）；取不到为 null。 */
  publishedAt: string | null
  /** 目标版本的 dsh 兼容范围（展示用）；未声明为 null。 */
  dshPeer: string | null
  /** 实际执行命令的 dsh 版本；未知为 null。 */
  dshVersion: string | null
  /** null = 无法判定（github/file 或 dsh 版本未知），界面不强制风险勾选。 */
  compatible: boolean | null
  /** 已装同名版本；未装为 null。 */
  installedVersion: string | null
}

/** npm 官方口径的最近 30 天下载量。 */
export interface PluginDownloads {
  count: number
  /** 统计区间起止（YYYY-MM-DD，含端点，与 npm 接口同形）。 */
  start: string
  end: string
}

/** 某个版本的更新内容。 */
export interface PluginReleaseNotes {
  /** 正文（纯文本）；null = 未找到。 */
  text: string | null
  source: 'github-release' | 'changelog' | 'none'
  /** 「打开发布页」目标；取不到仓库时为 null。 */
  pageUrl: string | null
  /** 正文超过上限被截断。 */
  truncated: boolean
}

/** 安装/升级确认区用的增强信息（更新内容 + 下载量）；取不到不算错误。 */
export interface PluginPackageInfo {
  /** 非 npm 来源或接口失败时为 null，界面显示占位符。 */
  downloads: PluginDownloads | null
  releaseNotes: PluginReleaseNotes
}

/** 插件安装源档位（对外再导出，渲染层只依赖契约）。 */
export type { PluginRegistryOption }

/** 解析出的已装插件信息（渲染层展示用；图标以 data-uri 内联）。 */
export interface PluginInfo {
  name: string
  version: string
  /** 本地化标题（locale/<lang>.json 的 meta.title）；null 时渲染层回落包名。 */
  title: string | null
  description: string | null
  author: string | null
  license: string | null
  npmUrl: string | null
  githubUrl: string | null
  iconDataUri: string | null
  /** 第三方运行时依赖名（不含 peer）。 */
  dependencies: string[]
  /**
   * 展示用的 dsh 兼容范围：主包 `@deepseek-ai/dsh` 已声明则取其范围，否则取各
   * `@deepseek-ai/dsh-*` 子包的（锁步）公共范围；null = 未声明任何 dsh peer。
   */
  dshPeer: string | null
  /** `engines.node` 范围；null = 未声明。 */
  nodeEngine: string | null
  /** 含 host 半（改动后需重启实例）。 */
  hasHostSide: boolean
  /** 含 client 半（改动后刷新页面即可）。 */
  hasClientSide: boolean
  /** 安装来源。 */
  installSource: 'npm' | 'github' | 'file' | 'unknown'
  /**
   * 是否在 profile 加载清单（`dsh.profile.bundles`）里。
   * null = 该插件不由清单控制（无 host 半，随宿主 bundle 加载），无法单独禁用。
   */
  enabled: boolean | null
  /**
   * 已装版本的发布时间（ISO），来自检查时落盘的版本快照。
   * null = 尚无该版本的快照（未检查过，或 registry 未收录该版本）。
   */
  publishedAt: string | null
}

/** 插件检查升级结果。 */
export interface PluginUpdateCheck {
  name: string
  current: string
  latest: string
  hasUpdate: boolean
  /** latest 的 dsh peer 是否满足实例实际运行的 dsh 版本（与安装闸同口径）。 */
  compatible: boolean
  /**
   * 展示用的 dsh 兼容范围：主包优先，否则取各 `@deepseek-ai/dsh-*` 子包的公共范围；
   * null = latest 未声明任何 dsh peer。兼容性判定仍覆盖全部子包，不止该展示值。
   */
  dshPeer: string | null
  /** 执行插件命令所用 dsh 的版本；null = 未知（无法判定兼容，一律置 compatible=false）。 */
  dshVersion: string | null
  /**
   * 已装版本（current）的发布时间（ISO），随检查结果一起返回。
   * null = registry 未收录该版本（本地 file: / GitHub 安装等）。
   */
  publishedAt: string | null
}

/**
 * 插件改动结果。
 *
 * `application` 与 dsh 自身的 ChangeResult.application 同口径（dsh plugin CLI 不返回该字段，
 * 由 hub 按同一规则推断）：
 * - `applied`：已热生效，无需重启（仅 HMR 可用的 profile，如 web）；
 * - `restart-required`：已保存但未激活，需重启 Host（仅 profile 无 HMR 时——
 *   替换/升级已装包同样热生效，dsh-hmr 按磁盘身份换模块代，无「已装包必须重启」特例）。
 */
export interface PluginMutationResult {
  hasHostSide: boolean
  application: 'applied' | 'restart-required'
}

/** 插件启用/禁用结果。 */
export interface PluginEnableResult {
  name: string
  enabled: boolean
  /** 与 dsh 的 ChangeResult.application 同口径（见 PluginMutationResult）。 */
  application: 'applied' | 'restart-required'
  /**
   * 启用时因插件与运行时 dsh 不兼容而授予的精确版本豁免（allow-version --accept-risk）：
   * 该「插件@版本」被允许运行在 dshVersion 上；null = 未授予（兼容 / 本次为禁用）。
   */
  exemptionGranted: { pluginVersion: string; dshVersion: string } | null
}

/**
 * 单个插件持久化的检查结果。
 *
 * `current` 记录本次检查时的已装版本：结果只对该版本有效，版本一旦变化
 * （hub 升级、手动安装/降级）即失效，渲染层据此丢弃陈旧记录，避免拿旧版本的
 * 候选信息当成本次结果（如已装 1.1.17 仍提示升级 1.1.15）。
 */
export interface PluginCheckRecord {
  /** 本次检查时的已装版本。 */
  current: string
  latest: string
  compatible: boolean
  dshPeer: string | null
  dshVersion: string | null
}

/**
 * 插件检查状态快照：渲染层挂载时恢复「可升级标记」与「检查中…」。
 * 检查在后台跑到结束（切换界面不中止），持久化让标记跨页面与跨重启保留。
 */
export interface PluginCheckSnapshot {
  /** 上次完成检查的时刻（ISO）；null = 尚未检查过。 */
  lastCheckedAt: string | null
  updates: Record<string, PluginCheckRecord>
  /** 正在检查中的插件名。 */
  checking: string[]
  /** 最近一次「dsh 版本变更后核对」中被自动禁用的插件（供界面提示）。 */
  autoDisabled: PluginAutoDisabled[]
}

/** 因与运行时 dsh 不兼容而被自动禁用的插件。 */
export interface PluginAutoDisabled {
  name: string
  /** 被禁用时的插件版本。 */
  version: string
  /** 判定不兼容时的 dsh 版本。 */
  dshVersion: string
}

export const WorkspaceViewBoundsSchema = z
  .object({
    x: z.number().int().min(0).max(10_000),
    y: z.number().int().min(0).max(10_000),
    width: z.number().int().min(0).max(20_000),
    height: z.number().int().min(0).max(20_000)
  })
  .strict()

export type WorkspaceViewBounds = z.infer<typeof WorkspaceViewBoundsSchema>

/** 收起侧栏的实例名称提示锚点（相对 Hub content view 的坐标）。 */
export const WorkspaceTooltipSchema = z
  .object({
    text: z.string().trim().min(1).max(200),
    x: z.number().int().min(0).max(20_000),
    y: z.number().int().min(0).max(20_000)
  })
  .strict()

export type WorkspaceTooltip = z.infer<typeof WorkspaceTooltipSchema>

/**
 * 原生工作区转发给 hub 渲染层的按键事件。
 * 只含会话切换所需的白名单输入:切换修饰键本身(macOS 为 ⌘/Meta,其余平台为 Alt)
 * 与按住它时的数字键 1-9;其余输入不转发,由工作区页面自行处理。
 */
export interface WorkspaceHotkeyEvent {
  phase: 'down' | 'up'
  /** 按下的键名:Meta / Alt 或数字键 */
  key: string
  /** 物理键位(MetaLeft / AltLeft / Digit1 等) */
  code: string
  /** 该瞬间 ⌘ 是否按住 */
  meta: boolean
  /** 该瞬间 Ctrl 是否按住 */
  ctrl: boolean
  /** 该瞬间 Alt 是否按住 */
  alt: boolean
}

/** 主进程 → 渲染进程的工作区快捷键白名单转发事件。 */
export const WORKSPACE_HOTKEY_EVENT = 'dsh:workspace-hotkey'

export interface LocalLauncherSnapshot {
  launcher: LocalLauncher
  version: string
}

/** 本机已在运行的 dsh web(只读探测结果,供 UI 展示与「接管」) */
export interface ExternalDshWebSnapshot {
  pid: number
  /** 监听端口;null = 未能确定(无 --port 且 lsof 未给出) */
  port: number | null
  /** `--patch <file>` 取值(dush 形态);null = 未使用 patch */
  patch: string | null
  /** 原始命令行(已截断,仅供展示) */
  command: string
}

/** 主进程 → 渲染进程的状态推送通道（状态机推进的唯一来源） */
export const INSTANCE_STATUS_EVENT = 'instance:status'

export type InstanceRuntimeStatus = 'stopped' | 'starting' | 'installing' | 'running' | 'error'

export interface InstanceStatusEvent {
  id: string
  status: InstanceRuntimeStatus
  /** 工作区 URL；本地 BrowserAuth bearer URL 仅留在主进程，不会出现在此状态事件。 */
  url?: string
  /** 实际监听端口（以 dsh 打印的就绪 URL 为准，可能与预分配端口不同） */
  port?: number
  /** 本次启动使用的 dsh 运行时版本（解析后回填，供 UI 展示与注册表回写） */
  version?: string
  /** 本次启动的实际命令行（主进程 spawn 的命令与参数，供详情页展示与复制） */
  command?: string
  /** 运行时来源：hub 为应用隔离目录，path 为用户 PATH，external 为接管的本机进程。 */
  runtimeSource?: 'hub' | 'path' | 'external'
  /** 人读诊断信息（进度 / 失败归因） */
  detail?: string
  /** 事件时间（ISO） */
  at: string
}

export type IpcErrorCode = 'invalid-input' | 'not-found' | 'invalid-state' | 'io-error' | 'internal'

/**
 * IPC 统一响应信封：`code` 稳定可用于分支判断；`message` 是主进程文案，
 * 渲染层直接展示原文——主进程文案就是用户可见文本的单一来源，渲染层不按码表二次翻译。
 */
export type IpcResult<T> =
  { ok: true; value: T } | { ok: false; code: IpcErrorCode; message: string }

/** 把 zod 校验问题折叠成一条封顶的纯文本（供 IPC 错误信封使用） */
export function formatZodIssues(error: z.ZodError, cap = 300): string {
  const parts = error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
  )
  const joined = parts.join('; ')
  return joined.length > cap ? `${joined.slice(0, cap)}…` : joined
}
