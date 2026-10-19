import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProfileBundleStore } from './profile-bundles'

const dirs: string[] = []
async function profileDir(manifest: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'profile-bundles-'))
  dirs.push(dir)
  await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  return dir
}

const MANIFEST = {
  name: 'dsh-profile-web',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'a', 'b'] } },
  dependencies: { a: '1.0.0', b: '2.0.0' }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('createProfileBundleStore', () => {
  it('read：解析 bundles 与 dependencies；缺失/损坏时返回空', async () => {
    const store = createProfileBundleStore()
    const dir = await profileDir(MANIFEST)
    expect(await store.read(dir)).toEqual({
      bundles: ['@deepseek-ai/dsh-base', 'a', 'b'],
      dependencies: ['a', 'b']
    })

    const empty = await mkdtemp(join(tmpdir(), 'profile-bundles-'))
    dirs.push(empty)
    expect(await store.read(empty)).toBeNull()
  })

  it('禁用：从 bundles 移除，dependencies 与其它字段原样保留', async () => {
    const store = createProfileBundleStore()
    const dir = await profileDir(MANIFEST)
    const bundles = await store.setEnabled(dir, 'a', false)
    expect(bundles).toEqual(['@deepseek-ai/dsh-base', 'b'])

    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ a: '1.0.0', b: '2.0.0' })
    expect(manifest.name).toBe('dsh-profile-web')
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'b'])
  })

  it('启用：按原索引插回（保持 patch 覆盖优先级）', async () => {
    const store = createProfileBundleStore()
    const dir = await profileDir({
      ...MANIFEST,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'b'] } }
    })
    // a 原本在索引 1
    expect(await store.setEnabled(dir, 'a', true, 1)).toEqual(['@deepseek-ai/dsh-base', 'a', 'b'])
  })

  it('启用：索引越界时追加到末尾（与 dsh 官方行为一致）', async () => {
    const store = createProfileBundleStore()
    const dir = await profileDir({
      ...MANIFEST,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
    })
    expect(await store.setEnabled(dir, 'a', true, 99)).toEqual(['@deepseek-ai/dsh-base', 'a'])
  })

  it('重复启用/重复禁用是无操作（不重复入列）', async () => {
    const store = createProfileBundleStore()
    const dir = await profileDir(MANIFEST)
    expect(await store.setEnabled(dir, 'a', true)).toEqual(['@deepseek-ai/dsh-base', 'a', 'b'])
    expect(await store.setEnabled(dir, 'zzz', false)).toEqual(['@deepseek-ai/dsh-base', 'a', 'b'])
  })

  it('缺少 dsh.profile 时也能启用（补出结构）', async () => {
    const store = createProfileBundleStore()
    const dir = await profileDir({ name: 'p', dependencies: { a: '1.0.0' } })
    expect(await store.setEnabled(dir, 'a', true)).toEqual(['a'])
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ a: '1.0.0' })
  })

  it('锁被占用（持有者存活）时超时报错，且不改动文件', async () => {
    const store = createProfileBundleStore()
    const dir = await profileDir(MANIFEST)
    // 用当前进程 pid 占锁（存活）→ 竞争者会一直等到超时。
    await writeFile(join(dir, 'package.json.lock'), `${process.pid}\n`, 'utf8')
    await expect(store.setEnabled(dir, 'a', false)).rejects.toThrow(/正被 dsh 占用/)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'a', 'b'])
  })

  it('锁的持有者已退出（pid 不存在）时接管并完成写入', async () => {
    const store = createProfileBundleStore()
    const dir = await profileDir(MANIFEST)
    await mkdir(dir, { recursive: true })
    // 一个几乎不可能存在的 pid
    await writeFile(join(dir, 'package.json.lock'), '999999\n', 'utf8')
    expect(await store.setEnabled(dir, 'a', false)).toEqual(['@deepseek-ai/dsh-base', 'b'])
    // 锁已释放
    await expect(readFile(join(dir, 'package.json.lock'), 'utf8')).rejects.toThrow()
  })

  it('写入后不残留临时文件', async () => {
    const store = createProfileBundleStore()
    const dir = await profileDir(MANIFEST)
    await store.setEnabled(dir, 'a', false)
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dir)).toEqual(['package.json'])
  })
})
