/**
 * IPC 通道的公共辅助：错误信封包装、入参解析、外部接管地址收敛、实例摘要、
 * 升级资格判定与认证探测(含已存密码静默登录)。
 * 全部是无状态函数；会话态(登录记忆等)由装配层持有并以参数注入。
 */
import { z } from 'zod'
import { EndpointParseError } from '@shared/endpoint'
import {
  formatZodIssues,
  type AuthStateSnapshot,
  type DshVersionCheck,
  type InstanceRecord,
  type InstanceRuntimeStatus,
  type InstanceStatusEvent,
  type InstanceSummary,
  type IpcErrorCode,
  type IpcResult
} from '@shared/contracts'
import { HomepageOpenError } from '../shell/open-homepage'
import { DataDirOpenError } from '../shell/open-data-dir'
import { InstanceStoreError } from '../registry/instance-store'
import type { AuthRegistry } from '../auth/auth-registry'
import type { Vault } from '../vault/vault'

/** 通道处理函数的统一包装：把同步/异步任务收敛为 `IpcResult` 信封。 */
export type IpcWrap = <T>(task: () => Promise<T> | T) => Promise<IpcResult<T>>

/** 构造失败信封；`code` 必须是 IPC 白名单内的稳定错误码。 */
const fail = (
  code: IpcErrorCode,
  message: string
): { ok: false; code: IpcErrorCode; message: string } => ({
  ok: false,
  code,
  message
})

export async function wrap<T>(task: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await task() }
  } catch (error) {
    if (error instanceof InstanceStoreError) return fail(error.code, error.message)
    if (error instanceof z.ZodError) return fail('invalid-input', formatZodIssues(error))
    // 端点解析失败属输入问题(不是内部错误):与 instances:create 的 tryParseEndpoint 口径一致
    if (error instanceof EndpointParseError) return fail('invalid-input', error.message)
    // 打开数据目录失败:带稳定错误码(io-error/internal)显式回报。
    if (error instanceof DataDirOpenError) return fail(error.code, error.message)
    // 打开项目主页失败:同口径,不静默成功
    if (error instanceof HomepageOpenError) return fail(error.code, error.message)
    // 内部错误不透传细节(可能含 fs 路径),只记主进程日志;只记错误类型与消息,不序列化整个错误对象
    console.error(
      '[ipc] 未预期错误：',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    )
    return fail('internal', '内部错误，请查看应用日志')
  }
}

export function parseId(id: unknown): string {
  return z.uuid().parse(id)
}

/**
 * 将用户提供的 token 或 dsh 输出的完整地址收敛为已验证的回环 URL。
 * token 只由主进程保存在当前会话中，不能进入注册表、状态事件或日志。
 */
export function externalAccessToken(raw: unknown, port: number): string {
  const access = z.string().trim().min(1).max(4096).parse(raw)
  if (!access.includes('://')) {
    if (/\s/.test(access)) throw new InstanceStoreError('invalid-input', '访问 token 不能包含空白')
    return access
  }
  let url: URL
  try {
    url = new URL(access)
  } catch {
    throw new InstanceStoreError('invalid-input', '访问链接无法解析')
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') ||
    url.port !== String(port) ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new InstanceStoreError(
      'invalid-input',
      '访问链接必须匹配已检测的本机 dsh 端口并包含 token'
    )
  }
  const token = url.searchParams.get('token')
  const containsControl = (value: string): boolean => /[\p{C}]/u.test(value)
  if (token === null || token === '' || containsControl(token)) {
    throw new InstanceStoreError(
      'invalid-input',
      '访问链接必须匹配已检测的本机 dsh 端口并包含 token'
    )
  }
  return token
}

/** 将 token 拼入已由主进程重新扫描确认的回环端口。 */
export function externalAccessUrl(token: string, port: number): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
}

/** 外部 dsh 的访问地址映射(实例 id → 进程/端口/URL)：仅驻留在主进程会话内。 */
export type ExternalAccessUrls = Map<string, { pid: number; port: number; url: string }>

export function toSummary(
  record: InstanceRecord,
  runtimeStatus?: InstanceRuntimeStatus,
  localHome?: string,
  runtimeVersion?: string
): InstanceSummary {
  const address =
    record.transport === 'local'
      ? `127.0.0.1:${record.port ?? '—'}`
      : record.transport === 'ssh'
        ? `${record.host}:${record.remotePort}`
        : record.endpointUrl
  // 运行中以实时状态版本为准，停止后回落到本机实例注册表固定的版本；'custom' 是占位符不是版本号。
  const runtime =
    runtimeVersion !== undefined && runtimeVersion !== '' && runtimeVersion !== 'custom'
      ? runtimeVersion
      : undefined
  const persisted = record.transport === 'local' ? (record.dshVersion ?? undefined) : undefined
  const version = runtime ?? persisted
  return {
    id: record.id,
    name: record.name,
    transport: record.transport,
    ...(record.transport === 'local' ? { useDefaultSpace: record.useDefaultSpace } : {}),
    ...(record.transport === 'local' && localHome ? { localHome } : {}),
    authMode: record.authMode,
    address,
    ...(runtimeStatus ? { runtimeStatus } : {}),
    ...(version !== undefined ? { version } : {}),
    updatedAt: record.updatedAt
  }
}

