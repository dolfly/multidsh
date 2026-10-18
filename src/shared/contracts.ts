/**
 * Instance registry types and validation rules.
 *
 * 本模块不 import electron；主进程、preload、渲染进程和测试共享模型与 Zod schema。
 * `transport` 是判别联合的判别字段。
 */
import { z } from 'zod'
import { tryParseEndpoint } from './endpoint'
import { LAUNCHERS, type LocalLauncher } from './local-launch'
import { PLUGIN_REGISTRY_OPTIONS, type PluginRegistryOption } from './settings'

// ===== 枚举 =====

export const TRANSPORTS = ['local', 'ssh', 'http'] as const
export type Transport = (typeof TRANSPORTS)[number]

/**
 * 用户显式选择的认证意图；`auto` 为默认 —— 连接建立后由认证层探测决定有效模式
 * （none / gateway / browser-auth）。browser-auth 只可能是探测产物，
 * 不存在于注册表记录中。
 */
export const AUTH_MODES = ['auto', 'none', 'gateway'] as const
export type AuthMode = (typeof AUTH_MODES)[number]

// ===== 基础字段 =====

const PORT_SCHEMA = z.number('端口必须是数字').int('端口必须是整数').min(1, '端口最小 1').max(65535, '端口最大 65535')

/**
 * SSH 主机合法性：
 * - 普通主机名 / 别名 / IPv4：不含冒号即可；
 * - 裸 IPv6：至少两个冒号且全为十六进制字符；
 * - `host[:port]` / `[v6][:port]`：端口必须落在 1–65535（非法端口组合显式拒绝，
 *   而不是把整串存进 host 字段）。
 */
const SSH_PORT_PATTERN = /^(\d+)$/

function parseSshPort(rawPort: string): number | null {
  if (!SSH_PORT_PATTERN.test(rawPort)) return null
  return inPortRange(rawPort) ? Number(rawPort) : null
}

/**
 * SSH host 语法的单一真源：校验（isValidSshHost）与拆分（splitSshHostPort）共用同一组正则，
 * 两者不会再各自维护而漂移。
 * - `PLAIN_HOST_PORT`：`host:port`（主机名/别名/IPv4 + 十进制端口）。
 * - `BRACKET_HOST_PORT`：`[v6]:port`（方括号 IPv6 + 端口）。
 * - `BRACKET_HOST`：`[v6]`（方括号 IPv6，无端口）。方括号内只允许十六进制/冒号/点分尾，
 *   非 IPv6 字面量（如 `[-flist]`）不匹配 → 被 isValidSshHost 拒绝，堵住 ssh-keyscan 选项注入面。
 */
const PLAIN_HOST_PORT = /^([A-Za-z0-9._-]+):(\d+)$/
const BRACKET_HOST_PORT = /^\[([0-9a-fA-F:.]+)\]:(\d+)$/
const BRACKET_HOST = /^\[([0-9a-fA-F:.]+)\]$/

function isValidSshHost(host: string): boolean {
  const portOfPlain = PLAIN_HOST_PORT.exec(host)
  if (portOfPlain) return parseSshPort(portOfPlain[2] ?? '') !== null
  const portOfBracket = /^\[([0-9a-fA-F:.]+)\](?::(\d+))?$/.exec(host)
  if (portOfBracket) return portOfBracket[2] === undefined || parseSshPort(portOfBracket[2]) !== null
  // 方括号只允许包裹 IPv6 字面量（仅十六进制/冒号/点分尾）。其余方括号内容一律拒绝：
  // ssh-keyscan 会先剥掉方括号再作为位置参数传入，`[-flist]` → `-flist` 会被当作选项解析
  // （argv 选项注入面），而顶层 `startsWith('-')` 守卫只看到 `[` 拦不住它。
  if (host.startsWith('[') || host.endsWith(']')) return false
  if (host.includes(':')) {
    // 裸 IPv6（含 IPv4-mapped 点分尾巴 `::ffff:192.168.1.5`）：至少两个冒号且字符集合法
    return /^[0-9a-fA-F:.]+$/.test(host) && (host.match(/:/g)?.length ?? 0) >= 2
  }
  return true
}

