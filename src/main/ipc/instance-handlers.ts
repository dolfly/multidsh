/**
 * 实例注册表与空间通道：CRUD、排序、本地空间回收与 SSH 键/主机指纹提示。
 * 外部接管的访问地址映射由装配层持有并注入，避免跨 registerIpc 调用共享状态。
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  CreateInstanceInputSchema,
  INSTANCE_IPC,
  PatchInstanceSchema,
  SPACE_IPC,
  SSH_IPC,
  SshKeyPreviewInputSchema,
  type HostKeyDecision,
  type InstanceRecord,
  type InstanceRuntimeStatus,
  type InstanceSummary,
  type IpcResult,
  type LocalSpaceSnapshot
} from '@shared/contracts'
import { resolveSshKeyPreview } from '../ssh/key-preview'
import { InstanceStoreError, requireInstance, type InstanceStore } from '../registry/instance-store'
import type { LocalRuntimeManager } from '../local-runtime/local-runtime'
import type { ExternalDshScanner } from '../local-runtime/external-dsh'
import type { SshTunnelManager } from '../transport/ssh-tunnel'
import type { HttpEndpointManager } from '../transport/http-endpoint'
import type { AuthRegistry } from '../auth/auth-registry'
import type { PromptBroker } from '../ssh/prompt-broker'
import type { Vault } from '../vault/vault'
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
  toSummary,
  type ExternalAccessUrls,
  type IpcWrap
} from './ipc-utils'

export interface InstanceHandlerDeps {
  runtime: LocalRuntimeManager
  tunnels: SshTunnelManager
  http: HttpEndpointManager
  auth: AuthRegistry
  vault: Vault
  promptBroker: PromptBroker
  externalDshScanner?: ExternalDshScanner
  verifyExternalAccess?: (url: string) => Promise<boolean>
  clearPartitionSession?: (instanceId: string) => Promise<void>
  listLocalSpaces?: () => Promise<Array<{ id: string; sizeBytes: number; modifiedAt: string }>>
  trashLocalSpace?: (instanceId: string) => Promise<void>
  localHomePath?: (record: InstanceRecord) => string
  /** 在系统文件管理器中打开本机实例的数据目录（DSH_HOME）；主进程按实例解析路径。 */
  openInstanceDir?: (record: InstanceRecord) => Promise<void>
  /** 在系统文件管理器中打开本机实例的日志目录；主进程按实例解析路径。 */
  openInstanceLogDir?: (record: InstanceRecord) => Promise<void>
  hideInstanceView?: () => void
}

