/**
 *
 * 职责:按实例 id 持有 AuthClient(内存),提供探针/登录/验证码/登出/状态快照,
 * 凭据只在内存中流转:密码/验证码不落盘、不进日志、不进审计。
 */
import type { HttpAuthDetection } from '@shared/contracts'
import type { AuthState } from './gateway-state'
import { createAuthClient, type AuthClient, type AuthClientOptions } from './auth-client'
import { createConcurrencyGate } from './backoff'

export type AuthClientFactory = (options: AuthClientOptions) => AuthClient

export interface AuthRegistryOptions {
  /** 实例端点解析(含 basePath):由调用方从注册表读取 */
  resolveEndpoint: (instanceId: string) => Promise<string | null>
  factory?: AuthClientFactory
  /** 全局并发认证上限(设计默认 2) */
  maxConcurrentAuth?: number
  onState?: (instanceId: string, state: AuthState) => void
  /** 登录成功(含已存密码静默登录)后回调，供装配层刷新对应工作区会话 */
  onLoginSucceeded?: (instanceId: string) => void
  /**
   * 客户端创建后的恢复钩子：把 vault 里已记住的登录态灌进 Cookie 罐，
   * 使随后的 `probeAndRestore` 走静默恢复分支。**在返回客户端之前 await** ——
   * 否则首次探测可能先于恢复执行，重启复用就失效了。
   */
  restore?: (instanceId: string, client: AuthClient) => Promise<void> | void
  /** 注入 fetch(测试) */
  fetchImpl?: typeof fetch
  now?: () => number
}

export interface AuthRegistry {
  /** 取得(或惰性创建)实例的客户端 */
  client(instanceId: string): Promise<AuthClient | null>
  /** 丢弃实例客户端(删除实例/登出清理) */
  forget(instanceId: string): void
  /**
   * 登出窗口标记：从登出开始到分区 Cookie、vault 会话清理完成期间，
   * 禁止会话恢复与会话回写，并压住已存密码静默登录——否则并发探测
   * 会重建客户端、从 vault 注入旧 Cookie，把登出复活。
   */
  beginLogout(instanceId: string): void
  endLogout(instanceId: string): void
  isLoggingOut(instanceId: string): boolean
  /** 状态快照(未创建客户端返回 null) */
  stateOf(instanceId: string): AuthState | null
  /** 探测并尝试静默恢复 */
  probe(instanceId: string): Promise<HttpAuthDetection | null>
  login(instanceId: string, password: string, otp?: string): Promise<AuthState | null>
  logout(instanceId: string): Promise<AuthState | null>
  /** 会话 Cookie(供分区注入);无会话返回 null */
  sessionCookie(
    instanceId: string
  ): { name: string; value: string; expiresAt: number | null } | null
  clientIds(): string[]
}

export function createAuthRegistry(options: AuthRegistryOptions): AuthRegistry {
  const clients = new Map<string, AuthClient>()
  const loggingOut = new Set<string>()
  const factory = options.factory ?? createAuthClient
  // 所有会打网关的调用统一经过它,避免多实例同时压认证端点
  const gate = createConcurrencyGate(options.maxConcurrentAuth ?? 2)

  /** 端点解析与客户端构造有 await 间隙，并发调用必须收敛到同一次创建（single-flight）。 */
  const pendingClients = new Map<string, Promise<AuthClient | null>>()

  async function createClient(instanceId: string): Promise<AuthClient | null> {
    const endpointUrl = await options.resolveEndpoint(instanceId)
    if (!endpointUrl) return null
    const created = factory({
      instanceId,
      endpointUrl,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.now === undefined ? {} : { now: options.now }),
      onState: (state) => options.onState?.(instanceId, state),
      onLoginSucceeded: () => options.onLoginSucceeded?.(instanceId)
    })
    clients.set(instanceId, created)
    // 先恢复已记住的登录态,再交给调用方探测(顺序是「重启静默复用」成立的前提);
    // 登出窗口内跳过恢复,否则 vault 旧 Cookie 会把登出复活。
    if (options.restore && !loggingOut.has(instanceId)) {
      try {
        await options.restore(instanceId, created)
      } catch (error) {
        // 恢复是尽力而为:失败就回到「需要登录」,绝不能让客户端创建失败
        console.error('[auth-registry] 恢复客户端状态失败：', error)
      }
    }
    return created
  }

  function clientFor(instanceId: string): Promise<AuthClient | null> {
    const existing = clients.get(instanceId)
    if (existing) return Promise.resolve(existing)
    const pending = pendingClients.get(instanceId)
    if (pending) return pending
    const creation = createClient(instanceId).finally(() => {
      if (pendingClients.get(instanceId) === creation) pendingClients.delete(instanceId)
    })
    pendingClients.set(instanceId, creation)
    return creation
  }

  return {
    client: clientFor,
    forget(instanceId) {
      clients.delete(instanceId)
    },
    beginLogout(instanceId) {
      loggingOut.add(instanceId)
    },
    endLogout(instanceId) {
      loggingOut.delete(instanceId)
    },
    isLoggingOut(instanceId) {
      return loggingOut.has(instanceId)
    },
    stateOf(instanceId) {
      return clients.get(instanceId)?.state() ?? null
    },
    async probe(instanceId) {
      const client = await clientFor(instanceId)
      return client ? gate.run(() => client.probeAndRestore()) : null
    },
    async login(instanceId, password, otp) {
      const client = await clientFor(instanceId)
      return client ? gate.run(() => client.login(password, otp)) : null
    },
    async logout(instanceId) {
      const client = clients.get(instanceId)
      if (!client) return null
      const state = await client.logout()
      clients.delete(instanceId)
      return state
    },
    sessionCookie(instanceId) {
      const client = clients.get(instanceId)
      if (!client) return null
      const record = client.jar.get('dsh_auth')
      if (!record) return null
      return { name: record.name, value: record.value, expiresAt: record.expiresAt }
    },
    clientIds: () => [...clients.keys()]
  }
}
