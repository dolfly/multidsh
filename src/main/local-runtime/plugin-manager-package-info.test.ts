import { describe, expect, it, vi } from 'vitest'
import { createPluginManager } from './plugin-manager'
import type { CommandResult } from './exec-file'
import type { PackageInfoFetchers } from './plugin-package-info'
import { LIST_JSON, baseOptions, localInstance } from './plugin-manager.testkit'

describe('createPluginManager.packageInfo', () => {
  const DOWNLOADS = { count: 4310, start: '2026-09-13', end: '2026-10-12' }
  const NOTES = {
    text: '修了几个 bug',
    source: 'github-release' as const,
    pageUrl: 'https://github.com/demo/demo-plugin/releases/tag/v1.1.0',
    truncated: false
  }

  /** 取数桩：记录调用，返回固定下载量与更新内容（真实网络行为在 plugin-package-info.test.ts 覆盖）。 */
  function stubPackageInfo(): {
    fetchers: PackageInfoFetchers
    downloads: string[]
    notes: unknown[]
  } {
    const downloads: string[] = []
    const notes: unknown[] = []
    return {
      downloads,
      notes,
      fetchers: {
        fetchDownloads: async (name) => {
          downloads.push(name)
          return DOWNLOADS
        },
        fetchReleaseNotes: async (input) => {
          notes.push(input)
          return NOTES
        }
      }
    }
  }

  /** 假 dsh：list 返回已装清单；view 返回 registry 元数据（repository/homepage）。 */
  function stubRun(viewMeta: unknown) {
    return vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 0, stdout: JSON.stringify(viewMeta), stderr: '' }
    })
  }

  it('有 github 仓库：仓库地址由 view 推导后交给取数器（渲染层不传 URL）', async () => {
    const stub = stubPackageInfo()
    const run = stubRun({
      repository: { type: 'git', url: 'git+https://github.com/demo/demo-plugin.git' }
    })
    const manager = createPluginManager({ ...baseOptions(run), packageInfoFetchers: stub.fetchers })
    const info = await manager.packageInfo(localInstance(), 'demo-plugin', '1.1.0')

    expect(info).toEqual({ downloads: DOWNLOADS, releaseNotes: NOTES })
    expect(stub.downloads).toEqual(['demo-plugin'])
    expect(stub.notes).toEqual([
      {
        repoUrl: 'https://github.com/demo/demo-plugin',
        version: '1.1.0',
        fallbackPageUrl: 'https://www.npmjs.com/package/demo-plugin'
      }
    ])
    const viewCall = run.mock.calls.find(([, args]) => args.includes('view'))!
    expect(viewCall[1]).toContain('repository')
    expect(viewCall[1].slice(-2)).toEqual(['--registry', 'https://registry.npmmirror.com'])
  })

  it('没有 github 仓库：不取 Release 内容，回落 npm 包页', async () => {
    const stub = stubPackageInfo()
    const run = stubRun({ homepage: 'https://example.com/demo' })
    const manager = createPluginManager({ ...baseOptions(run), packageInfoFetchers: stub.fetchers })
    const info = await manager.packageInfo(localInstance(), 'demo-plugin', '1.1.0')

    expect(info).toEqual({
      downloads: DOWNLOADS,
      releaseNotes: {
        text: null,
        source: 'none',
        pageUrl: 'https://www.npmjs.com/package/demo-plugin',
        truncated: false
      }
    })
    expect(stub.notes).toEqual([])
  })

  it('view 失败（离线 / 未发布）不是错误：下载量照常返回，更新内容降级为 none', async () => {
    const stub = stubPackageInfo()
    const run = vi.fn(async (command: string, args: string[]): Promise<CommandResult> => {
      void command
      if (args.includes('list')) return { code: 0, stdout: LIST_JSON, stderr: '' }
      return { code: 1, stdout: '', stderr: 'ERR_PNPM_FETCH_404 Not Found - 404' }
    })
    const manager = createPluginManager({ ...baseOptions(run), packageInfoFetchers: stub.fetchers })
    const info = await manager.packageInfo(localInstance(), 'demo-plugin', '1.1.0')

    expect(info.downloads).toEqual(DOWNLOADS)
    expect(info.releaseNotes.source).toBe('none')
    expect(info.releaseNotes.pageUrl).toBe('https://www.npmjs.com/package/demo-plugin')
  })
})
