/**
 * 插件检查状态的持久化（按实例一份 JSON，落在 `<dataRoot>/plugin-state/<id>.json`）。
 *
 * 检查结果要跨「离开详情页」与「应用重启」保留：用户不升级时，可升级标记一直显示，
 * 直到下次检查或升级才改写。状态只存检查得到的候选信息（latest/compatible/…），
 * 是否「有更新」由渲染层拿当前已装版本现算，版本变了标记自然消失。
 *
 * 同时存放「已装版本发布时间」的版本快照：同一版本的发布时间发布后不再变化，取到一次即可
 * 长期复用，下次检查再刷新（见 PluginPublishedSnapshot）。
 *
 * 写入用「临时文件 + rename」原子替换，避免中断留下半截 JSON；读取失败一律当作无状态，
 * 绝不因状态文件损坏影响插件列表。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { PluginAutoDisabled, PluginCheckRecord } from '@shared/contracts'

/** 因与运行时 dsh 不兼容而被自动禁用的插件（单一定义在 @shared/contracts）。 */
export type AutoDisabledPlugin = PluginAutoDisabled

/**
 * 某个插件版本的发布时间快照。
 *
 * 注册表里每个版本的发布时间是固定的（只有发新版才会新增条目），因此安装后取到一次
 * 就可长期保留：带版本号保存，升级换版本后由下一次检查写入新版本的发布时间。
 */
export interface PluginPublishedSnapshot {
  /** 该发布时间对应的插件版本。 */
  version: string
  /** 发布时间（ISO）。 */
  at: string
}

export interface PluginCheckState {
  /** 上次完成检查的时刻（ISO）；null = 尚未检查过。 */
  lastCheckedAt: string | null
  /** 插件名 → 检查结果摘要（仅记录检查过的插件）。 */
  updates: Record<string, PluginCheckRecord>
  /** 插件名 → 已装版本的发布时间快照。 */
  published: Record<string, PluginPublishedSnapshot>
  /** 插件名 → 被禁用时在 `dsh.profile.bundles` 里的索引，重新启用时按它插回原位。 */
  bundleIndex: Record<string, number>
  /** 上次「运行时版本变更后核对插件兼容性」时记录的 dsh 版本；null = 尚未核对过。 */
  runtimeVersion: string | null
  /** 最近一次核对中因不兼容被自动禁用的插件（供界面提示）。 */
  autoDisabled: AutoDisabledPlugin[]
}

export interface PluginStateStore {
  read(instanceId: string): Promise<PluginCheckState>
  /** 覆盖写入整个状态（调用方给出完整快照）。 */
  write(instanceId: string, state: PluginCheckState): Promise<void>
}

const EMPTY_STATE: PluginCheckState = {
  lastCheckedAt: null,
  updates: {},
  published: {},
  bundleIndex: {},
  runtimeVersion: null,
  autoDisabled: []
}

/** 无状态：字段各自独立，避免调用方改动落回共享常量。 */
function emptyState(): PluginCheckState {
  return { ...EMPTY_STATE, updates: {}, published: {}, bundleIndex: {}, autoDisabled: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 宽松解析：字段类型不对就丢弃该字段，不因单条脏数据丢掉整份状态。 */
function parseState(raw: unknown): PluginCheckState {
  if (!isRecord(raw)) return emptyState()
  const lastCheckedAt = typeof raw.lastCheckedAt === 'string' ? raw.lastCheckedAt : null
  const updates: Record<string, PluginCheckRecord> = {}
  const source = isRecord(raw.updates) ? raw.updates : {}
  for (const [name, value] of Object.entries(source)) {
    if (!isRecord(value)) continue
    if (typeof value.latest !== 'string' || value.latest === '') continue
    // 缺「检查时的已装版本」的记录无法校验是否仍适用（更早版本写入的），一律丢弃：
    // 宁可回到「未检查」，也不拿可能过期的候选信息当结果。
    if (typeof value.current !== 'string' || value.current === '') continue
    updates[name] = {
      current: value.current,
      latest: value.latest,
      compatible: value.compatible !== false,
      dshPeer: typeof value.dshPeer === 'string' ? value.dshPeer : null,
      dshVersion: typeof value.dshVersion === 'string' ? value.dshVersion : null
    }
  }
  const published: Record<string, PluginPublishedSnapshot> = {}
  const publishedSource = isRecord(raw.published) ? raw.published : {}
  for (const [name, value] of Object.entries(publishedSource)) {
    if (!isRecord(value)) continue
    if (typeof value.version !== 'string' || value.version === '') continue
    if (typeof value.at !== 'string' || value.at === '') continue
    published[name] = { version: value.version, at: value.at }
  }
  const bundleIndex: Record<string, number> = {}
  const indexSource = isRecord(raw.bundleIndex) ? raw.bundleIndex : {}
  for (const [name, value] of Object.entries(indexSource)) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) bundleIndex[name] = value
  }
  const runtimeVersion = typeof raw.runtimeVersion === 'string' ? raw.runtimeVersion : null
  const autoDisabled: AutoDisabledPlugin[] = []
  if (Array.isArray(raw.autoDisabled)) {
    for (const item of raw.autoDisabled) {
      if (!isRecord(item)) continue
      if (typeof item.name !== 'string' || typeof item.version !== 'string') continue
      autoDisabled.push({
        name: item.name,
        version: item.version,
        dshVersion: typeof item.dshVersion === 'string' ? item.dshVersion : ''
      })
    }
  }
  return { lastCheckedAt, updates, published, bundleIndex, runtimeVersion, autoDisabled }
}

export function createPluginStateStore(dataRoot: string): PluginStateStore {
  const dir = join(dataRoot, 'plugin-state')
  const fileFor = (instanceId: string): string => join(dir, `${instanceId}.json`)

  return {
    async read(instanceId: string): Promise<PluginCheckState> {
      try {
        return parseState(JSON.parse(await readFile(fileFor(instanceId), 'utf8')))
      } catch {
        return emptyState()
      }
    },

    async write(instanceId: string, state: PluginCheckState): Promise<void> {
      await mkdir(dir, { recursive: true })
      const target = fileFor(instanceId)
      const tmp = `${target}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, target)
    }
  }
}
