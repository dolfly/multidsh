/**
 * 凭据保险库 —— 不 import Electron：加密后端由调用方注入
 * （生产为 electron `safeStorage`,测试为可控假实现）。
 *
 *  | 存储项 | 默认 | 可选 |
 *  |---|---|---|
 *  | 网关密码 | 用户确认登录后默认保存 | 取消「记住密码」 |
 *  | 会话 Cookie `dsh_auth` | 默认保存 | 取消「复用会话」 |
 *  | TOTP 密钥 | **永不存储**(密钥在用户认证器里) | — |
 *
 * 硬性约定:
 * 1. **只有显式调用才会落盘**;没有 `remember*` 就没有条目;
 * 2. 落盘内容一律经 `crypto.encrypt`(safeStorage → OS 钥匙串密钥加密),
 *    文件权限 0600,原子写(tmp + rename);
 * 3. `safeStorage` 不可用(如 Linux 无 keyring)时**降级为纯内存模式**:
 *    不写文件、`status().degraded === true`,由调用方在 UI 告警 + 审计
 *    `vault-unavailable`;**绝不退化成明文落盘**;
 * 4. 解密失败(钥匙串变更/文件被改)视为该条目不可用:丢弃该字段并上报,
 *    不影响其它字段与其它实例;
 * 5. 凭据永不进日志/审计 —— 本模块不 import 任何日志设施,只经 `onError`
 *    上报错误对象(调用方负责不把密文/明文写进日志)。
 *
 * 它与「记住了什么」共享同一生命周期 —— 一键清除必须同时停止「继续记住」,
 * 否则清空后下一次登录又会把凭据写回来。因此策略与条目放在同一文件(顶层
 * `policy` 段,明文、非敏感),`clearAll`/`forgetInstance` 一并清掉。
 * 降级模式不落盘:此时复选框本就无意义(钥匙串不可用,什么也记不住)。
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { DEFAULT_VAULT_POLICY } from '@shared/contracts'
import type { VaultPolicy as SharedVaultPolicy } from '@shared/contracts'

/** 加密后端(生产:`electron.safeStorage`) */
export interface VaultCrypto {
  /** 系统加密是否可用;false 即降级为内存模式 */
  isAvailable(): boolean
  /** 明文 → 可落盘字符串(通常 base64) */
  encrypt(plain: string): string
  /** 落盘字符串 → 明文;失败应抛 */
  decrypt(payload: string): string
}

/** 持久化的会话 Cookie(与 AuthClient 内存态同构) */
export interface StoredSession {
  name: string
  value: string
  expiresAt: number | null
}

export interface VaultOptions {
  /** 落盘路径(通常 `<userData>/vault/credentials.json`) */
  filePath: string
  crypto: VaultCrypto
  /** 失败上报(默认 console.error);只上报 Error,**不要**把明文/密文带进来 */
  onError?: (error: unknown) => void
}

export interface VaultStatus {
  /** 系统加密可用 */
  available: boolean
  /** 是否处于降级(纯内存)模式 */
  degraded: boolean
  /** 已记住条目的实例数 */
  instanceCount: number
}

export interface Vault {
  status(): VaultStatus
  hasPassword(instanceId: string): boolean
  rememberPassword(instanceId: string, password: string): Promise<void>
  getPassword(instanceId: string): string | null
  forgetPassword(instanceId: string): Promise<void>

  /** 外部本机 dsh 的 BrowserAuth token；始终加密存储，不复用网关密码字段。 */
  hasExternalAccessToken(instanceId: string): boolean
  rememberExternalAccessToken(instanceId: string, token: string): Promise<void>
  getExternalAccessToken(instanceId: string): string | null
  forgetExternalAccessToken(instanceId: string): Promise<void>

  hasSession(instanceId: string): boolean
  rememberSession(instanceId: string, session: StoredSession): Promise<void>
  getSession(instanceId: string): StoredSession | null
  forgetSession(instanceId: string): Promise<void>

  /** 读取勾选策略(未设置即「都不记住」) */
  getPolicy(instanceId: string): VaultPolicy
  /** 写入勾选策略 */
  setPolicy(instanceId: string, policy: VaultPolicy): Promise<void>

