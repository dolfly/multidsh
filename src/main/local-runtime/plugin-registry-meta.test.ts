import { describe, expect, it } from 'vitest'
import type { LocalInstance } from '@shared/contracts'
import { createRegistryMetadataReader } from './plugin-registry-meta'
import type { CommandResult } from './exec-file'

/**
 * registry 元数据读取。
 *
 * 重点守卫两条线：
 * - **版本不存在要给出 not-found**（文案点名版本），其余错误照旧上抛；
 * - **仓库地址取不到按「没有仓库」处理**：确认区只需降级到 npm 包页，不该报错。
 */

const INSTANCE = { id: 'inst-1', name: '本机实例', transport: 'local' } as LocalInstance
const RESOLVED = { entry: '/dsh/bin.js', version: '0.2.0' }

/** 装配读取器：runPlugin 可自定义（成功或抛错）。 */
function build(
  runPlugin: (
    instance: LocalInstance,
    args: string[],
    resolved: { entry: string; version: string },
    registry?: 'npmmirror' | 'npmjs'
  ) => Promise<CommandResult>
): ReturnType<typeof createRegistryMetadataReader> {
  return createRegistryMetadataReader({
    runPlugin: runPlugin as never,
    defaultRegistry: () => 'npmmirror',
    isRegistryNotFound: (error: unknown) =>
      error instanceof Error && /404|Not Found/i.test(error.message)
  })
}

describe('viewVersionMeta', () => {
  it('取 peer 范围与发布时间', async () => {
    const reader = build(async () => ({
      code: 0,
      stdout: JSON.stringify({
        peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' },
        time: { '1.1.0': '2026-09-28T11:16:59.586Z' }
      }),
      stderr: ''
    }))
    const meta = await reader.viewVersionMeta(INSTANCE, 'demo-plugin', '1.1.0', RESOLVED, 'npmjs')
    expect(meta.peers).toEqual({ '@deepseek-ai/dsh': '>=0.2.0' })
    expect(meta.publishedAt).toBe('2026-09-28T11:16:59.586Z')
  })

  it('查询带版本与字段名', async () => {
    const calls: string[][] = []
    const reader = build(async (_instance, args) => {
      calls.push(args)
      return { code: 0, stdout: '{}', stderr: '' }
    })
    await reader.viewVersionMeta(INSTANCE, 'demo-plugin', '1.1.0', RESOLVED, 'npmjs')
    expect(calls[0]).toEqual(['view', 'demo-plugin@1.1.0', 'peerDependencies', 'time', '--json'])
  })

  it('registry 未收录 → not-found，文案点名版本', async () => {
    const reader = build(async () => {
      throw new Error('404 Not Found')
    })
    await expect(
      reader.viewVersionMeta(INSTANCE, 'demo-plugin', '9.9.9', RESOLVED, 'npmjs')
    ).rejects.toMatchObject({ code: 'not-found' })
  })

  it('其它错误照旧上抛（不一律吞成 not-found）', async () => {
    const reader = build(async () => {
      throw new Error('网络不通')
    })
    await expect(
      reader.viewVersionMeta(INSTANCE, 'demo-plugin', '1.1.0', RESOLVED, 'npmjs')
    ).rejects.toThrow('网络不通')
  })

  it('输出里没有 peer 与 time 时按缺省处理', async () => {
    const reader = build(async () => ({ code: 0, stdout: '{}', stderr: '' }))
    const meta = await reader.viewVersionMeta(INSTANCE, 'demo-plugin', '1.1.0', RESOLVED, 'npmjs')
    expect(meta.peers).toEqual({})
    expect(meta.publishedAt).toBeNull()
  })
})

describe('resolveRepositoryUrl', () => {
  it('从 repository 字段推导 GitHub 地址', async () => {
    const reader = build(async () => ({
      code: 0,
      stdout: JSON.stringify({
        repository: { type: 'git', url: 'git+https://github.com/demo/demo-plugin.git' }
      }),
      stderr: ''
    }))
    const url = await reader.resolveRepositoryUrl(INSTANCE, 'demo-plugin', '1.1.0', RESOLVED)
    expect(url).toBe('https://github.com/demo/demo-plugin')
  })

  it('没有 repository 时回落到 homepage', async () => {
    const reader = build(async () => ({
      code: 0,
      stdout: JSON.stringify({ homepage: 'https://github.com/demo/other' }),
      stderr: ''
    }))
    const url = await reader.resolveRepositoryUrl(INSTANCE, 'demo-plugin', '1.1.0', RESOLVED)
    expect(url).toBe('https://github.com/demo/other')
  })

  it('非 GitHub 地址 → null（不是 GitHub 仓库就没有更新内容可取）', async () => {
    const reader = build(async () => ({
      code: 0,
      stdout: JSON.stringify({ homepage: 'https://example.com/docs' }),
      stderr: ''
    }))
    const url = await reader.resolveRepositoryUrl(INSTANCE, 'demo-plugin', '1.1.0', RESOLVED)
    expect(url).toBeNull()
  })

  it('命令失败 → null（确认区降级到 npm 包页，不报错）', async () => {
    const reader = build(async () => {
      throw new Error('命令失败')
    })
    const url = await reader.resolveRepositoryUrl(INSTANCE, 'demo-plugin', '1.1.0', RESOLVED)
    expect(url).toBeNull()
  })

  it('输出不可解析 → null', async () => {
    const reader = build(async () => ({ code: 0, stdout: 'not json', stderr: '' }))
    const url = await reader.resolveRepositoryUrl(INSTANCE, 'demo-plugin', '1.1.0', RESOLVED)
    expect(url).toBeNull()
  })

  it('用默认安装源查询（不受调用方档位影响）', async () => {
    const calls: Array<string[] | undefined> = []
    const reader = createRegistryMetadataReader({
      runPlugin: (async (
        _instance: LocalInstance,
        args: string[],
        _resolved: { entry: string; version: string },
        registry?: 'npmmirror' | 'npmjs'
      ) => {
        calls.push([...args, String(registry)])
        return { code: 0, stdout: '{}', stderr: '' }
      }) as never,
      defaultRegistry: () => 'npmjs',
      isRegistryNotFound: () => false
    })
    await reader.resolveRepositoryUrl(INSTANCE, 'demo-plugin', '1.1.0', RESOLVED)
    expect(calls[0]?.at(-1)).toBe('npmjs')
  })
})
