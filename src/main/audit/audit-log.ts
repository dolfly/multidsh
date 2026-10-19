/**
 *
 * `<dataRoot>/audit/audit.log`(JSONL),**按本地日历日轮转**为
 * `audit.log.<YYYY-MM-DD>`,归档超过 90 天删除 —— 命名与保留策略镜像
 * `dsh-auth-gateway` 的 `lib/audit-log.js`(便于两边对照 grep)。
 *
 * 1. **记录由白名单字段显式构造**,不做对象展开 —— 调用方多传的字段(哪怕误传
 *    密码)不会进入日志;`result` 截断到 64 字符;
 * 2. 只 append,不改写历史;`ts` 为 UTC ISO-8601(归档文件名用本地日,跨零点可能
 *    与 ISO 日期不同,与网关行为一致);
 * 3. **写失败绝不冒泡进业务流**:失败经 `onError` 上报,审计不可用不该让登录失败;
 * 4. 清理只删**严格匹配** `audit.log.<YYYY-MM-DD>` 的文件,目录里其它文件一律不碰。
 */
import { appendFile, link, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** 当日活动文件名 */
export const AUDIT_LOG_NAME = 'audit.log'

export const AUDIT_MAX_AGE_DAYS = 90

/** 单条 `result` 的最大长度(防御性截断,避免意外写入长文本) */
export const MAX_RESULT_LENGTH = 64

export const AUDIT_EVENTS = [
  'connect',
  'disconnect',
  'ssh-exit',
  'ssh-reconnect',
  'login-success',
  'login-failed',
  'rate-limited',
  'lockout',
  'session-revoked',
  'cookie-cleared',
  'vault-write',
  'vault-clear',
  'vault-unavailable'
] as const

export type AuditEvent = (typeof AUDIT_EVENTS)[number]

/** 调用方传入的审计入参:只有这三个白名单字段 */
export interface AuditEntry {
  instanceId?: string | null
  event: AuditEvent
  /** 结果码(如 `ok` / `invalid-credentials` / `otp-required`);会被截断 */
  result?: string
}

/** 实际落盘的一条记录 */
export interface AuditRecord {
  ts: string
  instanceId: string | null
  event: AuditEvent
  result: string
}

export interface AuditLogOptions {
  /** 审计目录(通常 `<userData>/audit`) */
  dir: string
  /** 注入时钟(测试) */
  now?: () => number
  /** 失败上报(默认 console.error);审计不可用不应影响业务 */
  onError?: (error: unknown) => void
  /** 归档保留天数 */
  maxAgeDays?: number
}

export interface AuditLog {
  /** 追加一条审计记录;永不抛(失败经 onError 上报) */
  write(entry: AuditEntry): Promise<void>
  /** 删除过期归档;返回被删除的文件名 */
  prune(): Promise<string[]>
  /** 当日活动文件路径 */
  logPath(): string
  /** 已写入的记录数(测试/自检用) */
  count(): number
}

/** 本地日历日 `YYYY-MM-DD`(归档文件名用本地日,与网关一致) */
function localDay(date: Date): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

const ARCHIVE_PATTERN = /^audit\.log\.(\d{4}-\d{2}-\d{2})$/

/**
 * 从归档文件名解析归档日 `YYYY-MM-DD`(无时区歧义,按本地日比较)。
 *
 * 保留期用**日历日**而非时刻比较:归档名只有日期,拿它与 `now - 90天` 的
 * **时刻**比较会在一天中的前半段/后半段给出不同结论(边界日 ±1 天不确定)。
 * 统一按本地日字符串比较(ISO 日期可直接字典序比较)。
 */
function archiveStamp(name: string): string | null {
  const matched = ARCHIVE_PATTERN.exec(name)
  const stamp = matched?.[1]
  if (!stamp) return null
  const [year, month, day] = stamp.split('-').map(Number) as [number, number, number]
  const date = new Date(year, month - 1, day)
  // 拒绝 2026-13-45 这类形状合法但日期不存在的名字
  return localDay(date) === stamp ? stamp : null
}

/**
 * 记录的白名单投影:显式逐字段构造(不 spread),并截断 `result`。
 * 这是「审计不含凭据」的结构性保证 —— 调用方无法把额外字段带进日志。
 */
export function projectAuditRecord(entry: AuditEntry, isoNow: string): AuditRecord {
  const result = (entry.result ?? 'ok').slice(0, MAX_RESULT_LENGTH)
  return {
    ts: isoNow,
    instanceId: entry.instanceId ?? null,
    event: entry.event,
    result
  }
}

export function createAuditLog(options: AuditLogOptions): AuditLog {
  const dir = options.dir
  const now = options.now ?? (() => Date.now())
  const maxAgeDays = options.maxAgeDays ?? AUDIT_MAX_AGE_DAYS
  const onError =
    options.onError ?? ((error: unknown) => console.error('[audit] 写入失败：', error))

  let written = 0
  /** 当前活动文件所属的本地日(首次写入前为 null) */
  let liveDay: string | null = null
  /** 串行化:并发 append 交错会让轮转与写入互相踩(轮转需在写前完成) */
  let tail: Promise<void> = Promise.resolve()

  /**
   * 从活动文件末尾读取最后一条记录的日期,用于恢复 liveDay。
   * 重启后若不恢复,当天的记录会与前一天的记录混在同一文件里(轮转被跳过)。
   */
  async function probeLiveDay(): Promise<string | null> {
    try {
      const content = await readFile(logPath(), 'utf8')
      // 从末尾找最后一条 JSONL 行(避免读取整个大文件)
      const lastNewline = content.lastIndexOf('\n', content.length - 2)
      const lastLine = (lastNewline >= 0 ? content.slice(lastNewline + 1) : content).trim()
      if (lastLine === '') return null
      const record = JSON.parse(lastLine) as { ts?: string }
      if (typeof record.ts !== 'string') return null
      // ts 是 ISO-8601 UTC,用本地日解析(与 localDay 一致)
      const date = new Date(record.ts)
      return localDay(date)
    } catch {
      return null
    }
  }

  const logPath = (): string => join(dir, AUDIT_LOG_NAME)

  /** 轮转:把上一个写入日的活动文件改名为其归属日的归档 */
  async function rotateIfNeeded(today: string): Promise<void> {
    if (liveDay === null || liveDay === today) {
      liveDay = today
      return
    }
    const live = logPath()
    const archive = join(dir, `${AUDIT_LOG_NAME}.${liveDay}`)
    try {
      // link + unlink:活动文件换名后,后续 appendFile 不会写进已归档文件
      await link(live, archive)
      await unlink(live)
    } catch {
      // 轮转失败(如活动文件不存在)隔离处理:继续往当前活动文件写
    }
    liveDay = today
  }

  async function appendLine(record: AuditRecord): Promise<void> {
    const today = localDay(new Date(now()))
    // 首次写入时从已有文件恢复 liveDay:重启后若不恢复,当天记录会与前一天混在同一文件
    if (liveDay === null) liveDay = await probeLiveDay()
    await mkdir(dir, { recursive: true })
    await rotateIfNeeded(today)
    await appendFile(logPath(), `${JSON.stringify(record)}\n`, { mode: 0o600 })
    written += 1
  }

  return {
    logPath,
    count: () => written,

    async write(entry) {
      const record = projectAuditRecord(entry, new Date(now()).toISOString())
      // 串行链:一次失败不阻断后续写入(onError 已消化)
      tail = tail.then(
        () => appendLine(record),
        () => appendLine(record)
      )
      try {
        await tail
      } catch (error) {
        onError(error)
      }
    },

    async prune() {
      // 保留期按本地日历日计算:归档日 < cutoffDay 才删
      const cutoffDay = localDay(new Date(now() - maxAgeDays * 24 * 60 * 60 * 1000))
      const removed: string[] = []
      try {
        const names = await readdir(dir)
        for (const name of names) {
          // 只认严格归档名,目录里其它文件一律不碰
          const stamp = archiveStamp(name)
          if (!stamp || stamp >= cutoffDay) continue
          try {
            // 二次确认是普通文件(避免误删同名目录)
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
    }
  }
}
