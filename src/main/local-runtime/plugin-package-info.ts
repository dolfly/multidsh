/**
 * 插件版本的增强信息取数：npm 近 30 天下载量，以及 GitHub Release → 仓库 CHANGELOG → 无内容的降级链。
 *
 * 纯逻辑 + 注入（不 import Electron）：取数实现由调用方装配，网络失败与「本来就没有内容」都是合法状态，
 * 一律以 null / `source: 'none'` 返回、不抛错——取不到更新内容不影响安装确认。
 * 全部结果在进程内缓存：确认区可能被反复打开，接口按天/按版本更新，不值得重复打外网。
 */
import type { PluginDownloads, PluginReleaseNotes } from '@shared/contracts'

/** 更新内容正文上限：Release body 与 CHANGELOG 段落共用（确认区只做限高滚动，不做分页）。 */
export const RELEASE_NOTES_LIMIT = 4000

/** GitHub 请求超时：确认区懒加载，不能让外网拖住「安装」按钮太久的观感。 */
const RELEASE_TIMEOUT_MS = 5_000

/** npm 下载量请求超时。 */
const DOWNLOADS_TIMEOUT_MS = 5_000

/** 命中结果的缓存时长（进程内）。 */
const RELEASE_TTL_MS = 10 * 60_000

/** 未命中 / 取数失败的缓存时长：限流与离线时短缓存，网络恢复后不必干等十分钟。 */
const RELEASE_NEGATIVE_TTL_MS = 2 * 60_000

/** 下载量按天更新，缓存 30 分钟足够。 */
const DOWNLOADS_TTL_MS = 30 * 60_000

/** GitHub API 请求头（`User-Agent` 与 JSON Accept 是 API 的硬要求）。 */
export interface PackageInfoFetchHeaders {
  [key: string]: string
}

/** 取数依赖：注入便于单测（超时与网络行为不外泄给测试）。 */
export interface PackageInfoFetcherDeps {
  /** 取文本；非 2xx、超时与网络失败统一返回 null。 */
  fetchText?: (
    url: string,
    timeoutMs: number,
    headers?: PackageInfoFetchHeaders
  ) => Promise<string | null>
  /** 取 JSON；取不到或解析失败统一返回 null。 */
  fetchJson?: (
    url: string,
    timeoutMs: number,
    headers?: PackageInfoFetchHeaders
  ) => Promise<unknown | null>
  /** 当前时刻（毫秒）；注入以便测试推进缓存过期。 */
  now?: () => number
}

/** fetchReleaseNotes 的入参：仓库地址与版本由主进程从 registry 元数据推导，渲染层不传 URL。 */
export interface ReleaseNotesInput {
  /** 仓库网页地址（`https://github.com/owner/repo`）。 */
  repoUrl: string
  version: string
  /** 取不到内容时的「打开发布页」目标（npm 包页）。 */
  fallbackPageUrl: string | null
}

export interface PackageInfoFetchers {
  /** 最近 30 天下载量；非 npm 包或接口失败返回 null。 */
  fetchDownloads(packageName: string): Promise<PluginDownloads | null>
  /** 该版本的更新内容：Release → CHANGELOG → none。 */
  fetchReleaseNotes(input: ReleaseNotesInput): Promise<PluginReleaseNotes>
}

/** 正则元字符转义（版本号里的 `.` 与 `+` 必须按字面量匹配）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 目标版本的标题行：`#{1,6}` 标题式或 `-`/`--` 列表式，版本号可带 `v` 前缀与 `[]`/`<>` 包裹。
 * 只匹配行首前缀（标题行可跟日期等后缀）；版本号后紧跟版本字符视为别的版本（如 1.2.30）。
 */
function versionHeadingPattern(version: string): RegExp {
  return new RegExp(
    `^(?:#{1,6}|-{1,2})\\s*[<[]?v?${escapeRegExp(version)}[>\\]]?(?![0-9A-Za-z.+-])`,
    'i'
  )
}

/** 任意版本标题行：把目标段落截到下一个版本标题之前。 */
const ANY_VERSION_HEADING =
  /^(?:#{1,6}|-{1,2})\s*[<[]?v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?[>\]]?(?![0-9A-Za-z.+-])/i

/** 超过上限即截断并标记；未超上限原样返回。 */
function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length <= limit
    ? { text, truncated: false }
    : { text: text.slice(0, limit), truncated: true }
}

/**
 * 提取某版本的 CHANGELOG 段落：命中版本标题行则从该行截到下一个版本标题之前；
 * 找不到标题时按「整篇即候选」处理（有些仓库只有一份无小节标题的变更说明）。
 * 正文为空返回 null；超过 limit 截断并标记。
 */
export function extractChangelogSection(
  markdown: string,
  version: string,
  limit = RELEASE_NOTES_LIMIT
): { text: string; truncated: boolean } | null {
  if (markdown.trim() === '') return null
  const lines = markdown.split(/\r?\n/)
  const wanted = versionHeadingPattern(version)
  const start = lines.findIndex((line) => wanted.test(line))
  if (start < 0) return truncateText(markdown.trim(), limit)
  const next = lines.findIndex((line, index) => index > start && ANY_VERSION_HEADING.test(line))
  const section = lines
    .slice(start, next < 0 ? undefined : next)
    .join('\n')
    .trim()
  return section === '' ? null : truncateText(section, limit)
}

/**
 * 从 GitHub 仓库网页地址解析 owner/repo；非 github.com 地址或形态不符返回 null。
 * 只接受 `https://github.com/<owner>/<repo>`（githubUrlFrom 的输出形态）。
 */
