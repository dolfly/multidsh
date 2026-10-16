import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createPackageInfoFetchers,
  extractChangelogSection,
  ownerRepoFrom,
  RELEASE_NOTES_LIMIT
} from './plugin-package-info'
import type { PackageInfoFetcherDeps, PackageInfoFetchHeaders } from './plugin-package-info'

afterEach(() => {
  vi.unstubAllEnvs()
})

interface FetchCall {
  kind: 'json' | 'text'
  url: string
  timeoutMs: number
  headers: PackageInfoFetchHeaders | undefined
}

/**
 * 取数桩：按 URL 给出应答并记录请求（断言降级顺序、请求头与缓存命中不再发请求）。
 * 返回 undefined = 该请求失败（非 2xx / 超时 / 网络不可达）。
 */
function stubFetchers(respond: (kind: 'json' | 'text', url: string) => unknown): {
  deps: PackageInfoFetcherDeps
  calls: FetchCall[]
  advance: (ms: number) => void
} {
  const calls: FetchCall[] = []
  let clock = 1_700_000_000_000
  const deps: PackageInfoFetcherDeps = {
    fetchJson: async (url, timeoutMs, headers) => {
      calls.push({ kind: 'json', url, timeoutMs, headers })
      const value = respond('json', url)
      return value === undefined ? null : value
    },
    fetchText: async (url, timeoutMs, headers) => {
      calls.push({ kind: 'text', url, timeoutMs, headers })
      const value = respond('text', url)
      return typeof value === 'string' ? value : null
    },
    now: () => clock
  }
  return {
    deps,
    calls,
    advance: (ms) => {
      clock += ms
    }
  }
}

const REPO_URL = 'https://github.com/demo/demo-plugin'
const RELEASE_V_URL = 'https://api.github.com/repos/demo/demo-plugin/releases/tags/v1.2.3'
const RELEASE_BARE_URL = 'https://api.github.com/repos/demo/demo-plugin/releases/tags/1.2.3'
const CHANGELOG_V_URL = 'https://raw.githubusercontent.com/demo/demo-plugin/v1.2.3/CHANGELOG.md'
const CHANGELOG_BARE_URL = 'https://raw.githubusercontent.com/demo/demo-plugin/1.2.3/CHANGELOG.md'
const NPM_PAGE = 'https://www.npmjs.com/package/demo-plugin'

function releaseInput(): { repoUrl: string; version: string; fallbackPageUrl: string } {
  return { repoUrl: REPO_URL, version: '1.2.3', fallbackPageUrl: NPM_PAGE }
}

describe('extractChangelogSection', () => {
  const doc = ['# 变更日志', '', '## 1.2.3', '', '- 支持安装两步', '', '## 1.2.2', '', '- 旧版'].join(
    '\n'
  )

  it('命中 `## 1.2.3` 标题：截到下一个版本标题之前', () => {
    expect(extractChangelogSection(doc, '1.2.3')).toEqual({
      text: '## 1.2.3\n\n- 支持安装两步',
      truncated: false
    })
  })

  it('支持 `### v1.2.3` 与 `## [1.2.3]` 标题写法', () => {
    expect(extractChangelogSection('### v1.2.3\n\n- a\n\n### v1.2.2\n\n- b', '1.2.3')?.text).toBe(
      '### v1.2.3\n\n- a'
    )
    expect(extractChangelogSection('## [1.2.3]\n\n- a\n\n## [1.2.2]\n\n- b', '1.2.3')?.text).toBe(
      '## [1.2.3]\n\n- a'
    )
  })

  it('支持列表式 `- 1.2.3`（缩进的子条目不是版本标题）', () => {
    expect(extractChangelogSection('- 1.2.3\n  - a\n- 1.2.2\n  - b', '1.2.3')?.text).toBe(
      '- 1.2.3\n  - a'
    )
  })

  it('版本号更长的标题不算命中（1.2.30 ≠ 1.2.3）', () => {
    const doc30 = '## 1.2.30\n\n- 别的版本\n\n## 1.2.3\n\n- 目标'
    expect(extractChangelogSection(doc30, '1.2.3')?.text).toBe('## 1.2.3\n\n- 目标')
  })

  it('找不到版本标题：整篇即候选', () => {
    expect(extractChangelogSection('# 变更\n\n随手记的变更', '9.9.9')).toEqual({
      text: '# 变更\n\n随手记的变更',
      truncated: false
    })
  })

  it('整篇为空 → null', () => {
    expect(extractChangelogSection('   \n\n', '1.2.3')).toBeNull()
    expect(extractChangelogSection('', '1.2.3')).toBeNull()
  })

  it('超过上限截断并标记（默认上限 4000）', () => {
    const limited = extractChangelogSection(`## 1.2.3\n\n${'x'.repeat(5000)}`, '1.2.3', 4000)
    expect(limited?.truncated).toBe(true)
    expect(limited?.text).toHaveLength(4000)

    const byDefault = extractChangelogSection('y'.repeat(RELEASE_NOTES_LIMIT + 1), '1.2.3')
    expect(byDefault?.truncated).toBe(true)
    expect(byDefault?.text).toHaveLength(RELEASE_NOTES_LIMIT)
  })
})

