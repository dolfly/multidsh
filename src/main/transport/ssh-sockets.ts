/**
 * SSH 隧道的 control socket 目录规划。
 *
 * ControlPath 与 askpass socket 两处派生点共用同一目录：Unix domain socket 路径有
 * 长度上限，dataRoot 过长时退化到按用户隔离的临时目录；退化目录名可预测，故创建后
 * 还要校验属主与权限，不通过就换成随机目录并缓存。
 */
import { chmod, lstat, mkdir, mkdtemp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 退化目录的基址：优先 $XDG_RUNTIME_DIR（按用户隔离的 700 目录），再系统 tmpdir()。
 * 不直接信任其内容——目录本身的属主/权限仍由 ensureSocketsDir 校验。
 */
function socketsBaseDir(): string {
  const xdg = process.env['XDG_RUNTIME_DIR']
  return xdg !== undefined && xdg.trim() !== '' ? xdg : tmpdir()
}

/**
 * 校验失败时改用的随机目录（mkdtemp 按进程生成，他人无法预测/预建）。
 * 以 dataRoot 为键缓存，保证同进程内 ControlPath 与 askpass socket 路径一致。
 */
const socketsDirOverrides = new Map<string, string>()

export function socketsDirFor(dataRoot: string): string {
  const override = socketsDirOverrides.get(dataRoot)
  if (override !== undefined) return override
  const home = join(dataRoot, 'ssh')
  const worst = join(home, `ctl-${'0'.repeat(12)}`) // 名字最长形态
  if (worst.length + 17 < 104) return home
  return join(
    socketsBaseDir(),
    `dsh-hub-ssh-${createHash('sha1').update(dataRoot).digest('hex').slice(0, 8)}`
  )
}

/**
 * 确保 control/askpass socket 目录存在且仅当前用户可访问，返回实际目录。
 *
 * 退化目录（dataRoot 路径过长）名字可预测，同机其他用户可预建该目录：删换其中的
 * `ctl-*`/`ap-*` socket 可造成持久 DoS，绑定假控制套接字可接管复用连接。因此：
 * 1. mkdir(mode 0700) 后 chmod 0700，并 lstat 校验属主与权限（仅 POSIX）；
 * 2. 校验不过（他人预建/权限不收敛）→ mkdtemp(0700) 换随机目录并缓存，
 *    后续 socketsDirFor 一律返回该目录。
 * 结果按 dataRoot 记忆，ControlPath 与 askpass 两处派生点共用同一目录。
 */
export async function ensureSocketsDir(dataRoot: string): Promise<string> {
  const override = socketsDirOverrides.get(dataRoot)
  if (override !== undefined) return override
  const candidate = socketsDirFor(dataRoot)
  try {
    await mkdir(candidate, { recursive: true, mode: 0o700 })
    await chmod(candidate, 0o700)
    // Windows 临时目录按用户隔离，无共享预建面；mode/uid 语义也不同，跳过校验
    if (process.platform === 'win32') return candidate
    const info = await lstat(candidate)
    const uid = process.getuid?.()
    const ownerOk = uid === undefined || info.uid === uid
    if (ownerOk && (info.mode & 0o077) === 0) return candidate
  } catch {
    // mkdir/chmod/lstat 失败不阻断启动：改用随机目录
  }
  const fallback = await mkdtemp(join(socketsBaseDir(), 'dsh-hub-ssh-'))
  socketsDirOverrides.set(dataRoot, fallback)
  return fallback
}

/** 实例标识的 12 位 slug；ControlPath 与 askpass socket 共用，避免两套命名各自漂移。 */
export function controlSlug(instance: { id: string }): string {
  return instance.id.replace(/-/g, '').slice(0, 12)
}