function inPortRange(rawPort: string | undefined): boolean {
  const port = Number(rawPort)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * SSH 主机：主机名、别名、IPv4、裸或方括号 IPv6，以及带端口的组合形式。
 * 组合形式由 instance-store 拆分为独立的 host 和 port 字段。
 * 不允许空白、`/`、`@`（userinfo 属于 username 字段，不内嵌主机）。
 */
const SSH_HOST_SCHEMA = z
  .string()
  .trim()
  .min(1, 'SSH 主机不能为空')
  .max(255, 'SSH 主机最长 255 字符')
  .regex(/^[A-Za-z0-9._\-:[\]]+$/, 'SSH 主机含非法字符（不允许空白 / 斜杠 / @）')
  // host 是 ssh 的位置参数:以 '-' 开头会被当作选项解析(argv 选项注入面),
  // 在边界直接拒绝；`-oProxyCommand=` 之类因字符集不含 '=' 本就被拒。
  .refine((value) => !value.startsWith('-'), 'SSH 主机不能以 - 开头')
  .refine(isValidSshHost, 'host[:port] 形态的端口必须在 1–65535，或主机名不含冒号')

/** 配置档案：首字符必须是字母数字，其余允许字母数字与 `.` `_` `/` `-`。 */
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * dsh 版本号允许的字符集：数字、字母与 `.+_-`（覆盖 `0.1.5-rc.2`、`0.1.6+build` 等）。
 * 单一真源放在 shared —— 安装器（拼接隔离目录名，防路径穿越）与注册表 schema 边界共用它，
 * 使非法版本在写入时即被拒，而非等到使用时。
 */
export const DSH_VERSION_PATTERN = /^[0-9A-Za-z.+_-]+$/

/** 注册表里的 dshVersion 校验：允许为空/省略；非空时必须匹配版本字符集。 */
const DSH_VERSION_SCHEMA = z.string().trim().max(64).regex(DSH_VERSION_PATTERN, '版本号含非法字符')

/**
 * 配置档案的形态校验（内部 trim）：匹配 `PROFILE_PATTERN` 且不含 `..` 段。
 * 创建向导与编辑对话框在提交前自查，`SAFE_PROFILE_SCHEMA` 在 IPC 边界再校一次。
 */
export function isValidProfile(value: string): boolean {
  const profile = value.trim()
  return PROFILE_PATTERN.test(profile) && !profile.split('/').includes('..')
}

const SAFE_PROFILE_SCHEMA = z
  .string()
  .trim()
  .min(1, '配置档案不能为空')
  .max(128, '配置档案最长 128 字符')
  .regex(PROFILE_PATTERN, '配置档案只能是相对路径，且不能以 - 开头')
  .refine((value) => !value.split('/').includes('..'), '配置档案不能包含 ..')

const instanceBaseFields = {
  id: z.uuid(),
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 字符'),
  authMode: z.enum(AUTH_MODES),
  /** 备注可为空：null / 省略均表示无备注（补丁层用 null 显式清空） */
  notes: z.string().trim().max(2000, '备注最长 2000 字符').nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
}

// ===== 三种变体（判别联合） =====

export const LocalInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('local'),
  /** 已安装的 dsh 版本；null = 未安装。 */
  dshVersion: DSH_VERSION_SCHEMA.nullable().default(null),
  /** 已分配的监听端口；null = 未分配。 */
  port: PORT_SCHEMA.nullable().default(null),
  /** 实例配置文件（相对 DSH_HOME） */
  profile: SAFE_PROFILE_SCHEMA.nullable().default(null),
  /** 可选的 dsh/dush/duush 启动器；null = 默认 dsh。参数由 Hub 固定构造。 */
  launcher: z.enum(LAUNCHERS).nullable().default(null),
  /** true 时复用用户的 ~/.dsh，而非 Hub 的隔离实例目录。 */
  useDefaultSpace: z.boolean().default(false),
  /** 最近一次启动的命令行；启动成功后由状态事件回写。null = 尚未由 Hub 启动过。 */
  runCommand: z.string().trim().max(2048).nullable().default(null),
  /** 应用启动时自动拉起 */
  autoStart: z.boolean().default(false)
})

