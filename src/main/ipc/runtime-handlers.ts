/**
 * 实例运行时与视图通道：启停/重启、打开与隐藏工作区、本机 dsh 探测与外部接管。
 * 打开工作区的并发合并与目标实例跟踪是本模块的注册内状态，不跨 registerIpc 共享。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { LAUNCHERS } from '@shared/local-launch'
import {
  INSTANCE_RUNTIME_IPC,
  WorkspaceTooltipSchema,
  WorkspaceViewBoundsSchema,
  type AuthStateSnapshot,
  type ExternalDshWebSnapshot,
  type HttpInstance,
  type IpcResult,
  type InstanceRecord,
  type LocalInstance,
  type LocalLauncherSnapshot,
  type SshInstance,
  type WorkspaceViewBounds
} from '@shared/contracts'
import { httpDirectEndpoint } from '../transport/endpoint-resolver'
import { shouldReuseLoadedView } from '../webview/instance-view'
import { InstanceStoreError, requireInstance, type InstanceStore } from '../registry/instance-store'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import type { ExternalDshScanner } from '../local-runtime/external-dsh'
import type { PathProbe } from '../local-runtime/runtime-source'
import type { SshTunnelManager } from '../transport/ssh-tunnel'
import type { HttpEndpointManager } from '../transport/http-endpoint'
import type { Vault } from '../vault/vault'
import type { AuditEntry } from '../audit/audit-log'
import {
  EXTERNAL_ACCESS_TOKEN_INVALID,
  LISTEN_PORT_UNDETERMINED,
  SCANNER_UNAVAILABLE,
  notFoundDshPid
} from './errors'
import {
  defaultVerifyExternalAccess,
  externalAccessToken,
  externalAccessUrl,
  parseId,
  type ExternalAccessUrls,
  type IpcWrap
} from './ipc-utils'

export interface RuntimeHandlerDeps {
  runtime: LocalRuntimeManager
  tunnels: SshTunnelManager
  http: HttpEndpointManager
  externalDshScanner?: ExternalDshScanner
  pathProbe?: PathProbe
  vault: Vault
  verifyExternalAccess?: (url: string) => Promise<boolean>
  openInstanceView: (instance: InstanceRecord, url: string) => Promise<void>
  /**
   * 刷新指定实例已缓存的内嵌工作区：注入最新会话 Cookie 并导航回工作区 URL。
   * 重新登录成功后调用，取代会话失效前的旧页面；未缓存视图时为空操作。
   */
  reloadInstanceView?: (instanceId: string) => Promise<void>
  /** 在系统默认浏览器中打开 URL；主进程按协议白名单校验后交给 shell.openExternal。 */
  openExternalUrl?: (url: string) => Promise<void>
  hideInstanceView?: () => void
  closeInstanceView?: (instanceId: string) => void
  setInstanceViewBounds?: (bounds: WorkspaceViewBounds) => void
  showInstanceTooltip?: (tooltip: { text: string; x: number; y: number }) => Promise<void>
  hideInstanceTooltip?: () => void
  instanceViewUrl?: (instanceId: string) => string | null
  audit?: (entry: AuditEntry) => void
}

/** 跨通道注入：外部接管的访问地址映射与认证探测。 */
export interface RuntimeHandlerWires {
  externalAccessUrls: ExternalAccessUrls
  probe: (instanceId: string) => Promise<AuthStateSnapshot | null>
}