  /** 清掉某实例的全部条目(删除实例时调用) */
  forgetInstance(instanceId: string): Promise<void>
  clearAll(): Promise<void>
  /** 已记住条目的实例 id(自检/测试) */
  rememberedIds(): string[]
  /**
   * **已设置策略**的实例 id。
   *
   * 与 `rememberedIds` 刻意分开:用户可能先勾选「记住密码」、下一次登录才真正写入凭据,
   * 此期间策略已设但条目为空。UI 若按「有条目」下发策略,复选框会显示未勾选,
   */
  policyIds(): string[]
}

export { DEFAULT_VAULT_POLICY } from '@shared/contracts'
export type VaultPolicy = SharedVaultPolicy

/** 落盘格式(版本化,便于后续迁移) */
interface VaultItem {
  password?: string
  /** 外部本机 dsh BrowserAuth token 的密文。 */
  externalAccessToken?: string
  session?: string
}
interface VaultFile {
  version: 1
  items: Record<string, VaultItem>
  policy?: Record<string, VaultPolicy>
}

function isVaultFile(value: unknown): value is VaultFile {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<VaultFile>
  return candidate.version === 1 && typeof candidate.items === 'object' && candidate.items !== null
}

const DISABLED_VAULT_POLICY: VaultPolicy = {
  rememberPassword: false,
  rememberSession: false
}

function normalizePolicy(value: unknown): VaultPolicy {
  if (typeof value !== 'object' || value === null) return { ...DISABLED_VAULT_POLICY }
  const candidate = value as Partial<VaultPolicy>
  return {
    rememberPassword: candidate.rememberPassword === true,
    rememberSession: candidate.rememberSession === true
  }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<StoredSession>
  return typeof candidate.name === 'string' && typeof candidate.value === 'string'
}

