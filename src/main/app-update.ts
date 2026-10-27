/**
 * 应用自身更新检查：读取 GitHub 最新 Release，与当前版本比较。
 *
 * 纯逻辑 + 注入取数（不 import Electron）：仓库地址由主进程从 `HOMEPAGE_URL` 解析，
 * 渲染层不传 URL；网络失败与上游格式问题以 `InstanceStoreError` 抛出，
 * 由 IPC 层收敛成 `io-error` 错误信封，文案直接面向用户。
 */
import type { AppUpdateCheck } from '@shared/bridge'
import { HOMEPAGE_URL } from '@shared/contracts'
import { InstanceStoreError } from './registry/instance-store'
import { ownerRepoFrom } from './local-runtime/plugin-package-info'
import { compareDshVersions } from './local-runtime/version-compare'

/** GitHub 请求超时：检查更新是用户主动动作，不能让外网拖住按钮的响应。 */
const UPDATE_TIMEOUT_MS = 5_000

/** 读取的 Release 条数：只为求出最新版本，取前若干条即可。 */
const RELEASES_FETCH_COUNT = 30

/** 取数依赖：注入便于单测（超时与网络行为不外泄给测试）。 */
export interface UpdateCheckDeps {
  /** 取 JSON；非 2xx、超时与网络失败统一返回 null。 */
  fetchJson?: (
    url: string,
    timeoutMs: number,
    headers?: Record<string, string>
  ) => Promise<unknown | null>
  /** 当前时刻（ISO 8601）；注入以便测试固定 `checkedAt`。 */
  now?: () => string
}

/** 更新检查结果所需的 Release 字段。 */
interface ReleaseEntry {
  /** 原始 tag（生成回退发布页地址用）。 */
  tag: string
  /** tag 解析出的版本号（已去掉 `v` 前缀）。 */
  version: string
  /** Release 页面地址；应答缺失时为 null。 */
  url: string | null
  /** 发布时间（ISO 8601）；应答缺失时为 null。 */
  publishedAt: string | null
}

/**
 * tag → 版本号：去掉大小写不限的 `v` 前缀；形态不是纯数字点分（可带预发布后缀）时
 * 视为不可比（如 `latest`、日期 tag），返回 null。
 */
function versionOfTag(tag: string): string | null {
  const trimmed = tag.trim().replace(/^v/i, '')
  return /^\d+(\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/.test(trimmed) ? trimmed : null
}

/** Release 应答数组 → 可比条目：丢弃草稿、缺 tag 与 tag 不是版本号的条目。 */
function parseReleases(raw: unknown): ReleaseEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: ReleaseEntry[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as {
      tag_name?: unknown
      html_url?: unknown
      published_at?: unknown
      draft?: unknown
    }
    if (record.draft === true) continue
    const tag = typeof record.tag_name === 'string' ? record.tag_name.trim() : ''
    const version = versionOfTag(tag)
    if (tag === '' || version === null) continue
    entries.push({
      tag,
      version,
      url: typeof record.html_url === 'string' && record.html_url !== '' ? record.html_url : null,
      publishedAt:
        typeof record.published_at === 'string' && record.published_at !== ''
          ? record.published_at
          : null
    })
  }
  return entries
}

/** 取版本号最大的条目：应答按发布时间排序且不保证版本序，必须比较求最大而非取首位。 */
function newestRelease(entries: ReleaseEntry[]): ReleaseEntry | null {
  let best: ReleaseEntry | null = null
  for (const entry of entries) {
    if (best === null || compareDshVersions(entry.version, best.version) > 0) best = entry
  }
  return best
}

/**
 * 默认取 JSON：Node 22 全局 fetch + `AbortSignal.timeout`（不新增运行时依赖）。
 * 非 2xx（含 GitHub 限流 403 与未命中 404）与网络失败统一返回 null，
 * 由调用方按「检查失败」回报，不区分具体原因（对外只暴露是否可达）。
 */
async function defaultFetchJson(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {}
): Promise<unknown | null> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return (await response.json()) as unknown
  } catch {
    return null
  }
}

/** GitHub 请求头：`user-agent` 与 JSON `accept` 是 API 的硬要求。 */
function githubHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN?.trim()
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-hub-desktop',
    ...(token !== undefined && token !== '' ? { authorization: `Bearer ${token}` } : {})
  }
}

/**
 * 构造更新检查器：返回「以当前版本为入参、给出检查结果」的函数。
 * 无参数通道由 IPC 层补入 `app.getVersion()`，渲染层不参与版本来源。
 */
export function createUpdateChecker(
  deps: UpdateCheckDeps = {}
): (currentVersion: string) => Promise<AppUpdateCheck> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson
  const now = deps.now ?? (() => new Date().toISOString())

  return async (currentVersion: string): Promise<AppUpdateCheck> => {
    const repo = ownerRepoFrom(HOMEPAGE_URL)
    if (repo === null) throw new InstanceStoreError('internal', '无法从项目主页解析更新源仓库')
    const slug = `${repo.owner}/${repo.repo}`
    const raw = await fetchJson(
      `https://api.github.com/repos/${slug}/releases?per_page=${RELEASES_FETCH_COUNT}`,
      UPDATE_TIMEOUT_MS,
      githubHeaders()
    )
    if (raw === null) throw new InstanceStoreError('io-error', '无法连接 GitHub，请稍后重试')
    const latest = newestRelease(parseReleases(raw))
    if (latest === null) throw new InstanceStoreError('io-error', 'GitHub 上没有可用的发布版本')
    return {
      current: currentVersion,
      latest: latest.version,
      hasUpdate: compareDshVersions(currentVersion, latest.version) < 0,
      releaseUrl:
        latest.url ?? `https://github.com/${slug}/releases/tag/${encodeURIComponent(latest.tag)}`,
      publishedAt: latest.publishedAt,
      checkedAt: now()
    }
  }
}

/** 生产用更新检查器（取数与时间取默认实现）。 */
export const checkAppUpdate = createUpdateChecker()