/** 外部本机 dsh token 验收探测的超时：慢/半开的本地服务不得让接管流程无限期挂起。 */
export const EXTERNAL_ACCESS_PROBE_TIMEOUT_MS = 5_000

export async function defaultVerifyExternalAccess(
  url: string,
  timeoutMs: number = EXTERNAL_ACCESS_PROBE_TIMEOUT_MS
): Promise<boolean> {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs)
  })
  return response.status !== 401 && response.status !== 403
}

/**
 * 升级资格判定（纯逻辑）：本地且非外部接管的实例都可由本应用升级。
 * - 外部接管的进程归用户所有，一律不代管；
 * - 其余本地实例（默认/dush/duush 启动器、公共/隔离空间、hub/path 来源）都允许升级，
 *   升级对象由 runtime 层按空间与当前来源决定；公共空间还要看系统 dsh 的安装来源，
 *   由 check 检测后用 `global-unmanaged` 提前告知。
 */
export function upgradeEligibility(
  record: InstanceRecord,
  runtimeSource: InstanceStatusEvent['runtimeSource'] | undefined
): { canUpgrade: boolean; reason?: DshVersionCheck['reason'] } {
  if (record.transport !== 'local') return { canUpgrade: false, reason: 'not-local' }
  if (runtimeSource === 'external') return { canUpgrade: false, reason: 'runtime-external' }
  return { canUpgrade: true }
}

/** 认证探测与静默登录所需的依赖：认证注册表与保险库。 */
export interface StoredLoginDeps {
  auth: AuthRegistry
  vault: Vault
}

/** 会话内登录记忆(进程生命周期,不落盘)：每次装配认证通道时新建，不跨 registerIpc 共享。 */
export interface StoredLoginMemory {
  storedLoginAttempted: Set<string>
  logoutSuppressed: Set<string>
}

/**
 * 探测后处于可提交认证的阶段且 vault 已存密码时，自动用已存密码登录一次，
 * 返回登录后的状态；条件不满足或登录抛错时原样返回入参状态。
 *
 * 触发集合 = needs-auth ‖ await-credentials 且未锁定(lockedForMs===0)。
 * **为什么是这两相**:真实状态机下 probe 的终态是 await-credentials,不是
 * needs-auth —— probeAndRestore 识别网关后固定走 probe-gateway → session-absent
 * 仅首探瞬间经过 needs-auth,只认 needs-auth 则静默登录在生产不可达。
 * await-otp 不触发:已到验证码阶段,密码复用走 AuthPanel 的 loginStored(otp)。
 *
 * 两条会话内记忆(进程生命周期,不落盘):
 * - `storedLoginAttempted`:每实例只自动尝试一次 —— 401 密码失效/429 限流都不重试;
 * - `logoutSuppressed`:用户显式登出后不再静默登录(否则「登出→探测」立即复活),
 *   直到该实例手动登录成功才解除。重启后记忆清零:重启静默复登是「记住密码」
 * 的既定语义,彻底退出须用「清除已记住的凭据」(vault 忘记)。
 *
 * 审计不在此处发生:状态迁移经 auth:state → 审计映射自动落
 * login-success / login-failed / rate-limited。
 */
export async function autoLoginWithStored(
  deps: StoredLoginDeps,
  memory: StoredLoginMemory,
  instanceId: string,
  state: Awaited<ReturnType<AuthRegistry['stateOf']>>
): Promise<Awaited<ReturnType<AuthRegistry['stateOf']>>> {
  if (state === null) return state
  const needsAuth = state.phase === 'needs-auth' || state.phase === 'await-credentials'
  if (!needsAuth || state.lockedForMs > 0) return state
  if (memory.storedLoginAttempted.has(instanceId) || memory.logoutSuppressed.has(instanceId))
    return state
  // 登出清理窗口内不静默登录：与 logoutSuppressed 同向，只是还没来得及落抑制记忆。
  if (deps.auth.isLoggingOut(instanceId)) return state
  if (!deps.vault.getPolicy(instanceId).rememberPassword) return state
  const stored = deps.vault.getPassword(instanceId)
  if (stored === null) return state
  // 先记账再尝试:无论成败,会话内不再自动重试
  memory.storedLoginAttempted.add(instanceId)
  try {
    return (await deps.auth.login(instanceId, stored, undefined)) ?? state
  } catch (error) {
    // 自动登录是尽力而为:异常(网络等)不能把一次成功的探测变成 IPC 错误
    console.error('[register] 已存密码静默登录失败（不重试）：', error)
    return state
  }
}

export async function probeWithStoredPassword(
  deps: StoredLoginDeps,
  memory: StoredLoginMemory,
  instanceId: string
): Promise<AuthStateSnapshot | null> {
  const beforeProbe = deps.auth.stateOf(instanceId)
  await deps.auth.probe(instanceId)
  const probedState = deps.auth.stateOf(instanceId) as Awaited<ReturnType<AuthRegistry['stateOf']>>
  // 远端 dsh 重启会让原有 Cookie 失效：允许这次从 connected 回落到登录态时重新复用一次已存密码。
  if (beforeProbe?.phase === 'connected' && probedState?.phase !== 'connected') {
    memory.storedLoginAttempted.delete(instanceId)
  }
  const state = await autoLoginWithStored(deps, memory, instanceId, probedState)
  return state
}
