/**
 * profile 的 `dsh.profile.bundles`（插件加载清单）读写。
 *
 * dsh 用这份数组决定加载哪些 bundle 插件：在 `dependencies` 里但不在 `bundles` 里 =
 * 已安装但未加载（即「已禁用」），dsh 自己的 reconcile 也刻意不重新启用这类依赖。
 * 因此禁用/启用 = 从该数组移除/加回插件名，绝不动 `dependencies`。
 *
 * 写前持锁、写时原子替换，与 dsh 的 `@deepseek-ai/dsh-atomic-write` 同协议
 * （`wx` 创建 `<package.json>.lock`、内容为持有者 pid、持有者已退出可接管、
 * 超时放弃），避免与 `dsh plugin add/remove` 或 Web 端插件页并发写坏 profile。
 */
import { open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** 锁等待上限：dsh 自己的默认值（2s）；超时宁可报错也不冒写坏的风险。 */
const LOCK_WAIT_MS = 2_000
const LOCK_RETRY_MIN_MS = 20
const LOCK_RETRY_MAX_MS = 200

export interface ProfileBundles {
  /** 当前加载清单（`dsh.profile.bundles`）；缺失时为空数组。 */
  bundles: string[]
  /** 已安装依赖名（用于校验目标确实是本 profile 的插件）。 */
  dependencies: string[]
}

export interface ProfileBundleStore {
  /** 读加载清单；profile 的 package.json 缺失或不可解析时返回 null（调用方按「未知」处理）。 */
  read(profileDir: string): Promise<ProfileBundles | null>
  /**
   * 启用/禁用某插件：把它加入或移出 `dsh.profile.bundles`，其余字段原样保留。
   * `insertAt` 用于「重新启用时恢复到原索引」（越界则追加到末尾）。
   * @returns 变更后的加载清单。
   */
  setEnabled(
    profileDir: string,
    name: string,
    enabled: boolean,
    insertAt?: number
  ): Promise<string[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 锁的持有者进程是否已退出（ESRCH）；存活或无法判定都返回 false（继续等）。 */
async function lockHolderGone(lockPath: string): Promise<boolean> {
  let pid: number
  try {
    pid = Number((await readFile(lockPath, 'utf8')).trim())
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
  }
  await rm(lockPath, { force: true }).catch(() => undefined)
  return true
}

/** 按 dsh 同款协议持锁执行；超时抛错（调用方转成可读的 IPC 失败原因）。 */
async function withFileLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  let delay = LOCK_RETRY_MIN_MS
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      if (await lockHolderGone(lockPath)) continue
    }
    if (Date.now() >= deadline) {
      throw new Error(`profile 正被 dsh 占用（${lockPath}），请稍后重试`)
    }
    await sleep(delay)
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined)
  }
}

/** 原子替换写入（临时文件 + rename），权限与 dsh 一致（0o600）。 */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  const handle = await open(tmp, 'w', 0o600)
  try {
    await handle.writeFile(content, 'utf8')
  } finally {
    await handle.close()
  }
  await rename(tmp, file)
}

export function createProfileBundleStore(): ProfileBundleStore {
  const manifestPath = (profileDir: string): string => join(profileDir, 'package.json')

  return {
    async read(profileDir: string): Promise<ProfileBundles | null> {
      try {
        const manifest: unknown = JSON.parse(await readFile(manifestPath(profileDir), 'utf8'))
        if (!isRecord(manifest)) return null
        const profile =
          isRecord(manifest.dsh) && isRecord(manifest.dsh.profile) ? manifest.dsh.profile : {}
        const bundles = Array.isArray(profile.bundles)
          ? profile.bundles.filter((item): item is string => typeof item === 'string')
          : []
        const dependencies = isRecord(manifest.dependencies)
          ? Object.keys(manifest.dependencies)
          : []
        return { bundles, dependencies }
      } catch {
        return null
      }
    },

    async setEnabled(
      profileDir: string,
      name: string,
      enabled: boolean,
      insertAt?: number
    ): Promise<string[]> {
      const file = manifestPath(profileDir)
      return withFileLock(file, async () => {
        let manifest: unknown
        try {
          manifest = JSON.parse(await readFile(file, 'utf8'))
        } catch {
          throw new Error('该实例的 profile 尚未初始化（缺少 package.json），请先启动一次实例')
        }
        if (!isRecord(manifest)) throw new Error('profile package.json 结构异常，未做改动')
        const dsh = isRecord(manifest.dsh) ? manifest.dsh : {}
        const profile = isRecord(dsh.profile) ? dsh.profile : {}
        const current = Array.isArray(profile.bundles)
          ? profile.bundles.filter((item): item is string => typeof item === 'string')
          : []
        const without = current.filter((item) => item !== name)
        let bundles: string[]
        if (!enabled) {
          bundles = without
        } else if (current.includes(name)) {
          bundles = current
        } else {
          const at =
            insertAt !== undefined && insertAt >= 0 && insertAt <= without.length
              ? insertAt
              : without.length
          bundles = [...without.slice(0, at), name, ...without.slice(at)]
        }
        // 无变化时不写：避免无谓地触碰文件（dsh 的 reconcile 同样如此）。
        if (
          bundles.length === current.length &&
          bundles.every((item, index) => item === current[index])
        ) {
          return current
        }
        manifest.dsh = { ...dsh, profile: { ...profile, bundles } }
        await writeFileAtomic(file, `${JSON.stringify(manifest, undefined, 2)}\n`)
        return bundles
      })
    }
  }
}
