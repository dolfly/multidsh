/**
 *
 * - 数据文件 `<registryDir>/instances.json`；写入 = 临时文件 + rename（原子）；
 * - 每次改动前滚动 `.bak-<ts>`（保留 bakRetention 份，默认 20）；
 * - schema 校验（zod，见 contracts.ts）+ 迁移钩子 + 损坏自愈（隔离到 .corrupt-<ts> 后重生）。
 *
 * 所有变更经内部串行队列执行，避免并发交错落盘。
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  CreateInstanceInputSchema,
  formatZodIssues,
  HttpInstanceSchema,
  InstanceRecordSchema,
  LocalInstanceSchema,
  PatchInstanceSchema,
  REGISTRY_SCHEMA_VERSION,
  RegistryFileSchema,
  SshInstanceSchema,
  splitSshHostPort,
  type CreateInstanceInput,
  type CreateInstanceParams,
  type InstanceRecord,
  type IpcErrorCode,
  type PatchInstanceInput,
  type PatchInstanceParams,
  type RegistryFile,
  type RegistryMigration,
  type Transport
} from '@shared/contracts'
import { parseEndpointUrl } from '@shared/endpoint'

const FILE_NAME = 'instances.json'
const BAK_PREFIX = `${FILE_NAME}.bak-`
const CORRUPT_PREFIX = `${FILE_NAME}.corrupt-`

/**
 * 注册表含用户实例清单（名称 / 主机 / 用户名 / 远端 URL / 备注），
 * 与审计日志（`audit-log.ts`）、设置（`settings-store.ts`）一致按 0600 落盘，
 * 共享机器上不对同机其他用户可读。三处写盘 + 隔离副本统一走此常量。
 */
const FILE_MODE = 0o600

/** IPC 错误码子集：注册表错误与装配缺失统一映射到 IpcResult 信封（单一定义在 @shared/contracts）。 */
export type StoreErrorCode = IpcErrorCode

export class InstanceStoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string) {
    super(message)
    this.name = 'InstanceStoreError'
    this.code = code
  }
}

/** 按 id 查不到实例时的统一 not-found 错误；registry 与各 IPC handler 共用同一文案。 */
export function instanceNotFoundError(id: string): InstanceStoreError {
  return new InstanceStoreError('not-found', `实例不存在：${id}`)
}

/** 取实例，查不到即抛 not-found；收敛各 handler 的「get + 空值守卫」两行样板。 */
export async function requireInstance(
  store: Pick<InstanceStore, 'get'>,
  id: string
): Promise<InstanceRecord> {
  const instance = await store.get(id)
  if (!instance) throw instanceNotFoundError(id)
  return instance
}

export interface InstanceStoreOptions {
  /** 注册表目录（main 进程传 `<userData>/registry`） */
  dir: string
  /** 迁移表 from-version → 升级一版；默认内置（当前为空）。测试可注入伪造历史 */
  migrations?: Record<number, RegistryMigration>
  /** 滚动备份保留份数 */
  bakRetention?: number
  /** 损坏文件隔离保留份数 */
  corruptRetention?: number
}

export interface InstanceStoreStats {
  fileExists: boolean
  /** 最近一次损坏恢复的时间（epoch ms）；从未恢复为 null */
  lastRecoveryAt: number | null
  bakCount: number
  corruptCount: number
}

export interface InstanceStore {
  list(): Promise<InstanceRecord[]>
  get(id: string): Promise<InstanceRecord | null>
  create(input: CreateInstanceInput): Promise<InstanceRecord>
  update(id: string, patch: PatchInstanceInput): Promise<InstanceRecord>
  remove(id: string): Promise<boolean>
  /** 按给定 ID 列表重排实例顺序；ID 必须与当前注册表完全一致。 */
  reorder(orderedIds: string[]): Promise<InstanceRecord[]>
  stats(): Promise<InstanceStoreStats>
}

