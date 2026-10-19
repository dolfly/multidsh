import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listLocalSpaces, localSpacePath, trashLocalSpaceDir } from './local-spaces'

const roots: string[] = []

async function root(): Promise<string> {
  const path = join(process.cwd(), 'hub-data', `local-spaces-${crypto.randomUUID()}`)
  roots.push(path)
  await mkdir(join(path, 'homes'), { recursive: true })
  return path
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (path) =>
        (await import('node:fs/promises')).rm(path, { recursive: true, force: true })
      )
  )
})

describe('local spaces', () => {
  it('lists only UUID-named isolated homes and their recursive size', async () => {
    const dataRoot = await root()
    const id = '11111111-1111-4111-8111-111111111111'
    await mkdir(join(dataRoot, 'homes', id, 'nested'), { recursive: true })
    await writeFile(join(dataRoot, 'homes', id, 'a.txt'), 'abc')
    await writeFile(join(dataRoot, 'homes', id, 'nested', 'b.txt'), 'defg')
    await mkdir(join(dataRoot, 'homes', 'not-an-instance'), { recursive: true })

    const spaces = await listLocalSpaces(dataRoot)
    expect(spaces).toHaveLength(1)
    const [space] = spaces
    expect(space).toMatchObject({ id, sizeBytes: 7 })
    expect(Date.parse(space!.modifiedAt)).not.toBeNaN()
  })

  it('keeps a resolved space path below the managed homes directory', async () => {
    const dataRoot = await root()
    expect(localSpacePath(dataRoot, '11111111-1111-4111-8111-111111111111')).toBe(
      join(dataRoot, 'homes', '11111111-1111-4111-8111-111111111111')
    )
  })

  it('trash: 目录存在时移入废纸篓', async () => {
    const dataRoot = await root()
    const id = '11111111-1111-4111-8111-111111111111'
    await mkdir(join(dataRoot, 'homes', id), { recursive: true })
    const trashed: string[] = []
    await trashLocalSpaceDir(dataRoot, id, async (path) => {
      trashed.push(path)
    })
    expect(trashed).toEqual([localSpacePath(dataRoot, id)])
  })

  it('trash: 目录从未创建（实例从未成功启动）时跳过，不调用 trashItem', async () => {
    const dataRoot = await root()
    const id = '11111111-1111-4111-8111-111111111111'
    const trashed: string[] = []
    await trashLocalSpaceDir(dataRoot, id, async (path) => {
      trashed.push(path)
    })
    expect(trashed).toEqual([])
  })

  it('trash: 目录存在而移入失败时如实上抛，调用方据此中止删除', async () => {
    const dataRoot = await root()
    const id = '11111111-1111-4111-8111-111111111111'
    await mkdir(join(dataRoot, 'homes', id), { recursive: true })
    await expect(
      trashLocalSpaceDir(dataRoot, id, async () => {
        throw new Error('Failed to parse path')
      })
    ).rejects.toThrow('Failed to parse path')
  })
})