export const SshInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('ssh'),
  host: SSH_HOST_SCHEMA,
  /** SSH 连接端口 */
  port: PORT_SCHEMA.default(22),
  username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128, 'SSH 用户名最长 128 字符'),
  /** 远端 dsh 监听端口（隧道目标，默认 dsh web 惯例端口） */
  remotePort: PORT_SCHEMA.default(3080),
  /** 隧道本地端口；null = 未分配。 */
  localPort: PORT_SCHEMA.nullable().default(null),
  /**
   * 显式私钥路径；null = 默认，优先使用 agent。
   *
   * 这是唯一由渲染层提供、会到达主进程文件系统的路径（作为 `ssh -i <path>` 的参数），
   * 是「IPC 不接受渲染层路径」规则下有意的有界例外：SSH 语义要求用户指名密钥文件，
   * 且它只作为 `-i` 的独立 argv 值传入、不经 shell、不构成位置参数（无 `-o` 选项注入面），
   * ssh 至多尝试把它当密钥加载。仅做长度约束。
   */
  identityFile: z.string().trim().max(512).nullable().default(null)
})

export const HttpInstanceSchema = z.object({
  ...instanceBaseFields,
  transport: z.literal('http'),
  /** HTTP 直连端点。存归一化 baseUrl；userinfo、查询串和锚点由 parseEndpointUrl 拒绝。 */
  endpointUrl: z
    .string()
    .trim()
    .max(2048)
    .refine((value) => tryParseEndpoint(value).ok, '端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）')
})

export const InstanceRecordSchema = z.discriminatedUnion('transport', [
  LocalInstanceSchema,
  SshInstanceSchema,
  HttpInstanceSchema
])
export type InstanceRecord = z.infer<typeof InstanceRecordSchema>
export type LocalInstance = Extract<InstanceRecord, { transport: 'local' }>
export type SshInstance = Extract<InstanceRecord, { transport: 'ssh' }>
export type HttpInstance = Extract<InstanceRecord, { transport: 'http' }>

// ===== 创建输入（IPC 边界，.strict()：未知字段一律拒绝） =====

const createBaseFields = {
  name: z.string().trim().min(1, '名称不能为空').max(64, '名称最长 64 字符'),
  authMode: z.enum(AUTH_MODES).default('auto'),
  notes: z.string().trim().max(2000).nullable().optional()
}

export const CreateInstanceInputSchema = z.discriminatedUnion('transport', [
  z
    .object({
      ...createBaseFields,
      transport: z.literal('local'),
      dshVersion: DSH_VERSION_SCHEMA.optional(),
      port: PORT_SCHEMA.optional(),
      profile: SAFE_PROFILE_SCHEMA.optional(),
      launcher: z.enum(LAUNCHERS).optional(),
      useDefaultSpace: z.boolean().optional(),
      /** 创建后接管检测到的外部 dsh web；这些瞬时输入不写入注册表。 */
      useExistingExternal: z.boolean().optional(),
      externalPid: z.number().int().positive().optional(),
      externalAccess: z.string().trim().min(1).max(4096).optional(),
      autoStart: z.boolean().optional(),
      /** 复用 Hub 已有隔离空间；主进程会验证它确实存在且没有已关联实例。 */
      existingSpaceId: z.uuid().optional()
    })
    .strict(),
  z
    .object({
      ...createBaseFields,
      transport: z.literal('ssh'),
      host: SSH_HOST_SCHEMA,
      port: PORT_SCHEMA.optional(),
      username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128),
      remotePort: PORT_SCHEMA.optional(),
      localPort: PORT_SCHEMA.optional(),
      identityFile: z.string().trim().max(512).optional()
    })
    .strict(),
  z
    .object({
      ...createBaseFields,
      transport: z.literal('http'),
      endpointUrl: z
        .string()
        .trim()
        .max(2048)
        .refine((value) => tryParseEndpoint(value).ok, '端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）')
    })
    .strict()
])
/**
 * 调用方（渲染层 / preload / 测试）传入的创建参数：默认值字段可省略，
 * 因此用 z.input 而非 z.infer（后者是已填默认值的输出类型，会把 authMode 变成必填）。
 */
export type CreateInstanceInput = z.input<typeof CreateInstanceInputSchema>
/** 经 schema 解析后的规范形态（store 内部使用） */
export type CreateInstanceParams = z.output<typeof CreateInstanceInputSchema>

// ===== 更新补丁（transport 不可变：改传输形态 = 删除重建） =====

