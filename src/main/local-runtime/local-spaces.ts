import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export interface LocalSpaceSnapshot {
  id: string
  sizeBytes: number
  modifiedAt: string
}

export async function listLocalSpaces(dataRoot: string): Promise<LocalSpaceSnapshot[]> {
  const homesDir = join(dataRoot, 'homes')
  let entries: Dirent<string>[]
  try {
    entries = await readdir(homesDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const homesRoot = `${resolve(homesDir)}${sep}`
  const spaces = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)
      )
      .map(async (entry) => {
        const path = resolve(homesDir, entry.name)
        if (!path.startsWith(homesRoot)) return null
        const stats = await directoryStats(path)
        return {
          id: entry.name,
          sizeBytes: stats.sizeBytes,
          modifiedAt: stats.modifiedAt.toISOString()
        }
      })
  )
  return spaces
    .filter((space): space is LocalSpaceSnapshot => space !== null)
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function localSpacePath(dataRoot: string, id: string): string {
  const homesDir = resolve(dataRoot, 'homes')
  const path = resolve(homesDir, id)
  if (!path.startsWith(`${homesDir}${sep}`)) throw new Error('invalid-local-space-path')
  return path
}

/**
 * 把本机隔离空间移入系统废纸篓。目录不存在时直接放行：homes 目录在实例首次成功
 * 启动时才创建，从未成功启动的实例删除时无物可移 —— Windows 的 shell.trashItem
 * 对不存在的路径会抛「Failed to parse path」，不跳过会让删除永远失败。
 * 目录存在而移入失败时如实上抛，调用方据此中止删除，避免记录已删而数据残留。
 */
export async function trashLocalSpaceDir(
  dataRoot: string,
  instanceId: string,
  trashItem: (path: string) => Promise<void>
): Promise<void> {
  const path = localSpacePath(dataRoot, instanceId)
  const exists = await stat(path).then(
    () => true,
    () => false
  )
  if (!exists) return
  await trashItem(path)
}

async function directoryStats(path: string): Promise<{ sizeBytes: number; modifiedAt: Date }> {
  const info = await stat(path)
  let entries: Dirent<string>[]
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { sizeBytes: 0, modifiedAt: info.mtime }
    throw error
  }
  const children = await Promise.all(
    entries.map(async (entry) => {
      const child = join(path, entry.name)
      if (entry.isDirectory()) return directoryStats(child)
      if (!entry.isFile()) return { sizeBytes: 0, modifiedAt: info.mtime }
      const childInfo = await stat(child)
      return { sizeBytes: childInfo.size, modifiedAt: childInfo.mtime }
    })
  )
  return children.reduce(
    (total, child) => ({
      sizeBytes: total.sizeBytes + child.sizeBytes,
      modifiedAt: child.modifiedAt > total.modifiedAt ? child.modifiedAt : total.modifiedAt
    }),
    { sizeBytes: 0, modifiedAt: info.mtime }
  )
}