describe('ownerRepoFrom', () => {
  it('解析 github.com 仓库地址（容忍 .git 后缀与尾斜杠）', () => {
    expect(ownerRepoFrom('https://github.com/xbzbing/dsh-git-panel')).toEqual({
      owner: 'xbzbing',
      repo: 'dsh-git-panel'
    })
    expect(ownerRepoFrom('https://github.com/xbzbing/dsh-git-panel.git/')).toEqual({
      owner: 'xbzbing',
      repo: 'dsh-git-panel'
    })
  })

  it('非 github 地址、带子路径或空值 → null', () => {
    expect(ownerRepoFrom('https://gitlab.com/a/b')).toBeNull()
    expect(ownerRepoFrom('https://github.com/a/b/tree/main')).toBeNull()
    expect(ownerRepoFrom(null)).toBeNull()
    expect(ownerRepoFrom(undefined)).toBeNull()
  })
})

describe('createPackageInfoFetchers.fetchDownloads', () => {
  it('解析 npm 下载量应答；scope 包名整体编码后请求', async () => {
    const stub = stubFetchers(() => ({ downloads: 4310, start: '2026-09-13', end: '2026-10-12' }))
    const fetchers = createPackageInfoFetchers(stub.deps)
    await expect(fetchers.fetchDownloads('@xbzbing/dsh-git-panel')).resolves.toEqual({
      count: 4310,
      start: '2026-09-13',
      end: '2026-10-12'
    })
    expect(stub.calls[0]?.url).toBe(
      'https://api.npmjs.org/downloads/point/last-month/%40xbzbing%2Fdsh-git-panel'
    )
    expect(stub.calls[0]?.timeoutMs).toBe(5_000)
  })

  it('接口失败或字段非法 → null（非 npm 包同样是 null，不抛错）', async () => {
    const failing = stubFetchers(() => undefined)
    await expect(createPackageInfoFetchers(failing.deps).fetchDownloads('nope')).resolves.toBeNull()

    const malformed = stubFetchers(() => ({ downloads: 'many', start: '', end: null }))
    await expect(createPackageInfoFetchers(malformed.deps).fetchDownloads('demo')).resolves.toBeNull()
  })

  it('缓存 30 分钟：期内不再请求，过期后重新取', async () => {
    const stub = stubFetchers(() => ({ downloads: 12, start: 'a', end: 'b' }))
    const fetchers = createPackageInfoFetchers(stub.deps)
    await fetchers.fetchDownloads('demo')
    await fetchers.fetchDownloads('demo')
    expect(stub.calls).toHaveLength(1)

    stub.advance(30 * 60_000)
    await fetchers.fetchDownloads('demo')
    expect(stub.calls).toHaveLength(2)
  })
})