export const PatchInstanceSchema = z
  .object({
    name: z.string().trim().min(1, '名称不能为空').max(64).optional(),
    authMode: z.enum(AUTH_MODES).optional(),
    /** null 用于清空备注 */
    notes: z.string().trim().max(2000).nullable().optional(),
    // —— local ——
    dshVersion: DSH_VERSION_SCHEMA.nullable().optional(),
    port: PORT_SCHEMA.nullable().optional(),
    profile: SAFE_PROFILE_SCHEMA.nullable().optional(),
    launcher: z.enum(LAUNCHERS).nullable().optional(),
    useDefaultSpace: z.boolean().optional(),
    runCommand: z.string().trim().max(2048).nullable().optional(),
    autoStart: z.boolean().optional(),
    // —— ssh ——
    host: SSH_HOST_SCHEMA.optional(),
    username: z.string().trim().min(1).max(128).optional(),
    remotePort: PORT_SCHEMA.optional(),
    localPort: PORT_SCHEMA.nullable().optional(),
    identityFile: z.string().trim().max(512).nullable().optional(),
    // —— http ——
    endpointUrl: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => tryParseEndpoint(value).ok, '端点 URL 无法解析（仅支持 http/https，禁止内嵌凭据 / 查询串 / 锚点）')
      .optional()
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, '补丁不能为空')
export type PatchInstanceInput = z.input<typeof PatchInstanceSchema>
/** 经 schema 解析后的补丁（store 内部使用） */
export type PatchInstanceParams = z.output<typeof PatchInstanceSchema>

// ===== SSH 密钥预览 / 主机指纹确认 / askpass =====

/**
 * SSH 通道：
 * - `keyPreview`：向导/详情页只读展示「将使用哪个密钥」与 agent 状态（绝不含私钥内容）；
 * - `hostKeyDecision`(主→渲染) + `hostKeyReply`(渲染→主)：TOFU 指纹确认（首次/变化双变体）；
 * - `hostKeyForget`(渲染→主)：**显式、破坏性**的恢复动作「忘记该主机指纹」。连接时指纹变化
 *   一律拒绝且不自动清理，只有走完本动作后下一次连接才重新走首次 TOFU；
 * - `askpassRequest`(主→渲染) + `askpassReply`(渲染→主)：SSH 口令/密钥口令弹窗，
 *   口令只经 IPC 瞬时传递，不落盘、不入日志、不进审计。
 */
export const SSH_IPC = {
  keyPreview: 'ssh:keyPreview',
  hostKeyDecision: 'ssh:hostKeyDecision',
  hostKeyReply: 'ssh:hostKeyReply',
  hostKeyForget: 'ssh:hostKeyForget',
  askpassRequest: 'ssh:askpassRequest',
  askpassReply: 'ssh:askpassReply'
} as const

/** 密钥预览输入（向导里的草稿，未必已入库） */
export const SshKeyPreviewInputSchema = z
  .object({
    host: SSH_HOST_SCHEMA,
    port: PORT_SCHEMA.default(22),
    username: z.string().trim().min(1, 'SSH 用户名不能为空').max(128),
    identityFile: z.string().trim().max(512).nullable().optional()
  })
  .strict()
export type SshKeyPreviewInput = z.input<typeof SshKeyPreviewInputSchema>

export type SshAgentStatus = 'ready' | 'empty' | 'unavailable'

export interface SshAgentKeyInfo {
  type: string
  typeLabel: string
  /** 公钥体（只读展示，不含任何私钥信息） */
  blob: string
  comment: string | null
  fingerprint: string
}

export interface SshKeyPreviewResult {
  target: string
  resolved: { user: string; host: string; port: number }
  identityFiles: string[]
  agent: { status: SshAgentStatus; keys: SshAgentKeyInfo[] }
  explicitIdentityFile: string | null
}

export interface HostKeyFingerprintInfo {
  type: string
  typeLabel: string
  fingerprint: string
}

/** 指纹确认请求（主 → 渲染）；verdict=changed 时 UI 走红色警示且默认拒绝 */
export interface HostKeyPromptPayload {
  requestId: string
  instanceId: string
  /** 目标标签（host 或 host:port） */
  target: string
  verdict: 'unknown' | 'changed'
  fingerprints: HostKeyFingerprintInfo[]
  previousFingerprints: HostKeyFingerprintInfo[]
}

export type HostKeyDecision = 'trust' | 'reject'

/**
 * 「忘记该主机指纹」输入（渲染 → 主）。
 *
 * 删除已保存的指纹后，下一次连接会重新按首次连接核对新指纹。
 * 该操作不属于连接确认流程，且只能由用户单独发起。
 */
