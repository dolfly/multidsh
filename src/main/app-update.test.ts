import { describe, expect, it, vi } from 'vitest'
import { createUpdateChecker } from './app-update'

/** 固定当前时刻，让 checkedAt 可断言。 */
const NOW = '2026-10-28T00:00:00.000Z'

/** 只注入取数与时刻：超时、请求头与网络行为不进断言范围。 */
function checkerWith(raw: unknown): {
  check: ReturnType<typeof createUpdateChecker>
  fetchJson: ReturnType<typeof vi.fn>
} {
  const fetchJson = vi.fn(async () => raw)
  return { check: createUpdateChecker({ fetchJson, now: () => NOW }), fetchJson }
}

describe('createUpdateChecker（应用自身更新检查）', () => {
  it('取版本号最大的 Release，tag 去掉 v 前缀，按当前版本判定有更新', async () => {
    const { check } = checkerWith([
      {
        tag_name: 'v0.1.4',
        html_url: 'https://github.com/o/r/releases/tag/v0.1.4',
        published_at: '2026-01-01T00:00:00Z',
        draft: false
      },
      {
        tag_name: 'v0.1.10',
        html_url: 'https://github.com/o/r/releases/tag/v0.1.10',
        published_at: '2026-03-01T00:00:00Z',
        draft: false
      },
      { tag_name: '0.1.9', published_at: '2026-02-01T00:00:00Z' }
    ])

    const result = await check('0.1.6')

    // 0.1.10 按数字段比较大于 0.1.9（不按字典序）。
    expect(result).toEqual({
      current: '0.1.6',
      latest: '0.1.10',
      hasUpdate: true,
      releaseUrl: 'https://github.com/o/r/releases/tag/v0.1.10',
      publishedAt: '2026-03-01T00:00:00Z',
      checkedAt: NOW
    })
  })

  it('当前版本不低于最新版本 → hasUpdate=false；Release 缺 html_url 时回退 tag 地址', async () => {
    const { check } = checkerWith([
      { tag_name: 'v0.1.6', published_at: '2026-10-01T00:00:00Z' },
      { tag_name: 'v0.1.5', html_url: 'https://github.com/o/r/releases/tag/v0.1.5' }
    ])

    const result = await check('0.1.7')

    expect(result.hasUpdate).toBe(false)
    expect(result.latest).toBe('0.1.6')
    expect(result.releaseUrl).toBe('https://github.com/xbzbing/dsh-hub-desktop/releases/tag/v0.1.6')
    expect(result.checkedAt).toBe(NOW)
  })

  it('丢弃草稿与非版本 tag，只在可比条目里取最大', async () => {
    const { check } = checkerWith([
      { tag_name: 'nightly', html_url: 'https://github.com/o/r/releases/tag/nightly' },
      { tag_name: 'v0.2.0', draft: true },
      { tag_name: 'v0.1.7', html_url: 'https://github.com/o/r/releases/tag/v0.1.7' }
    ])

    const result = await check('0.1.6')

    expect(result.latest).toBe('0.1.7')
    expect(result.releaseUrl).toBe('https://github.com/o/r/releases/tag/v0.1.7')
  })

  it('读本仓库的 Release 列表（仓库地址由 HOMEPAGE_URL 解析，渲染层不传 URL）', async () => {
    const { check, fetchJson } = checkerWith([])

    await expect(check('0.1.6')).rejects.toMatchObject({ code: 'io-error' })
    expect(fetchJson).toHaveBeenCalledWith(
      'https://api.github.com/repos/xbzbing/dsh-hub-desktop/releases?per_page=30',
      5_000,
      expect.objectContaining({ accept: 'application/vnd.github+json' })
    )
  })

  it('取数失败（非 2xx / 超时 / 网络错误统一返回 null）→ io-error', async () => {
    const { check } = checkerWith(null)

    await expect(check('0.1.6')).rejects.toMatchObject({
      code: 'io-error',
      message: '无法连接 GitHub，请稍后重试'
    })
  })

  it('没有可比的发布版本 → io-error（不把「查不到」当最新）', async () => {
    for (const raw of [[], { message: 'Not Found' }, [{ tag_name: 'latest' }]]) {
      const { check } = checkerWith(raw)
      await expect(check('0.1.6')).rejects.toMatchObject({
        code: 'io-error',
        message: 'GitHub 上没有可用的发布版本'
      })
    }
  })
})