export function ownerRepoFrom(
  url: string | null | undefined
): { owner: string; repo: string } | null {
  if (typeof url !== 'string') return null
  const match = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (match?.[1] === undefined || match[2] === undefined) return null
  return { owner: match[1], repo: match[2] }
}

/**
 * npm 官方下载量接口（最近 30 天）。
 * 包名整体走 encodeURIComponent：scoped 包的 `/` 编码成 `%2F`（实测与未编码同样返回计数，
 * 编码后路径段无歧义，也避免镜像/代理对 `@scope/name` 的路径做额外切分）。
 */
function downloadsUrl(packageName: string): string {
  return `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(packageName)}`
}

/** 下载量应答 `{downloads,start,end}` → 契约形状；字段缺失或类型不符按「取不到」处理。 */
function parseDownloads(raw: unknown): PluginDownloads | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const count = record.downloads
  const start = record.start
  const end = record.end
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null
  if (typeof start !== 'string' || start === '' || typeof end !== 'string' || end === '')
    return null
  return { count: Math.trunc(count), start, end }
}

/** Release 应答里取正文；不是对象或正文为空按「未命中」处理（继续试另一个 tag 或降级 CHANGELOG）。 */
function releaseBody(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const body = (raw as { body?: unknown }).body
  if (typeof body !== 'string') return null
  const text = body.trim()
  return text === '' ? null : text
}

/**
 * 默认取文本实现：Node 22 全局 fetch + `AbortSignal.timeout`（不新增运行时依赖）。
 * 非 2xx（含 GitHub 限流 403 与未命中 404）与网络失败统一返回 null：调用方只关心「有没有内容」。
 */
async function defaultFetchText(
  url: string,
  timeoutMs: number,
  headers: PackageInfoFetchHeaders = {}
): Promise<string | null> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

/** 默认取 JSON：复用文本取数（同一套超时与状态码判定），解析失败按「取不到」处理。 */
async function defaultFetchJson(
  url: string,
  timeoutMs: number,
  headers: PackageInfoFetchHeaders = {}
): Promise<unknown | null> {
  const text = await defaultFetchText(url, timeoutMs, headers)
  if (text === null) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function createPackageInfoFetchers(deps: PackageInfoFetcherDeps = {}): PackageInfoFetchers {
  const now = deps.now ?? Date.now
  const fetchText = deps.fetchText ?? defaultFetchText
  const fetchJson = deps.fetchJson ?? defaultFetchJson

  const downloadsCache = new Map<string, { value: PluginDownloads | null; expiresAt: number }>()
  const releaseCache = new Map<string, { value: PluginReleaseNotes; expiresAt: number }>()

  /** GitHub 请求头：无 token 也可用（按 IP 限额 60 次/小时），配置了 GITHUB_TOKEN 则提高配额。 */
  function githubHeaders(): PackageInfoFetchHeaders {
    const token = process.env.GITHUB_TOKEN?.trim()
    return {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-hub-desktop',
      ...(token !== undefined && token !== '' ? { authorization: `Bearer ${token}` } : {})
    }
  }

  async function loadReleaseNotes(
    slug: string,
    input: ReleaseNotesInput
  ): Promise<PluginReleaseNotes> {
    // 发版习惯不一：先试 `v1.2.3` 再试 `1.2.3`，两种 tag 都未命中才降级 CHANGELOG。
    const tags = [`v${input.version}`, input.version]
    const headers = githubHeaders()
    for (const tag of tags) {
      const raw = await fetchJson(
        `https://api.github.com/repos/${slug}/releases/tags/${encodeURIComponent(tag)}`,
        RELEASE_TIMEOUT_MS,
        headers
      )
      const body = releaseBody(raw)
      if (body === null) continue
      const limited = truncateText(body, RELEASE_NOTES_LIMIT)
      return {
        text: limited.text,
        source: 'github-release',
        pageUrl: `https://github.com/${slug}/releases/tag/${tag}`,
        truncated: limited.truncated
      }
    }

    for (const tag of tags) {
      const raw = await fetchText(
        `https://raw.githubusercontent.com/${slug}/${tag}/CHANGELOG.md`,
        RELEASE_TIMEOUT_MS,
        headers
      )
      if (raw === null) continue
      const section = extractChangelogSection(raw, input.version)
      if (section === null) continue
      return {
        text: section.text,
        source: 'changelog',
        pageUrl: `https://github.com/${slug}/blob/${tag}/CHANGELOG.md`,
        truncated: section.truncated
      }
    }

    return { text: null, source: 'none', pageUrl: input.fallbackPageUrl, truncated: false }
  }

  return {
    async fetchDownloads(packageName: string): Promise<PluginDownloads | null> {
      const hit = downloadsCache.get(packageName)
      if (hit !== undefined && hit.expiresAt > now()) return hit.value
      const value = parseDownloads(await fetchJson(downloadsUrl(packageName), DOWNLOADS_TIMEOUT_MS))
      downloadsCache.set(packageName, { value, expiresAt: now() + DOWNLOADS_TTL_MS })
      return value
    },

    async fetchReleaseNotes(input: ReleaseNotesInput): Promise<PluginReleaseNotes> {
      const repo = ownerRepoFrom(input.repoUrl)
      if (repo === null) {
        return { text: null, source: 'none', pageUrl: input.fallbackPageUrl, truncated: false }
      }
      const slug = `${repo.owner}/${repo.repo}`
      const key = `${slug}@${input.version}`
      const hit = releaseCache.get(key)
      if (hit !== undefined && hit.expiresAt > now()) return hit.value
      const value = await loadReleaseNotes(slug, input)
      const ttl = value.source === 'none' ? RELEASE_NEGATIVE_TTL_MS : RELEASE_TTL_MS
      releaseCache.set(key, { value, expiresAt: now() + ttl })
      return value
    }
  }
}