export interface SshHostKeyForgetInput {
  instanceId: string
}

/** askpass 口令请求（主 → 渲染）；secret 只经 IPC 瞬时传递 */
export interface AskpassPromptPayload {
  requestId: string
  instanceId: string
  prompt: string
}

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

// ===== 认证：状态流与登录提交 =====

/**
 * 渲染层只触发登录与观察状态，凭据只在主进程内存中流转，不落盘或写入日志。
 * - `auth:probe` 探测并静默恢复(带已存 Cookie);
 * - `auth:login` 提交密码(可带 OTP 完成单请求 2FA —— 验证码阶段复用同一次密码重发,
 *   不做分步 /otp/verify；
 * - `auth:logout` 清除会话;
 * - `auth:state`(主→渲染)状态机快照,驱动 auth-panel 与工作区浮层。
 */
export const AUTH_IPC = {
  probe: 'auth:probe',
  login: 'auth:login',
  /** 使用保险库中的已存密码登录；密码不跨 IPC。 */
  loginStored: 'auth:loginStored',
  logout: 'auth:logout',
  state: 'auth:state',
  /** 会话失效/需要验证码等来自 webview 拦截的信号(主→渲染) */
  signal: 'auth:signal'
} as const

/**
 * 凭据保险库。
 * 通道命名与 auth:* 并列；策略默认保存，用户可显式取消。
 */
export const VAULT_IPC = {
  status: 'vault:status',
  setPolicy: 'vault:setPolicy',
  forget: 'vault:forget',
  clear: 'vault:clear'
} as const

/** 单个实例的记住策略。新实例默认保存密码和会话，用户可显式取消。 */
export const DEFAULT_VAULT_POLICY = {
  rememberPassword: true,
  rememberSession: true
} as const satisfies VaultPolicy

export const VaultPolicySchema = z.object({
  rememberPassword: z.boolean(),
  rememberSession: z.boolean()
})
export type VaultPolicy = z.infer<typeof VaultPolicySchema>

/** vault 状态(渲染层据此显示降级告警与「已记住」标记) */
export interface VaultStatusSnapshot {
  /** 系统钥匙串可用(safeStorage) */
  available: boolean
  /** 降级为纯内存模式:此时勾选也无意义,UI 必须告警 */
  degraded: boolean
  /** 已记住凭据的实例 id */
  rememberedInstances: string[]
  /** 当前实例的勾选策略，用于避免以过时状态覆盖另一个开关。 */
  policies: Record<string, VaultPolicy>
}

/**
 * 应用设置通道；敏感项一律走 vault。
 */
export const SETTINGS_IPC = {
  get: 'settings:get',
  update: 'settings:update',
  /** 应用数据目录由主进程自行解析；通道不接受参数。 */
  openDataDir: 'settings:openDataDir',
  /**
   * 刷新环境缓存（失效并重新解析登录 PATH / shell 环境）；无参数。
   * 返回刷新前后的环境差异，以及当前正在运行、可由 hub 重启的本机实例 id，
   * 供渲染层报告变化并决定是否提示重启生效。
   */
  refreshEnvironment: 'settings:refreshEnvironment'
} as const

/**
 * 刷新环境缓存前后的差异。
 *
 * 只回传 PATH 条目与变量**名**：变量值可能含凭据，绝不外传（值仅在主进程内
 * 用于判定是否变化）。列表按新/旧顺序排列，仅列增删项 —— PATH 顺序调整不计。
 */
export interface EnvironmentDiff {
  /** 两侧 PATH 均解析成功；false = 无法对比（解析失败/不可用），路径列表为空。 */
  pathComparable: boolean
  /** 两侧登录 shell 环境均解析成功；false = 无法对比（非 zsh/bash 等），变量列表为空。 */
  varsComparable: boolean
  pathAdded: string[]
  pathRemoved: string[]
  varsAdded: string[]
  varsRemoved: string[]
  /** 两侧都有但取值不同的变量名（只给名字）。 */
  varsChanged: string[]
}

/** `settings:refreshEnvironment` 的返回。 */
export interface EnvironmentRefreshResult {
  /** 正在运行、可由 hub 重启的本机实例 id（外部接管的除外）。 */
  instances: string[]
  diff: EnvironmentDiff
}