export function registerInstanceHandlers(
  store: InstanceStore,
  deps: InstanceHandlerDeps,
  externalAccessUrls: ExternalAccessUrls,
  wrap: IpcWrap
): void {
  // —— 实例注册表 CRUD ——

  function statusFor(record: InstanceRecord): InstanceRuntimeStatus | undefined {
    return record.transport === 'ssh'
      ? deps.tunnels.statusOf(record.id)?.status
      : record.transport === 'http'
        ? deps.http.statusOf(record.id)?.status
        : deps.runtime.statusOf(record.id)?.status
  }

  /** 运行中的 dsh 版本（本机实例才有；停止后为 undefined，由 toSummary 回落到注册表 dshVersion）。 */
  function versionFor(record: InstanceRecord): string | undefined {
    return record.transport === 'local' ? deps.runtime.statusOf(record.id)?.version : undefined
  }

  ipcMain.handle(INSTANCE_IPC.list, (): Promise<IpcResult<InstanceSummary[]>> =>
    wrap(() =>
      store
        .list()
        .then((records) =>
          records.map((record) =>
            toSummary(record, statusFor(record), deps.localHomePath?.(record), versionFor(record))
          )
        )
    )
  )

  ipcMain.handle(
    INSTANCE_IPC.get,
    (_event, id: unknown): Promise<IpcResult<InstanceRecord | null>> =>
      wrap(() => store.get(parseId(id)))
  )

  async function localSpaces(): Promise<LocalSpaceSnapshot[]> {
    if (!deps.listLocalSpaces)
      throw new InstanceStoreError('invalid-state', '本机隔离空间管理不可用')
    const records = await store.list()
    const localsById = new Map(
      records
        .filter((record) => record.transport === 'local')
        .map((record) => [record.id, record.name])
    )
    return (await deps.listLocalSpaces())
      .map((space) => ({
        ...space,
        inUse: localsById.has(space.id),
        instanceName: localsById.get(space.id) ?? null
      }))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
  }

  ipcMain.handle(SPACE_IPC.list, (): Promise<IpcResult<LocalSpaceSnapshot[]>> => wrap(localSpaces))

  ipcMain.handle(SPACE_IPC.trash, (_event, id: unknown): Promise<IpcResult<{ trashed: boolean }>> =>
    wrap(async () => {
      const instanceId = parseId(id)
      const space = (await localSpaces()).find((item) => item.id === instanceId)
      if (!space) throw new InstanceStoreError('not-found', '找不到该本机隔离空间')
      if (space.inUse)
        throw new InstanceStoreError('invalid-state', '该隔离空间正被实例占用，无法删除')
      if (!deps.trashLocalSpace)
        throw new InstanceStoreError('invalid-state', '本机隔离空间管理不可用')
      await deps.trashLocalSpace(instanceId)
      return { trashed: true }
    })
  )

  ipcMain.handle(
    INSTANCE_IPC.create,
    (_event, input: unknown): Promise<IpcResult<InstanceRecord>> =>
      wrap(async () => {
        const parsed = CreateInstanceInputSchema.parse(input)
        if (parsed.transport !== 'local') return store.create(parsed)
        if (parsed.existingSpaceId) {
          const space = (await localSpaces()).find((item) => item.id === parsed.existingSpaceId)
          if (!space) throw new InstanceStoreError('not-found', '找不到该本机隔离空间')
          if (space.inUse)
            throw new InstanceStoreError('invalid-state', '该隔离空间正被实例占用，无法删除')
        }
        const { useExistingExternal, externalPid, externalAccess, ...recordInput } = parsed
        if (useExistingExternal !== true) return store.create(recordInput)
        if (!deps.externalDshScanner)
          throw new InstanceStoreError('invalid-state', SCANNER_UNAVAILABLE)
        const pid = z.number().int().positive().parse(externalPid)
        const found = await deps.externalDshScanner.scan()
        const match = found.find((item) => item.pid === pid)
        if (!match) throw new InstanceStoreError('not-found', notFoundDshPid(pid))
        if (match.port === null)
          throw new InstanceStoreError('invalid-state', LISTEN_PORT_UNDETERMINED)
        const token = externalAccessToken(externalAccess, match.port)
        const accessUrl = externalAccessUrl(token, match.port)
        if (!(await (deps.verifyExternalAccess ?? defaultVerifyExternalAccess)(accessUrl))) {
          throw new InstanceStoreError('invalid-state', EXTERNAL_ACCESS_TOKEN_INVALID)
        }
        const record = await store.create({ ...recordInput, port: match.port })
        if (record.transport !== 'local') throw new Error('本机实例创建结果无效')
        try {
          await deps.vault.rememberExternalAccessToken(record.id, token)
          await deps.runtime.adopt(record, { pid: match.pid, port: match.port, patch: match.patch })
          externalAccessUrls.set(record.id, { pid: match.pid, port: match.port, url: accessUrl })
          return record
        } catch (error) {
          // 创建外部接管实例是单个用例：后续安全存储或运行时接管失败时不能留下不可见孤儿记录。
          externalAccessUrls.delete(record.id)
          await deps.runtime.stop(record.id).catch(() => undefined)
          await deps.vault.forgetExternalAccessToken(record.id).catch(() => undefined)
          await store.remove(record.id).catch(() => undefined)
          throw error
        }
      })
  )

  ipcMain.handle(
    INSTANCE_IPC.update,
    (_event, id: unknown, patch: unknown): Promise<IpcResult<InstanceRecord>> =>
      wrap(() => store.update(parseId(id), PatchInstanceSchema.parse(patch)))
  )

  ipcMain.handle(
    INSTANCE_IPC.delete,
    (_event, id: unknown, options: unknown): Promise<IpcResult<{ removed: boolean }>> =>
      wrap(async () => {
        const instanceId = parseId(id)
        const deleteOptions = z
          .object({ trashSpace: z.boolean().default(false) })
          .strict()
          .parse(options ?? {})
        // 详情页文案承诺「删除运行中的实例会先停止其进程」:先回收进程树再移除记录,
        // 否则 dsh/ssh 进程继续存活(独占端口与 DSH_HOME),窗口也无 stopped 事件可回收
        const record = await store.get(instanceId)
        // 实例不存在：不做任何副作用就返回。否则会隐藏用户当前打开的工作区并按该 id 清理凭据。
        if (record === null) return { removed: false }
        externalAccessUrls.delete(instanceId)
        // 停止传输层：进程/隧道/端点回收必须在移除记录前完成，失败要如实上报（不能留孤儿）。
        if (record.transport === 'ssh') await deps.tunnels.stop(instanceId)
        else if (record.transport === 'http') await deps.http.stop(instanceId)
        else if (record.transport === 'local') await deps.runtime.stop(instanceId)
        // 移入废纸篓是用户显式请求：失败必须上报（避免界面显示已删而磁盘数据仍在）。
        if (deleteOptions.trashSpace && record.transport === 'local' && !record.useDefaultSpace) {
          if (!deps.trashLocalSpace)
            throw new InstanceStoreError('invalid-state', '本机隔离空间管理不可用')
          await deps.trashLocalSpace(instanceId)
        }
        deps.hideInstanceView?.()
        deps.auth.forget(instanceId)
        // 凭据/分区会话清理是尽力而为：单步失败只留痕，绝不阻断实例记录移除 ——
        // 否则 vault 落盘（Windows 上可能因文件占用/权限偶发失败）会让用户「删不掉实例」。
        await deps.vault
          .forgetExternalAccessToken(instanceId)
          .catch((error: unknown) =>
            console.error('[ipc] 删除时忘记外部访问 token 失败：', instanceId, error)
          )
        await deps.vault
          .forgetInstance(instanceId)
          .catch((error: unknown) =>
            console.error('[ipc] 删除时清理保险库条目失败：', instanceId, error)
          )
        await deps.clearPartitionSession?.(instanceId).catch(() => undefined)
        return { removed: await store.remove(instanceId) }
      })
  )

  ipcMain.handle(
    INSTANCE_IPC.reorder,
    (_event, orderedIds: unknown): Promise<IpcResult<InstanceSummary[]>> =>
      wrap(async () => {
        if (!Array.isArray(orderedIds)) {
          throw new InstanceStoreError('invalid-input', '排序列表必须是字符串数组')
        }
        const ids = orderedIds.map((id) => parseId(id))
        const records = await store.reorder(ids)
        return records.map((record) =>
          toSummary(record, statusFor(record), deps.localHomePath?.(record), versionFor(record))
        )
      })
  )

  async function requireLocalRecord(id: unknown): Promise<InstanceRecord> {
    const record = await requireInstance(store, parseId(id))
    if (record.transport !== 'local') {
      throw new InstanceStoreError('invalid-input', '仅本机实例有本地目录')
    }
    return record
  }

  ipcMain.handle(
    INSTANCE_IPC.openDirectory,
    (_event, id: unknown): Promise<IpcResult<{ opened: boolean }>> =>
      wrap(async () => {
        const record = await requireLocalRecord(id)
        if (!deps.openInstanceDir)
          throw new InstanceStoreError('invalid-state', '打开实例目录不可用')
        await deps.openInstanceDir(record)
        return { opened: true }
      })
  )

  ipcMain.handle(
    INSTANCE_IPC.openLogDirectory,
    (_event, id: unknown): Promise<IpcResult<{ opened: boolean }>> =>
      wrap(async () => {
        const record = await requireLocalRecord(id)
        if (!deps.openInstanceLogDir)
          throw new InstanceStoreError('invalid-state', '打开日志目录不可用')
        await deps.openInstanceLogDir(record)
        return { opened: true }
      })
  )

  ipcMain.handle(SSH_IPC.keyPreview, (_event, input: unknown) =>
    wrap(() => {
      const parsed = SshKeyPreviewInputSchema.parse(input)
      return resolveSshKeyPreview({
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        identityFile: parsed.identityFile ?? null
      })
    })
  )

  ipcMain.handle(
    SSH_IPC.hostKeyReply,
    (_event, requestId: unknown, decision: unknown): Promise<IpcResult<null>> =>
      wrap(() => {
        const id = z.uuid().parse(requestId)
        const value = z.enum(['trust', 'reject']).parse(decision) as HostKeyDecision
        deps.promptBroker.replyHostKey(id, value)
        return null
      })
  )

  ipcMain.handle(SSH_IPC.hostKeyForget, (_event, input: unknown): Promise<IpcResult<null>> =>
    wrap(async () => {
      // 只有用户主动「忘记该主机指纹」后,下一次连接才会重新走首次 TOFU 确认。
      const parsed = z.object({ instanceId: z.uuid() }).parse(input)
      const instance = await requireInstance(store, parsed.instanceId)
      if (instance.transport !== 'ssh') {
        throw new InstanceStoreError('invalid-input', '只有 SSH 隧道实例才有主机指纹')
      }
      await deps.tunnels.forgetHostKey(instance)
      return null
    })
  )

  ipcMain.handle(
    SSH_IPC.askpassReply,
    (_event, requestId: unknown, secret: unknown): Promise<IpcResult<null>> =>
      wrap(() => {
        const id = z.uuid().parse(requestId)
        // 空串不是有效口令(UI 已 disabled,IPC 边界同样拒绝)
        const value = z
          .string()
          .max(4096)
          .nullable()
          .refine((v) => v === null || v.trim() !== '', '口令不能为空串')
          .parse(secret)
        deps.promptBroker.replyAskpass(id, value)
        return null
      })
  )
}