describe('createPackageInfoFetchers.fetchReleaseNotes', () => {
  it('GitHub Release 命中：取正文与 tag 页，不再请求 CHANGELOG', async () => {
    const stub = stubFetchers((kind, url) =>
      kind === 'json' && url === RELEASE_V_URL ? { body: '修了几个 bug' } : undefined
    )
    const notes = await createPackageInfoFetchers(stub.deps).fetchReleaseNotes(releaseInput())
    expect(notes).toEqual({
      text: '修了几个 bug',
      source: 'github-release',
      pageUrl: 'https://github.com/demo/demo-plugin/releases/tag/v1.2.3',
      truncated: false
    })
    expect(stub.calls.map((call) => call.url)).toEqual([RELEASE_V_URL])
  })

  it('Release 两种 tag 都未命中 → 降级 CHANGELOG 段落', async () => {
    const changelog = '# 变更日志\n\n## 1.2.3\n\n- 新增安装两步\n\n## 1.2.2\n\n- 旧版\n'
    const stub = stubFetchers((kind, url) =>
      kind === 'text' && url === CHANGELOG_V_URL ? changelog : undefined
    )
    const notes = await createPackageInfoFetchers(stub.deps).fetchReleaseNotes(releaseInput())
    expect(notes).toEqual({
      text: '## 1.2.3\n\n- 新增安装两步',
      source: 'changelog',
      pageUrl: 'https://github.com/demo/demo-plugin/blob/v1.2.3/CHANGELOG.md',
      truncated: false
    })
    // tag 先试 v 前缀再试裸版本，两次都没命中才写 CHANGELOG 请求。
    expect(stub.calls.map((call) => call.url)).toEqual([
      RELEASE_V_URL,
      RELEASE_BARE_URL,
      CHANGELOG_V_URL
    ])
  })

  it('v 前缀 tag 未命中但裸版本命中：Release 用裸 tag，页面链接与实际 tag 一致', async () => {
    const stub = stubFetchers((kind, url) =>
      kind === 'json' && url === RELEASE_BARE_URL ? { body: '裸 tag 的说明' } : undefined
    )
    const notes = await createPackageInfoFetchers(stub.deps).fetchReleaseNotes(releaseInput())
    expect(notes.pageUrl).toBe('https://github.com/demo/demo-plugin/releases/tag/1.2.3')
    expect(notes.source).toBe('github-release')
  })

  it('CHANGELOG 的 v 前缀 tag 未命中时改取裸版本 tag（blob 链接用实际 tag）', async () => {
    const stub = stubFetchers((kind, url) =>
      kind === 'text' && url === CHANGELOG_BARE_URL ? '## 1.2.3\n\n- 裸 tag 的段落' : undefined
    )
    const notes = await createPackageInfoFetchers(stub.deps).fetchReleaseNotes(releaseInput())
    expect(notes.source).toBe('changelog')
    expect(notes.text).toBe('## 1.2.3\n\n- 裸 tag 的段落')
    expect(notes.pageUrl).toBe('https://github.com/demo/demo-plugin/blob/1.2.3/CHANGELOG.md')
  })

  it('Release body 为空不算命中：继续试下一个 tag，最终降级 CHANGELOG', async () => {
    const stub = stubFetchers((kind, url) => {
      if (kind === 'json') return { body: '   ' }
      return url === CHANGELOG_V_URL ? '## 1.2.3\n\n- 空 Release 后的降级' : undefined
    })
    const notes = await createPackageInfoFetchers(stub.deps).fetchReleaseNotes(releaseInput())
    expect(notes.source).toBe('changelog')
    expect(notes.text).toBe('## 1.2.3\n\n- 空 Release 后的降级')
  })

  it('Release 与 CHANGELOG 都取不到 → none + 回落 npm 包页', async () => {
    const stub = stubFetchers(() => undefined)
    const notes = await createPackageInfoFetchers(stub.deps).fetchReleaseNotes(releaseInput())
    expect(notes).toEqual({ text: null, source: 'none', pageUrl: NPM_PAGE, truncated: false })
    expect(stub.calls).toHaveLength(4)
  })

  it('Release 正文超过上限 → 截断并标记', async () => {
    const stub = stubFetchers((kind) =>
      kind === 'json' ? { body: 'y'.repeat(RELEASE_NOTES_LIMIT + 10) } : undefined
    )
    const notes = await createPackageInfoFetchers(stub.deps).fetchReleaseNotes(releaseInput())
    expect(notes.truncated).toBe(true)
    expect(notes.text).toHaveLength(RELEASE_NOTES_LIMIT)
  })

  it('仓库地址不是 github → 直接 none，不发请求', async () => {
    const stub = stubFetchers(() => undefined)
    const notes = await createPackageInfoFetchers(stub.deps).fetchReleaseNotes({
      repoUrl: 'https://gitlab.com/demo/demo-plugin',
      version: '1.2.3',
      fallbackPageUrl: NPM_PAGE
    })
    expect(notes).toEqual({ text: null, source: 'none', pageUrl: NPM_PAGE, truncated: false })
    expect(stub.calls).toHaveLength(0)
  })

  it('负结果缓存 2 分钟：同一版本第二次不再发请求，过期后重试', async () => {
    const stub = stubFetchers(() => undefined)
    const fetchers = createPackageInfoFetchers(stub.deps)
    await fetchers.fetchReleaseNotes(releaseInput())
    await fetchers.fetchReleaseNotes(releaseInput())
    expect(stub.calls).toHaveLength(4)

    stub.advance(2 * 60_000 - 1)
    await fetchers.fetchReleaseNotes(releaseInput())
    expect(stub.calls).toHaveLength(4)

    stub.advance(1)
    await fetchers.fetchReleaseNotes(releaseInput())
    expect(stub.calls).toHaveLength(8)
  })

  it('命中结果缓存 10 分钟：期内不再请求，过期后重取', async () => {
    const stub = stubFetchers((kind, url) =>
      kind === 'json' && url === RELEASE_V_URL ? { body: 'x' } : undefined
    )
    const fetchers = createPackageInfoFetchers(stub.deps)
    await fetchers.fetchReleaseNotes(releaseInput())
    await fetchers.fetchReleaseNotes(releaseInput())
    expect(stub.calls).toHaveLength(1)

    stub.advance(10 * 60_000)
    await fetchers.fetchReleaseNotes(releaseInput())
    expect(stub.calls).toHaveLength(2)
  })

  it('请求带 GitHub 要求的头；有 GITHUB_TOKEN 时带 Authorization，无 token 时不带', async () => {
    const withToken = stubFetchers((kind) => (kind === 'json' ? { body: 'x' } : undefined))
    vi.stubEnv('GITHUB_TOKEN', 'token-123')
    await createPackageInfoFetchers(withToken.deps).fetchReleaseNotes(releaseInput())
    expect(withToken.calls[0]?.headers).toEqual({
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-hub-desktop',
      authorization: 'Bearer token-123'
    })

    const withoutToken = stubFetchers((kind) => (kind === 'json' ? { body: 'x' } : undefined))
    vi.stubEnv('GITHUB_TOKEN', '')
    await createPackageInfoFetchers(withoutToken.deps).fetchReleaseNotes(releaseInput())
    expect(withoutToken.calls[0]?.headers).toEqual({
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-hub-desktop'
    })
  })
})