export type AuthPhase =
  | 'unknown'
  | 'probe'
  | 'needs-auth'
  | 'await-credentials'
  | 'await-otp'
  | 'connected'
  | 'error'

export interface AuthStateSnapshot {
  phase: AuthPhase
  needsOnboarding: boolean
  otpEnabled: boolean
  lockedForMs: number
  message: string | null
  lastErrorCode: string | null
}

/** `auth:state` 事件载荷 */
export interface AuthStateEvent {
  instanceId: string
  state: AuthStateSnapshot
  at: string
}

/** `auth:signal` 事件载荷(webview 拦截结论) */
export interface AuthSignalEvent {
  instanceId: string
  signal: 'session-expired' | 'needs-otp' | 'needs-onboarding'
  at: string
}

// ===== 注册表文件与版本迁移 =====

/**
 * 注册表 schema 版本。
 * - v1：初始形态。
 * - v2：`SSH_HOST_SCHEMA` 收紧（方括号只允许包裹 IPv6 字面量）与 `dshVersion` 收紧
 *   （必须匹配 `DSH_VERSION_PATTERN`）后，旧版可能写入过 `[plainhost]` / 含空格的版本号；
 *   v1→v2 迁移把这类历史值归一化，避免整表因单条不合法被隔离（见 registry 迁移器）。
 */
export const REGISTRY_SCHEMA_VERSION = 2

export const RegistryFileSchema = z.object({
  schemaVersion: z.number('schemaVersion 必须是数字').int().min(1),
  instances: z.array(InstanceRecordSchema)
})
export type RegistryFile = z.infer<typeof RegistryFileSchema>

export type RegistryMigration = (file: unknown) => unknown

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
  adoptExternal: 'instances:adoptExternal',
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
 * - `restart-required`：已保存但未激活，需重启 Host（替换/升级已装包时无条件如此，
 *   Node 模块缓存无法为已加载的包换模块代；或 profile 无 HMR）。
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
export type IpcResult<T> = { ok: true; value: T } | { ok: false; code: IpcErrorCode; message: string }

// ===== 工具 =====

/** 把 zod 校验问题折叠成一条封顶的纯文本（供 IPC 错误信封使用） */
export function formatZodIssues(error: z.ZodError, cap = 300): string {
  const parts = error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
  )
  const joined = parts.join('; ')
  return joined.length > cap ? `${joined.slice(0, cap)}…` : joined
}

export interface SshHostPortSplit {
  host: string
  port: number
  /** 端口是否来自 host 内的 `:port` 组合形式；false 表示取 fallbackPort（调用方不应据此覆盖已有端口） */
  portEmbedded: boolean
}

/**
 * SSH `host[:port]` / `[v6][:port]` 组合形式拆分。
 * - 纯主机名 / 别名 / 裸 IPv6（含冒号但非 host:port 形态）原样返回，端口取 fallbackPort；
 * - 方括号形态一律剥离方括号（`[::1]` → `::1`、`[::1]:2222` → `::1` + 2222）；
 * - 字符类含 `.`，与 SSH_HOST_SCHEMA 的方括号分支保持一致（`[::ffff:192.168.1.1]`、
 *   `[192.0.2.1]:2222` 等点分形态也必须能拆分，否则端口会静默回退）。
 */
export function splitSshHostPort(host: string, fallbackPort: number): SshHostPortSplit {
  const plain = PLAIN_HOST_PORT.exec(host)
  if (plain) {
    const port = parseSshPort(plain[2] ?? '')
    if (port !== null) return { host: plain[1] ?? '', port, portEmbedded: true }
  }
  const bracketedWithPort = BRACKET_HOST_PORT.exec(host)
  if (bracketedWithPort) {
    const port = parseSshPort(bracketedWithPort[2] ?? '')
    if (port !== null) return { host: bracketedWithPort[1] ?? '', port, portEmbedded: true }
  }
  // 方括号无端口形态 `[::1]`：只归一化主机形态，端口由调用方决定
  const bracketedPlain = BRACKET_HOST.exec(host)
  if (bracketedPlain) {
    return { host: bracketedPlain[1] ?? '', port: fallbackPort, portEmbedded: false }
  }
  return { host, port: fallbackPort, portEmbedded: false }
}

/** 「关于」对话框的项目主页（主进程固定，渲染层无从指定其他 URL） */
export const HOMEPAGE_URL = 'https://github.com/xbzbing/dsh-hub-desktop'