export function registerRuntimeHandlers(
  store: InstanceStore,
  deps: RuntimeHandlerDeps,
  wires: RuntimeHandlerWires,
  wrap: IpcWrap
): void {
  const { externalAccessUrls } = wires

  ipcMain.handle(INSTANCE_RUNTIME_IPC.start, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const instance = await requireInstance(store, instanceId)
      if (instance.transport === 'local') {
        // 不 await：安装/启动可能耗时数十秒，进展与失败都走状态事件
        void deps.runtime.start(instance)
        return null
      }
      if (instance.transport === 'ssh') {
        void deps.tunnels.start(instance)
        return null
      }
      if (instance.transport === 'http') {
        void deps.http.start(instance)
        return null
      }
      throw new InstanceStoreError('invalid-input', '未知的传输类型')
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.stop, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      externalAccessUrls.delete(instanceId)
      const record = await store.get(instanceId)
      if (record?.transport === 'ssh') await deps.tunnels.stop(instanceId)
      else if (record?.transport === 'http') await deps.http.stop(instanceId)
      else await deps.runtime.stop(instanceId) // local 或不存在:runtime.stop 幂等
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.restart, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const instance = await requireInstance(store, instanceId)
      if (instance.transport !== 'local') {
        throw new InstanceStoreError('invalid-input', '只有本机实例支持重启')
      }
      // 外部接管的进程归用户所有,hub 无权重启;未运行的实例没有进程可重启。
      const status = deps.runtime.statusOf(instanceId)
      if (!status || status.status !== 'running') {
        throw new InstanceStoreError('invalid-state', '实例未在运行，无法重启')
      }
      if (status.runtimeSource === 'external') {
        throw new InstanceStoreError(
          'invalid-state',
          '外部接管的 dsh 进程归用户所有，不能由 hub 重启'
        )
      }
      // 先完全停止（等待进程退出并发出 stopped），再按当前注册表配置重新拉起。
      // 重启前刷新登录环境缓存：用户新装的工具（如 git）无需重启 app，重启实例即可解析到。
      // 重启可能分配新端口/新 browser-auth URL：启动耗时较长，不 await，
      // 进展与失败都经状态事件回推，渲染层据 running 事件重开工作区。
      await deps.runtime.stop(instanceId)
      await deps.runtime.refreshEnv().catch(() => undefined)
      void deps.runtime.start(instance)
      return null
    })
  )

  const openViewTasks = new Map<string, Promise<void>>()
  let workspaceTargetId: string | null = null

  async function openWorkspace(instanceId: string): Promise<void> {
    // 同实例的并发请求合并；不同实例则只有最新目标可以激活原生视图。
    const isCurrent = (): boolean => workspaceTargetId === instanceId
    const openIfCurrent = async (instance: InstanceRecord, url: string): Promise<void> => {
      if (!isCurrent()) return
      // 首次打开不能依赖详情页的异步 probe：它可能晚于 WebContentsView 的首个导航，
      // 导致已记住的会话 Cookie 还没恢复就先被网关重定向到 /login。
      // 但已经停在同一 URL 的缓存视图不会再导航（见 shouldReuseLoadedView），
      // 此时注入 Cookie 无从发生，等待一次远程网关往返只会拖长切换的加载时间。
      if (instance.authMode !== 'none') {
        const probe = wires.probe(instance.id)
        const cachedUrl = deps.instanceViewUrl?.(instance.id) ?? undefined
        if (shouldReuseLoadedView(cachedUrl, url)) {
          void probe.catch((error: unknown) =>
            console.error('[register] 后台认证探测失败：', error)
          )
        } else {
          await probe
        }
      }
      if (isCurrent()) await deps.openInstanceView(instance, url)
    }

    /** 未在运行的远程端点：确保探测已启动，返回直连地址。 */
    const openHttp = async (instance: HttpInstance, starting: boolean): Promise<string> => {
      if (!starting) {
        void deps.http.start(instance).catch((error: unknown) => {
          console.error('[register] HTTP 实例状态探测失败：', error)
        })
      }
      return httpDirectEndpoint(instance)
    }

    /** 未在运行的 SSH 实例：建立隧道后取就绪地址，未就绪返回 null。 */
    const openSsh = async (instance: SshInstance): Promise<string | null> => {
      await deps.tunnels.start(instance)
      const ready = deps.tunnels.statusOf(instanceId)
      return ready?.status === 'running' && ready.url ? ready.url : null
    }

    /** 未在运行的本机实例：已记住的外部访问 → 扫描接管 → 托管启动；本分支只扫描一次。 */
    const openLocal = async (instance: LocalInstance): Promise<string | null> => {
      const external = deps.externalDshScanner ? await deps.externalDshScanner.scan() : []
      const savedAccess = externalAccessUrls.get(instanceId)
      if (savedAccess) {
        const match = external.find(
          (item) => item.pid === savedAccess.pid && item.port === savedAccess.port
        )
        if (!match) {
          externalAccessUrls.delete(instanceId)
          await deps.runtime.stop(instanceId)
          await deps.vault.forgetExternalAccessToken(instanceId)
          throw new InstanceStoreError(
            'invalid-state',
            '本机 dsh 已重启，请在实例详情中更新访问 token'
          )
        }
        return savedAccess.url
      }
      const match = external.find((item) => item.port === instance.port)
      if (match && match.port !== null) {
        const token = deps.vault.getExternalAccessToken(instanceId)
        if (!token) {
          throw new InstanceStoreError(
            'invalid-state',
            '本机 dsh 需要访问 token，请在实例详情中更新'
          )
        }
        const accessUrl = externalAccessUrl(token, match.port)
        if (!(await (deps.verifyExternalAccess ?? defaultVerifyExternalAccess)(accessUrl))) {
          await deps.vault.forgetExternalAccessToken(instanceId)
          throw new InstanceStoreError(
            'invalid-state',
            '本机 dsh 的访问 token 已失效，请在实例详情中更新'
          )
        }
        await deps.runtime.adopt(instance, { pid: match.pid, port: match.port, patch: match.patch })
        externalAccessUrls.set(instanceId, { pid: match.pid, port: match.port, url: accessUrl })
        return accessUrl
      }
      await deps.runtime.start(instance)
      const ready = deps.runtime.statusOf(instanceId)
      const url = deps.runtime.urlOf(instanceId)
      return ready?.status === 'running' && url ? url : null
    }

    const instance = await requireInstance(store, instanceId)
    const status =
      instance.transport === 'ssh'
        ? deps.tunnels.statusOf(instanceId)
        : instance.transport === 'http'
          ? deps.http.statusOf(instanceId)
          : deps.runtime.statusOf(instanceId)
    if (
      status?.status === 'running' &&
      !(instance.transport === 'local' && status.runtimeSource === 'external')
    ) {
      const url = instance.transport === 'local' ? deps.runtime.urlOf(instanceId) : status.url
      if (!url) throw new Error('workspace-url-unavailable')
      await openIfCurrent(instance, url)
      return
    }
    const url =
      instance.transport === 'http'
        ? await openHttp(instance, status?.status === 'starting')
        : instance.transport === 'ssh'
          ? await openSsh(instance)
          : await openLocal(instance)
    if (url !== null) await openIfCurrent(instance, url)
  }

  ipcMain.handle(INSTANCE_RUNTIME_IPC.openView, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      workspaceTargetId = instanceId
      const existing = openViewTasks.get(instanceId)
      if (existing) {
        await existing
        return null
      }
      const task = openWorkspace(instanceId)
      openViewTasks.set(instanceId, task)
      try {
        await task
      } finally {
        if (openViewTasks.get(instanceId) === task) openViewTasks.delete(instanceId)
      }
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.reloadView, (_event, id: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      // 重新登录成功后刷新：注入最新会话 Cookie 并导航回工作区 URL。未缓存视图时为空操作。
      await deps.reloadInstanceView?.(instanceId)
      return null
    })
  )

  ipcMain.handle(
    INSTANCE_RUNTIME_IPC.openInBrowser,
    (_event, id: unknown): Promise<IpcResult<null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const instance = await requireInstance(store, instanceId)
        // 目标 URL 由主进程解析：渲染层只提供实例 id，无法指定任意打开地址。
        // http/https 直接打开远程端点；本机实例打开带 token 的就绪 URL（token 不经渲染层）。
        let url: string
        if (instance.transport === 'http') {
          url = httpDirectEndpoint(instance)
        } else if (instance.transport === 'local') {
          // 外部接管的实例用已验证的访问地址；hub 托管的实例用就绪 URL（含 BrowserAuth token）。
          const savedAccess = externalAccessUrls.get(instanceId)
          const resolved = savedAccess?.url ?? deps.runtime.urlOf(instanceId)
          if (!resolved) {
            throw new InstanceStoreError('invalid-state', '实例未在运行，无法在浏览器中打开')
          }
          url = resolved
        } else {
          throw new InstanceStoreError('invalid-input', '只有本机实例和远程实例支持在浏览器中打开')
        }
        if (!deps.openExternalUrl) {
          throw new InstanceStoreError('internal', '在浏览器中打开不可用')
        }
        await deps.openExternalUrl(url)
        return null
      })
  )

  ipcMain.handle(
    INSTANCE_RUNTIME_IPC.probeLocalDsh,
    (): Promise<IpcResult<LocalLauncherSnapshot[]>> =>
      wrap(async () => {
        const launchers = await Promise.all(
          LAUNCHERS.map(async (launcher) => {
            const found = deps.pathProbe?.probeLauncher
              ? await deps.pathProbe.probeLauncher(launcher)
              : launcher === 'dsh'
                ? await deps.pathProbe?.probe()
                : null
            return found ? { launcher, version: found.version } : null
          })
        )
        return launchers.filter((snapshot): snapshot is LocalLauncherSnapshot => snapshot !== null)
      })
  )

  ipcMain.handle(
    INSTANCE_RUNTIME_IPC.scanExternal,
    (): Promise<IpcResult<ExternalDshWebSnapshot[]>> =>
      wrap(async () => {
        // 无参数:渲染层指定不了探测目标(只读 ps+lsof,不做任何写入)
        if (!deps.externalDshScanner) return []
        const found = await deps.externalDshScanner.scan()
        // 只暴露 UI 需要的字段,并限制条数(避免异常环境下列表爆炸)
        return found.slice(0, 10).map((item) => ({
          pid: item.pid,
          port: item.port,
          patch: item.patch,
          command: item.command
        }))
      })
  )

  ipcMain.handle(
    INSTANCE_RUNTIME_IPC.adoptExternal,
    (_event, id: unknown, pid: unknown, access: unknown): Promise<IpcResult<null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const targetPid = z.number().int().positive().parse(pid)
        const instance = await requireInstance(store, instanceId)
        if (instance.transport !== 'local') {
          throw new InstanceStoreError('invalid-input', '只有本地实例才能接管本机 dsh web')
        }
        if (!deps.externalDshScanner) {
          throw new InstanceStoreError('invalid-state', SCANNER_UNAVAILABLE)
        }
        // 关键:端口/patch **不采信渲染层** —— 重新扫描并按 pid 认定,
        // 渲染层无法借这个通道让 hub 去连任意地址
        const found = await deps.externalDshScanner.scan()
        const match = found.find((item) => item.pid === targetPid)
        if (!match) {
          throw new InstanceStoreError('not-found', notFoundDshPid(targetPid))
        }
        if (match.port === null) {
          throw new InstanceStoreError('invalid-state', LISTEN_PORT_UNDETERMINED)
        }
        const previousAccess = externalAccessUrls.get(instanceId)
        const previousToken = deps.vault.getExternalAccessToken(instanceId)
        const currentRuntime = deps.runtime.statusOf(instanceId)
        const replacingExternal = deps.runtime.runningIds().includes(instanceId)
        if (replacingExternal && currentRuntime?.runtimeSource !== 'external') {
          throw new InstanceStoreError('invalid-state', '实例已在运行，不能接管其他本机 dsh web')
        }
        const rawAccess = typeof access === 'string' ? access.trim() : ''
        const usingStoredToken = rawAccess === ''
        const token = usingStoredToken ? previousToken : externalAccessToken(access, match.port)
        if (!token)
          throw new InstanceStoreError(
            'invalid-state',
            '本机 dsh 需要访问 token，请在实例详情中更新'
          )
        const accessUrl = externalAccessUrl(token, match.port)
        if (!(await (deps.verifyExternalAccess ?? defaultVerifyExternalAccess)(accessUrl))) {
          if (usingStoredToken) await deps.vault.forgetExternalAccessToken(instanceId)
          throw new InstanceStoreError('invalid-state', EXTERNAL_ACCESS_TOKEN_INVALID)
        }
        // 先持久化新 token，再拆除旧接管；持久化失败时当前可用会话完全不受影响。
        if (!usingStoredToken) await deps.vault.rememberExternalAccessToken(instanceId, token)
        try {
          if (replacingExternal) await deps.runtime.stop(instanceId)
          await deps.runtime.adopt(instance, {
            pid: match.pid,
            port: match.port,
            patch: match.patch
          })
          externalAccessUrls.set(instanceId, { pid: match.pid, port: match.port, url: accessUrl })
        } catch (error) {
          externalAccessUrls.delete(instanceId)
          await deps.runtime.stop(instanceId).catch(() => undefined)
          // 恢复旧 token 与已接管的用户进程，避免失败操作毁掉先前可用的会话。
          if (!usingStoredToken) {
            if (previousToken)
              await deps.vault
                .rememberExternalAccessToken(instanceId, previousToken)
                .catch(() => undefined)
            else await deps.vault.forgetExternalAccessToken(instanceId).catch(() => undefined)
          }
          if (previousAccess) {
            await deps.runtime
              .adopt(instance, {
                pid: previousAccess.pid,
                port: previousAccess.port,
                patch: null,
                url: previousAccess.url
              })
              .catch(() => undefined)
            externalAccessUrls.set(instanceId, previousAccess)
          }
          throw error
        }
        deps.audit?.({ instanceId, event: 'connect', result: 'adopt-external' })
        return null
      })
  )

  ipcMain.handle(
    INSTANCE_RUNTIME_IPC.updateViewBounds,
    (_event, bounds: unknown): Promise<IpcResult<null>> =>
      wrap(() => {
        const parsed = WorkspaceViewBoundsSchema.parse(bounds)
        deps.setInstanceViewBounds?.(parsed)
        return null
      })
  )

  ipcMain.handle(
    INSTANCE_RUNTIME_IPC.showTooltip,
    (_event, tooltip: unknown): Promise<IpcResult<null>> =>
      wrap(async () => {
        const parsed = WorkspaceTooltipSchema.parse(tooltip)
        await deps.showInstanceTooltip?.(parsed)
        return null
      })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.hideTooltip, (): Promise<IpcResult<null>> =>
    wrap(() => {
      deps.hideInstanceTooltip?.()
      return null
    })
  )

  ipcMain.handle(INSTANCE_RUNTIME_IPC.hideView, (): Promise<IpcResult<null>> =>
    wrap(() => {
      // 任何隐藏操作都取消尚未完成的 openView，防止迟到请求重新激活原生视图。
      workspaceTargetId = null
      deps.hideInstanceTooltip?.()
      deps.hideInstanceView?.()
      return null
    })
  )

  ipcMain.handle(
    INSTANCE_RUNTIME_IPC.disconnectView,
    (_event, id: unknown): Promise<IpcResult<null>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        await requireInstance(store, instanceId)
        if (workspaceTargetId === instanceId) workspaceTargetId = null
        deps.hideInstanceTooltip?.()
        deps.closeInstanceView?.(instanceId)
        return null
      })
  )
}
