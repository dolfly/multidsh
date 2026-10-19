/**
 * 主进程日志落盘：把 `console.*` 输出经脱敏后追加到 `<dataRoot>/logs/main.log`，
 * 按本地日历日轮转为 `main.log.<YYYY-MM-DD>`，归档保留 90 天 —— 命名与保留
 * 策略镜像 audit-log（便于两边对照 grep）。
 *
 * 约束：
 * 1. 只捕获主进程经 console 的输出（Electron/Chromium 直写 stderr 的内容不捕获）；
 * 2. 每行先过 `redactLine` + `redactSecret`：密码、OTP、Cookie、私钥、令牌等
 *    凭据形态一律不进文件（AGENTS.md 的日志红线，与审计同级）；
 * 3. 写失败绝不冒泡进业务流：失败经 onError 上报并回落原生 console，日志不可用
 *    不影响任何业务；追加串行化，行序与轮转不交错；
 * 4. 清理只删严格匹配 `main.log.<YYYY-MM-DD>` 的文件，目录里其它文件一律不碰。
 */
import { appendFile, link, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { format } from 'node:util'
import { redactLine, redactSecret } from '@shared/redact'

/** 当日活动文件名 */
export const MAIN_LOG_NAME = 'main.log'

export const MAIN_LOG_MAX_AGE_DAYS = 90

/** console 方法名 → 落盘级别标识 */
const LEVELS: Readonly<Record<string, string>> = {
  error: 'ERROR',
  warn: 'WARN',
  info: 'INFO',
  log: 'INFO',
  debug: 'DEBUG',
  trace: 'TRACE'
}

const ARCHIVE_PATTERN = /^main\.log\.(\d{4}-\d{2}-\d{2})$/

export interface MainLogOptions {
  /** 日志目录（通常 `<userData>/logs`） */
  dir: string
  /** 注入时钟（测试） */
  now?: () => number
  /** 写失败上报（默认回落原生 console.error）；日志不可用不应影响业务 */
  onError?: (error: unknown) => void
  /** 归档保留天数 */
  maxAgeDays?: number
}

export interface MainLog {
  /** 当日活动文件路径 */
  logPath(): string
  /** 追加链已排空（测试用；生产无需调用） */
  flush(): Promise<void>
  /** 删除过期归档；返回被删除的文件名 */
  prune(): Promise<string[]>
  /** 恢复被替换的 console 方法并停写 */
  dispose(): void
}

/** 本地日历日 `YYYY-MM-DD`（归档文件名用本地日，与 audit-log 一致） */
function localDay(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 从归档文件名解析归档日；形状合法但日期不存在（如 2026-13-45）返回 null */
function archiveStamp(name: string): string | null {
  const matched = ARCHIVE_PATTERN.exec(name)
  const stamp = matched?.[1]
  if (!stamp) return null
  const [year, month, day] = stamp.split('-').map(Number) as [number, number, number]
  const date = new Date(year, month - 1, day)
  return localDay(date) === stamp ? stamp : null
}

/** 当前已安装的实例；console 方法只替换一次，重复安装直接复用 */
let active: MainLog | null = null

export function installMainLogging(options: MainLogOptions): MainLog {
  if (active) return active
  const dir = options.dir
  const now = options.now ?? (() => Date.now())
  const maxAgeDays = options.maxAgeDays ?? MAIN_LOG_MAX_AGE_DAYS

  // 替换前先固定原生方法：onError 回落必须走原生 console，避免递归写日志
  const originals = new Map<string, (...args: unknown[]) => void>()
  for (const name of Object.keys(LEVELS)) {
    const original = (console as unknown as Record<string, (...args: unknown[]) => void>)[name]
    if (typeof original === 'function') originals.set(name, original)
  }
  const onError =
    options.onError ??
    ((error: unknown) => {
      // 回落提示只进原生 console（终端/开发模式），不经界面；用英文避免新增 i18n 债务
      const original = originals.get('error')
      if (original) original.call(console, '[main-log] write failed:', error)
    })

  let liveDay: string | null = null
  /** 串行化：行序按调用顺序落盘，轮转在写前完成 */
  let tail: Promise<void> = Promise.resolve()
  let disposed = false

  const logPath = (): string => join(dir, MAIN_LOG_NAME)

  /** 重启恢复：从活动文件末尾读最后一行的时间戳，恢复其归属日 */
  async function probeLiveDay(): Promise<string | null> {
    try {
      const content = await readFile(logPath(), 'utf8')
      const lastNewline = content.lastIndexOf('\n', content.length - 2)
      const lastLine = (lastNewline >= 0 ? content.slice(lastNewline + 1) : content).trim()
      if (lastLine === '') return null
      // 前缀固定 `YYYY-MM-DDTHH:mm:ss.sssZ`（与 write 的 ISO 格式一致）
      const date = new Date(lastLine.slice(0, 24))
      return Number.isNaN(date.getTime()) ? null : localDay(date)
    } catch {
      return null
    }
  }

  /** 轮转：活动文件归属日变化时改名归档（link + unlink，同 audit-log） */
  async function rotateIfNeeded(today: string): Promise<void> {
    if (liveDay === null || liveDay === today) {
      liveDay = today
      return
    }
    const live = logPath()
    const archive = join(dir, `${MAIN_LOG_NAME}.${liveDay}`)
    try {
      await link(live, archive)
      await unlink(live)
    } catch {
      // 轮转失败（如活动文件不存在）隔离处理：继续往当前活动文件写
    }
    liveDay = today
  }

  async function appendLine(line: string): Promise<void> {
    if (disposed) return
    const today = localDay(new Date(now()))
    if (liveDay === null) liveDay = await probeLiveDay()
    await mkdir(dir, { recursive: true })
    await rotateIfNeeded(today)
    await appendFile(logPath(), `${line}\n`, { mode: 0o600 })
  }

  function write(level: string, args: unknown[]): void {
    // 先脱敏再落盘：URL 查询串（?token=…）与键值对凭据形态都不进文件
    const message = redactLine(redactSecret(format(...args)))
    const line = `${new Date(now()).toISOString()} ${level} ${message}`
    tail = tail
      .then(
        () => appendLine(line),
        () => appendLine(line)
      )
      .catch(onError)
  }

  for (const [name, level] of Object.entries(LEVELS)) {
    const original = originals.get(name)
    if (!original) continue
    const patched = (...args: unknown[]): void => {
      // 先走原生输出（终端/开发模式可见），再异步落盘
      original.apply(console, args)
      write(level, args)
    }
    ;(console as unknown as Record<string, unknown>)[name] = patched
  }

  const handle: MainLog = {
    logPath,
    flush: () => tail,
    async prune() {
      // 保留期按本地日历日比较（同 audit-log）：归档日 < cutoffDay 才删
      const cutoffDay = localDay(new Date(now() - maxAgeDays * 24 * 60 * 60 * 1000))
      const removed: string[] = []
      try {
        const names = await readdir(dir)
        for (const name of names) {
          // 只认严格归档名，目录里其它文件一律不碰
          const stamp = archiveStamp(name)
          if (!stamp || stamp >= cutoffDay) continue
          try {
            // 二次确认是普通文件（避免误删同名目录）
            const info = await stat(join(dir, name))
            if (!info.isFile()) continue
            await unlink(join(dir, name))
            removed.push(name)
          } catch (error) {
            onError(error)
          }
        }
      } catch (error) {
        // 目录不存在等价于无归档
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') onError(error)
      }
      return removed
    },
    dispose() {
      disposed = true
      for (const [name, original] of originals) {
        ;(console as unknown as Record<string, unknown>)[name] = original
      }
      active = null
    }
  }
  active = handle
  return handle
}
