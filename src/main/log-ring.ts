/**
 * 子进程输出的日志环形缓冲：把 stdout/stderr 的字节流切成整行，同时限制行数与残片大小，
 * 避免异常刷屏把内存吃光。本机启动与 SSH 隧道两处共用同一套切行规则。
 *
 * 行处理（如脱敏）由调用方注入：SSH 侧把日志用于错误归因，必须先剥掉行内 URL 的查询串
 * 防止 `?token=` 之类泄漏；本机启动侧的日志只用于匹配就绪 URL，不需要脱敏。
 */
/** 残片上限：无换行的超长单行异常输出只保留尾部。 */
const DEFAULT_MAX_CHARS = 64 * 1024

/** 缓冲宿主：调用方在自己的条目上持有这两块状态。 */
export interface LogBufferTarget {
  log: string[]
  buffer: string
}

export interface LogRingOptions {
  /** 保留的最大日志行数，超出丢弃最旧的。 */
  maxLines: number
  /** 单条未完成行的最大字符数（缺省 64 KiB）。 */
  maxChars?: number
  /** 每行写入日志前的处理；缺省原样保留。 */
  transformLine?: (line: string) => string
}

export interface LogRing {
  /** 追加一段输出；返回本次产出的完整行（已按 transformLine 处理）。 */
  push(target: LogBufferTarget, chunk: unknown): string[]
  /** 把未满一行的尾部残片也推入日志（进程退出等不再有后续输出时调用）。 */
  drain(target: LogBufferTarget): void
}

export function createLogRing(options: LogRingOptions): LogRing {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const transformLine = options.transformLine ?? ((line: string) => line)

  function trim(target: LogBufferTarget): void {
    if (target.log.length > options.maxLines)
      target.log.splice(0, target.log.length - options.maxLines)
  }

  return {
    push(target, chunk) {
      target.buffer += String(chunk)
      // 无换行残片上限：只保留尾部防无界增长。
      if (target.buffer.length > maxChars) target.buffer = target.buffer.slice(-maxChars)
      const lines: string[] = []
      let newlineIndex: number
      while ((newlineIndex = target.buffer.indexOf('\n')) !== -1) {
        const line = target.buffer.slice(0, newlineIndex).replace(/\r$/, '')
        target.buffer = target.buffer.slice(newlineIndex + 1)
        if (line.trim() !== '') lines.push(transformLine(line))
      }
      if (lines.length > 0) {
        target.log.push(...lines)
        trim(target)
      }
      return lines
    },

    drain(target) {
      const trailing = target.buffer.trim()
      if (trailing !== '') target.log.push(transformLine(trailing))
      target.buffer = ''
      trim(target)
    }
  }
}
