/**
 * 登录环境刷新前后的差异计算（纯函数，便于测试）。
 *
 * 比较对象是登录 PATH 与登录 shell 环境：PATH 按平台分隔符拆条目做集合增删
 * （顺序调整不计），其余变量按「名字 → 是否出现/是否变值」判定。
 * 对外只产出 PATH 条目与变量名 —— 变量值可能含凭据，绝不出主进程。
 */
import type { EnvironmentDiff } from '@shared/contracts'

/** 一次环境解析的快照；null = 该侧解析失败或平台不可用。 */
export interface EnvSnapshot {
  path: string | null
  env: Map<string, string> | null
}

/** 不可对比/无变化时的空差异。 */
export function emptyEnvironmentDiff(): EnvironmentDiff {
  return {
    pathComparable: false,
    varsComparable: false,
    pathAdded: [],
    pathRemoved: [],
    varsAdded: [],
    varsRemoved: [],
    varsChanged: []
  }
}

/**
 * 计算 before → after 的环境差异。
 *
 * - PATH：两侧都非 null 才可比（`pathComparable`），按 `keyOf` 归一后做集合增删；
 *   win32 用 `;` 分隔并统一斜杠、忽略大小写（与 mergeLoginPath 同口径）。
 * - 变量：两侧 env 都非 null 才可比（`varsComparable`）；`PATH` 单独走路径对比，
 *   不在这里重复计数。
 */
export function diffEnvironment(
  before: EnvSnapshot,
  after: EnvSnapshot,
  platform: NodeJS.Platform = process.platform
): EnvironmentDiff {
  const separator = platform === 'win32' ? ';' : ':'
  const keyOf = (dir: string): string =>
    platform === 'win32' ? dir.replace(/\//g, '\\').toLowerCase() : dir
  const splitPath = (raw: string): string[] =>
    raw
      .split(separator)
      .map((dir) => (platform === 'win32' ? dir.trim() : dir))
      .filter((dir) => dir !== '')

  const diff = emptyEnvironmentDiff()
  const beforePath = before.path
  const afterPath = after.path
  if (beforePath !== null && afterPath !== null) {
    diff.pathComparable = true
    const beforeDirs = new Map(splitPath(beforePath).map((dir) => [keyOf(dir), dir]))
    const afterDirs = new Map(splitPath(afterPath).map((dir) => [keyOf(dir), dir]))
    for (const [key, dir] of afterDirs) {
      if (!beforeDirs.has(key)) diff.pathAdded.push(dir)
    }
    for (const [key, dir] of beforeDirs) {
      if (!afterDirs.has(key)) diff.pathRemoved.push(dir)
    }
  }

  const beforeEnv = before.env
  const afterEnv = after.env
  if (beforeEnv !== null && afterEnv !== null) {
    diff.varsComparable = true
    for (const [key, value] of afterEnv) {
      if (key === 'PATH') continue
      const previous = beforeEnv.get(key)
      if (previous === undefined) diff.varsAdded.push(key)
      else if (previous !== value) diff.varsChanged.push(key)
    }
    for (const key of beforeEnv.keys()) {
      if (key !== 'PATH' && !afterEnv.has(key)) diff.varsRemoved.push(key)
    }
  }

  return diff
}