export function createInstanceStore(options: InstanceStoreOptions): InstanceStore {
  const dir = options.dir
  const filePath = join(dir, FILE_NAME)
  const migrations = options.migrations ?? {}
  const bakRetention = options.bakRetention ?? 20
  const corruptRetention = options.corruptRetention ?? 5

  let instances: InstanceRecord[] | null = null
  let lastRecoveryAt: number | null = null
  let dirty = false
  let chain: Promise<unknown> = Promise.resolve()

  /** 串行队列：所有读写共享同一互斥链 */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task, task)
    chain = next.catch(() => undefined)
    return next
  }

  async function ensureLoaded(): Promise<void> {
    if (instances) return
    await mkdir(dir, { recursive: true })
    await removeStaleTmpFiles()

    let raw: string | null = null
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        instances = [] // 首次使用：空注册表（必须赋值，否则后续 push 会静默丢失）
        return
      }
      throw toStoreError(error)
    }

    const loaded = await loadRegistryFile(raw)
    instances = loaded.instances
    lastRecoveryAt = loaded.recoveredAt
    // 恢复 / 迁移后需要立即重写归一化文件（自愈落盘：文件回到 schemaVersion=当前 的合法形态）
    dirty = loaded.recoveredAt !== null || loaded.migrated
    if (dirty) await persist(instances ?? [])
  }

  interface LoadResult {
    instances: InstanceRecord[]
    recoveredAt: number | null
    migrated: boolean
  }

  async function loadRegistryFile(raw: string): Promise<LoadResult> {
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      await quarantineCorruptFile('JSON 解析失败')
      return { instances: [], recoveredAt: Date.now(), migrated: false }
    }

    // —— 版本检查与迁移 ——
    const rawVersion = (data as { schemaVersion?: unknown } | null)?.schemaVersion
    const from = typeof rawVersion === 'number' && Number.isInteger(rawVersion) ? rawVersion : 0
    if (from > REGISTRY_SCHEMA_VERSION) {
      // 文件来自更新版本的应用：拒绝降级读取
      await quarantineCorruptFile(
        `schemaVersion=${from} 高于当前 ${REGISTRY_SCHEMA_VERSION}，拒绝降级`
      )
      return { instances: [], recoveredAt: Date.now(), migrated: false }
    }
    for (let v = from; v < REGISTRY_SCHEMA_VERSION; v++) {
      const migrate = migrations[v]
      if (!migrate) {
        await quarantineCorruptFile(`缺少 schemaVersion ${v} → ${v + 1} 的迁移器`)
        return { instances: [], recoveredAt: Date.now(), migrated: false }
      }
      data = migrate(data)
    }

    // —— 最终校验 ——
    let parsed: RegistryFile
    try {
      parsed = RegistryFileSchema.parse(data)
    } catch (error) {
      const reason = error instanceof z.ZodError ? formatZodIssues(error, 200) : String(error)
      await quarantineCorruptFile(`schema 校验失败：${reason}`)
      return { instances: [], recoveredAt: Date.now(), migrated: false }
    }
    return {
      instances: parsed.instances,
      recoveredAt: null,
      migrated: from !== REGISTRY_SCHEMA_VERSION
    }
  }

  /** 把损坏文件移出主路径，并修剪隔离副本数量 */
  async function quarantineCorruptFile(reason: string): Promise<void> {
    const target = join(dir, `${CORRUPT_PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}`)
    try {
      await rename(filePath, target)
      // rename 保留**源文件**的权限位：既有 0644 的旧注册表被隔离后仍是 0644，
      // 故需显式收紧（Finding 2），否则隔离副本会把清单继续暴露给同机其他用户。
      //
      // 仍向上抛，load() 会整体失败、注册表直接不可用 —— 为「锦上添花的权限收紧」
      // 赔上可用性是不划算的。失败只告警，隔离本身视为成功。
      try {
        await chmod(target, FILE_MODE)
      } catch (error) {
        console.warn(`[registry] 隔离副本权限收紧失败（不影响隔离本身）：${target}`, error)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw toStoreError(error)
    }
    await pruneByPrefix(CORRUPT_PREFIX, corruptRetention)
    console.warn(`[registry] 注册表损坏已隔离：${reason} → ${target}`)
  }

  /**
   * 磁盘先提交：备份旧文件 → 原子写新文件，全部成功后**才**替换内存缓存。
   */
  async function persist(next: InstanceRecord[]): Promise<void> {
    const data: RegistryFile = { schemaVersion: REGISTRY_SCHEMA_VERSION, instances: next }
    await rollBackup()
    const tmpPath = join(dir, `${FILE_NAME}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
    try {
      // 显式 0600（同 settings-store / audit-log 的写法）；不依赖 umask 的默认 0644
      await writeFile(tmpPath, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: FILE_MODE })
      // 若在 rename 之后 chmod，一旦 chmod 失败，就变成「磁盘已是新内容、内存仍是旧内容」
      // 放在 tmp 上则失败时直接走 catch 清理 tmp、主文件一个字节没动。
      // 另外 rename 装的是**新 inode**（tmp 已是 0600），故目标文件权限天然归一化，
      // 不需要、也不应该再对最终路径补一次 chmod。
      await chmod(tmpPath, FILE_MODE)
      await rename(tmpPath, filePath)
    } catch (error) {
      try {
        await rm(tmpPath, { force: true })
      } catch {
        /* 尽力清理 */
      }
      throw toStoreError(error)
    }
    instances = next
    dirty = false
  }

  async function rollBackup(): Promise<void> {
    let current: Buffer
    try {
      current = await readFile(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return // 首次写盘无旧文件
      throw toStoreError(error)
    }
    try {
      await writeFile(
        join(dir, `${BAK_PREFIX}${Date.now()}-${randomUUID().slice(0, 4)}`),
        current,
        // 备份仍是完整实例清单，同样按 0600 落盘（Finding 2）
        { mode: FILE_MODE }
      )
    } catch (error) {
      throw toStoreError(error)
    }
    await pruneByPrefix(BAK_PREFIX, bakRetention)
  }

  async function pruneByPrefix(prefix: string, retention: number): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    const matches = names
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse()
    for (const name of matches.slice(retention)) {
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  }

  /** 崩溃可能残留 `*.tmp-*`，加载时清掉 */
  async function removeStaleTmpFiles(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith(`${FILE_NAME}.tmp-`)) {
        await rm(join(dir, name), { force: true }).catch(() => undefined)
      }
    }
  }

  // —— 归一化（写盘前的规范化） ——

  function normalizeCreate(input: CreateInstanceParams): CreateInstanceParams {
    if (input.transport === 'ssh') {
      const split = splitSshHostPort(input.host, input.port ?? 22)
      if (split.host === input.host && !split.portEmbedded) return input
      // host:port 组合形式 → 拆分出的端口优先（文档化约定）；
      // 纯方括号剥离 → 只归一化主机形态，端口交给显式 port / 记录默认值
      return split.portEmbedded
        ? { ...input, host: split.host, port: split.port }
        : { ...input, host: split.host }
    }
    if (input.transport === 'http') {
      // 存归一化 baseUrl（去尾斜杠等），判重语义与 isSameEndpoint 一致
      return { ...input, endpointUrl: parseEndpointUrl(input.endpointUrl).baseUrl }
    }
    return input
  }

  function normalizePatch(patch: PatchInstanceParams): PatchInstanceParams {
    // 与 create 语义一致：仅当 host 内真正带 `:port` 时才采用其端口；
    // 方括号剥离只改主机形态，绝不注入默认端口（否则会静默改掉记录里的端口）
    if (patch.host !== undefined) {
      const split = splitSshHostPort(patch.host, patch.port ?? 22)
      if (split.host !== patch.host) {
        return split.portEmbedded
          ? { ...patch, host: split.host, port: split.port }
          : { ...patch, host: split.host }
      }
    }
    if (patch.endpointUrl !== undefined) {
      const parsed = parseEndpointUrl(patch.endpointUrl)
      if (parsed.baseUrl !== patch.endpointUrl.trim()) {
        return { ...patch, endpointUrl: parsed.baseUrl }
      }
    }
    return patch
  }

  function stamp(record: unknown): InstanceRecord {
    return InstanceRecordSchema.parse(record) // 最终完整性校验（含默认值填充），运行期兜底
  }

  function parseOrThrow<T>(parse: () => T): T {
    try {
      return parse()
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new InstanceStoreError('invalid-input', formatZodIssues(error))
      }
      throw error
    }
  }

  function variantSchema(transport: Transport): z.ZodObject<z.ZodRawShape> {
    switch (transport) {
      case 'local':
        return LocalInstanceSchema
      case 'ssh':
        return SshInstanceSchema
      case 'http':
        return HttpInstanceSchema
    }
  }

  /**
   * 把补丁显式合入实例：undefined 表示「不改」、null 表示「清空」。
   * 同时拒绝与实例变体无关的字段（local 实例不许带 ssh/http 专属字段），
   * 避免非 strict 记录 schema 静默剥离跨变体字段。
   */
  function applyPatch(
    current: InstanceRecord,
    patch: PatchInstanceParams
  ): Record<string, unknown> {
    const allowed = new Set(Object.keys(variantSchema(current.transport).shape))
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) {
        throw new InstanceStoreError(
          'invalid-input',
          `字段 ${key} 不适用于 ${current.transport} 实例`
        )
      }
    }
    const merged: Record<string, unknown> = { ...current }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) merged[key] = value
    }
    return merged
  }

  // —— 对外 API ——

  return {
    list: () =>
      enqueue(async () => {
        await ensureLoaded()
        // 返回拷贝，调用方（未来主进程消费者）无法污染缓存
        return (instances ?? []).map((record) => structuredClone(record))
      }),

    get: (id) =>
      enqueue(async () => {
        await ensureLoaded()
        const record = (instances ?? []).find((item) => item.id === id)
        return record ? structuredClone(record) : null
      }),

    create: (input) =>
      enqueue(async () => {
        await ensureLoaded()
        const parsed = parseOrThrow(() => CreateInstanceInputSchema.parse(input))
        const now = new Date().toISOString()
        const record = parseOrThrow(() =>
          stamp({
            ...normalizeCreate(parsed),
            id:
              parsed.transport === 'local' && parsed.existingSpaceId
                ? parsed.existingSpaceId
                : randomUUID(),
            createdAt: now,
            updatedAt: now
          })
        )
        await persist([...(instances ?? []), record])
        return structuredClone(record)
      }),

    update: (id, patch) =>
      enqueue(async () => {
        await ensureLoaded()
        const parsedPatch = parseOrThrow(() => PatchInstanceSchema.parse(patch))
        const current = (instances ?? []).find((record) => record.id === id)
        if (!current) throw instanceNotFoundError(id)
        const record = parseOrThrow(() =>
          stamp({
            ...applyPatch(current, normalizePatch(parsedPatch)),
            updatedAt: new Date().toISOString()
          })
        )
        await persist((instances ?? []).map((item) => (item.id === id ? record : item)))
        return structuredClone(record)
      }),

    remove: (id) =>
      enqueue(async () => {
        await ensureLoaded()
        const current = instances ?? []
        if (!current.some((record) => record.id === id)) return false
        await persist(current.filter((record) => record.id !== id))
        return true
      }),

    reorder: (orderedIds) =>
      enqueue(async () => {
        await ensureLoaded()
        const current = instances ?? []
        // 校验:orderedIds 必须与当前 ID 集合完全一致(不多不少)
        if (orderedIds.length !== current.length) {
          throw new InstanceStoreError(
            'invalid-input',
            `排序列表长度(${orderedIds.length})与实例数量(${current.length})不一致`
          )
        }
        const currentIds = new Set(current.map((r) => r.id))
        for (const id of orderedIds) {
          if (!currentIds.has(id)) {
            throw new InstanceStoreError('invalid-input', `排序列表包含未知实例 ID：${id}`)
          }
        }
        // 重复 id 会让 byId 映射出重复条目并覆盖未列出的实例（注册表数据丢失），必须拒绝。
        if (new Set(orderedIds).size !== orderedIds.length) {
          throw new InstanceStoreError('invalid-input', '排序列表包含重复实例 ID')
        }
        const byId = new Map(current.map((r) => [r.id, r]))
        const reordered = orderedIds.map((id) => byId.get(id)!)
        await persist(reordered)
        return reordered.map((r) => structuredClone(r))
      }),

    stats: () =>
      enqueue(async () => {
        await ensureLoaded()
        let names: string[]
        try {
          names = await readdir(dir)
        } catch {
          names = []
        }
        return {
          fileExists: names.includes(FILE_NAME),
          lastRecoveryAt,
          bakCount: names.filter((name) => name.startsWith(BAK_PREFIX)).length,
          corruptCount: names.filter((name) => name.startsWith(CORRUPT_PREFIX)).length
        }
      })
  }
}

function toStoreError(error: unknown): InstanceStoreError {
  const message = error instanceof Error ? error.message : String(error)
  return new InstanceStoreError('io-error', `注册表 IO 失败：${message}`)
}
