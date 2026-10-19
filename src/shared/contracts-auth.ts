/**
 * 认证与保险库契约：状态流、登录提交、策略与设置项 IPC 名。
 *
 * 本模块不 import electron。
 */
import { z } from 'zod'

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
  'unknown' | 'probe' | 'needs-auth' | 'await-credentials' | 'await-otp' | 'connected' | 'error'

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