export function createVault(options: VaultOptions): Vault {
  const onError =
    options.onError ?? ((error: unknown) => console.error('[vault] 操作失败：', error))
  const crypto = options.crypto
  // 可用性在创建时确定(与 electron safeStorage 一致:启动后不变)
  const available = crypto.isAvailable()

  /**
   * 条目表。可用时存放**密文**(经 crypto.encrypt);降级模式下存放**明文**,
   * 但降级模式永不落盘(见 persist),因此明文不会离开进程内存。
   */
  const items = new Map<string, VaultItem>()
  const policy = new Map<string, VaultPolicy>()
  let loaded = false

  function load(): void {
    if (loaded) return
    loaded = true
    if (!available) return
    if (!existsSync(options.filePath)) return
    try {
      const parsed: unknown = JSON.parse(readFileSync(options.filePath, 'utf8'))
      if (!isVaultFile(parsed)) {
        onError(new Error('vault 文件格式不符,已忽略'))
        return
      }
      for (const [id, raw] of Object.entries(parsed.items)) {
        if (typeof raw !== 'object' || raw === null) continue
        const entry: VaultItem = {}
        if (typeof raw.password === 'string') entry.password = raw.password
        if (typeof raw.externalAccessToken === 'string')
          entry.externalAccessToken = raw.externalAccessToken
        if (typeof raw.session === 'string') entry.session = raw.session
        if (
          entry.password !== undefined ||
          entry.externalAccessToken !== undefined ||
          entry.session !== undefined
        ) {
          items.set(id, entry)
        }
      }
      for (const [id, raw] of Object.entries(parsed.policy ?? {})) {
        policy.set(id, normalizePolicy(raw))
      }
    } catch (error) {
      quarantineCorruptFile(error)
    }
  }

  /**
   * 凭据文件被截断或拼接损坏时,每次读(`status`/`getPolicy` 都会触发 load)都会重复
   * JSON.parse 报错,且 vault 永远起不来。解析失败 → 把坏文件**隔离改名**
   * (corrupt-<时间戳>),内存从空开始,下一次显式写入(persist)会写出干净文件 ——
   * 与 registry 的「损坏自愈」同一口径。隔离是纯文件级操作,不读写内容,凭据纪律无涉。
   */
  function quarantineCorruptFile(error: unknown): void {
    onError(error)
    try {
      const path = options.filePath
      if (!existsSync(path)) return
      const quarantined = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
      renameSync(path, quarantined)
      console.error(`[vault] 凭据文件损坏,已隔离到 ${quarantined}(内容从空重建)`)
    } catch (renameError) {
      onError(renameError)
    }
  }

  /**
   * 「登录态写入」与「策略写入/密码写入」并发时 write→rename 交错,
   * 第二个 rename 拿不到已被别人挪走的 .tmp → ENOENT;更糟的交错会把半份内容
   * rename 成正式文件 → JSON.parse 损坏。现在:
   * ① 每次 persist 使用**唯一 tmp 名**(.tmp-<随机>),写入互不覆盖;
   * ② 全部 persist 经**串行队列**链式执行,落盘顺序与调用顺序一致。
   */
  let persistQueue: Promise<void> = Promise.resolve()
  let tmpSeq = 0

  function serializePayload(): string {
    const payload: VaultFile = { version: 1, items: {}, policy: {} }
    for (const [id, entry] of items) {
      const next: VaultItem = {}
      if (entry.password !== undefined) next.password = entry.password
      if (entry.externalAccessToken !== undefined)
        next.externalAccessToken = entry.externalAccessToken
      if (entry.session !== undefined) next.session = entry.session
      if (
        next.password !== undefined ||
        next.externalAccessToken !== undefined ||
        next.session !== undefined
      ) {
        payload.items[id] = next
      }
    }
    for (const [id, value] of policy) {
      if (
        value.rememberPassword !== DEFAULT_VAULT_POLICY.rememberPassword ||
        value.rememberSession !== DEFAULT_VAULT_POLICY.rememberSession
      ) {
        payload.policy![id] = value
      }
    }
    return `${JSON.stringify(payload)}\n`
  }

  /** 降级模式只留内存:退化成明文落盘是不可接受的 */
  async function persist(): Promise<void> {
    if (!available) return
    const run = persistQueue.then(async () => {
      const path = options.filePath
      await mkdir(dirname(path), { recursive: true })
      tmpSeq += 1
      const tmp = `${path}.tmp-${process.pid}-${tmpSeq}`
      try {
        await writeFile(tmp, serializePayload(), { mode: 0o600 })
        await rename(tmp, path)
      } catch (error) {
        // 写失败要清掉本次的 tmp,避免残留物堆积(rename ENOENT 时文件可能已被挪走)
        await rm(tmp, { force: true })
        throw error
      }
    })
    // 队列容错:单次失败不阻断后续写入(调用方各自拿到自己的成功/失败)
    persistQueue = run.catch(() => undefined)
    return run
  }

  /**
   * 显式勾选才允许落盘（默认不存、显式勾选）。
   * 在模块内强制而非依赖调用方约定 —— 少一处调用方疏漏就少一条凭据落盘路径。
   */
  function requireOptIn(instanceId: string, field: keyof VaultPolicy): void {
    if (!(policy.get(instanceId) ?? DEFAULT_VAULT_POLICY)[field]) {
      throw new Error(`未勾选「${field}」,拒绝写入 vault`)
    }
  }

  function entryFor(instanceId: string): VaultItem {
    const existing = items.get(instanceId)
    if (existing) return existing
    const created: VaultItem = {}
    items.set(instanceId, created)
    return created
  }

  function dropIfEmpty(instanceId: string): void {
    const entry = items.get(instanceId)
    if (
      entry &&
      entry.password === undefined &&
      entry.externalAccessToken === undefined &&
      entry.session === undefined
    ) {
      items.delete(instanceId)
    }
  }

  /**
   * 解密单个字段;失败即丢弃该字段(钥匙串变更/文件被篡改)。
   *
   * 那是并发不可控的副作用(单测在并行负载下会偶发失败),而且读操作本就不该有写副作用。
   */
  function readField(instanceId: string, payload: string): string | null {
    if (!available) return payload // 降级模式条目本就是明文
    try {
      return crypto.decrypt(payload)
    } catch (error) {
      onError(error)
      const entry = items.get(instanceId)
      if (entry?.password === payload) delete entry.password
      if (entry?.externalAccessToken === payload) delete entry.externalAccessToken
      if (entry?.session === payload) delete entry.session
      dropIfEmpty(instanceId)
      return null
    }
  }

  /** 写入字段:降级模式下存明文(内存),可用时存密文 */
  function encode(value: string): string {
    return available ? crypto.encrypt(value) : value
  }

  /** 条目中可单独读写或遗忘的字段名。 */
  type VaultField = keyof VaultItem

  /** 字段是否已存;与 get* 同口径,读前先 load。 */
  function hasField(instanceId: string, field: VaultField): boolean {
    load()
    return items.get(instanceId)?.[field] !== undefined
  }

  /** 遗忘单个字段并回写;条目因此变空时一并从内存移除。 */
  async function forgetField(instanceId: string, field: VaultField): Promise<void> {
    load()
    const entry = items.get(instanceId)
    if (!entry) return
    delete entry[field]
    dropIfEmpty(instanceId)
    await persist()
  }

  /** 读取并解密单个字段;字段未存或解密失败都返回 null。 */
  function readStored(instanceId: string, field: VaultField): string | null {
    load()
    const payload = items.get(instanceId)?.[field]
    return payload === undefined ? null : readField(instanceId, payload)
  }

  return {
    status() {
      load()
      return { available, degraded: !available, instanceCount: items.size }
    },

    hasPassword(instanceId) {
      return hasField(instanceId, 'password')
    },

    async rememberPassword(instanceId, password) {
      if (password === '') throw new Error('空密码不写入 vault')
      load()
      requireOptIn(instanceId, 'rememberPassword')
      entryFor(instanceId).password = encode(password)
      await persist()
    },

    getPassword(instanceId) {
      return readStored(instanceId, 'password')
    },

    async forgetPassword(instanceId) {
      await forgetField(instanceId, 'password')
    },

    hasExternalAccessToken(instanceId) {
      return hasField(instanceId, 'externalAccessToken')
    },

    async rememberExternalAccessToken(instanceId, token) {
      if (token === '') throw new Error('空访问 token 不写入 vault')
      load()
      entryFor(instanceId).externalAccessToken = encode(token)
      await persist()
    },

    getExternalAccessToken(instanceId) {
      return readStored(instanceId, 'externalAccessToken')
    },

    async forgetExternalAccessToken(instanceId) {
      await forgetField(instanceId, 'externalAccessToken')
    },

    hasSession(instanceId) {
      return hasField(instanceId, 'session')
    },

    async rememberSession(instanceId, session) {
      if (session.value === '') throw new Error('空会话不写入 vault')
      load()
      requireOptIn(instanceId, 'rememberSession')
      entryFor(instanceId).session = encode(JSON.stringify(session))
      await persist()
    },

    getSession(instanceId) {
      const plain = readStored(instanceId, 'session')
      if (plain === null) return null
      try {
        const parsed: unknown = JSON.parse(plain)
        if (!isStoredSession(parsed)) return null
        return {
          name: parsed.name,
          value: parsed.value,
          expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : null
        }
      } catch {
        // **不要**把原始错误交给 onError:Node 的 JSON.parse 报错会把输入内容
        // 嵌进 message(`Unexpected token 's', "sess-secret..." is not valid JSON`),
        // 而这里的输入是**解密后的会话 Cookie** —— 默认 onError 会把它打到控制台。
        // 凭据纪律:日志只记事件,不记内容。
        onError(new Error('vault 会话载荷不是合法 JSON,已丢弃'))
        return null
      }
    },

    async forgetSession(instanceId) {
      await forgetField(instanceId, 'session')
    },

    async forgetInstance(instanceId) {
      load()
      items.delete(instanceId)
      // 实例已删除:勾选策略一并清掉(否则重建同名实例会继承旧策略)
      policy.delete(instanceId)
      await persist()
    },

    async clearAll() {
      load()
      // 把受影响实例的策略显式钉在「都不记住」：即便未来默认值变化，
      // 已清除的实例也不会在下一次登录时立刻重新写入。
      const affectedIds = new Set([...items.keys(), ...policy.keys()])
      items.clear()
      policy.clear()
      for (const instanceId of affectedIds) {
        policy.set(instanceId, { rememberPassword: false, rememberSession: false })
      }
      await persist()
    },

    getPolicy(instanceId) {
      load()
      return policy.get(instanceId) ?? { ...DEFAULT_VAULT_POLICY }
    },

    async setPolicy(instanceId, next) {
      load()
      const normalized = normalizePolicy(next)
      // **取消勾选必须真的忘掉**,而不是只停止「继续记住」
      const entry = items.get(instanceId)
      if (!normalized.rememberPassword && entry?.password !== undefined) delete entry.password
      if (!normalized.rememberSession && entry?.session !== undefined) delete entry.session
      dropIfEmpty(instanceId)
      // 仅保存与默认策略不同的显式选择；这样新实例默认勾选，而取消勾选仍可跨重启保留。
      if (
        normalized.rememberPassword === DEFAULT_VAULT_POLICY.rememberPassword &&
        normalized.rememberSession === DEFAULT_VAULT_POLICY.rememberSession
      ) {
        policy.delete(instanceId)
      } else {
        policy.set(instanceId, normalized)
      }
      await persist()
    },

    rememberedIds() {
      load()
      return [...items.keys()]
    },

    policyIds() {
      load()
      return [...policy.keys()]
    }
  }
}
