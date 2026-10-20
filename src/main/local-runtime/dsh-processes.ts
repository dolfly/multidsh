/**
 * 从进程表里挑出「本机在跑的 dsh web」，并排除 Hub 自己拉起的那些。
 *
 * 判定分两件事，缺一不可：
 * - **命令行判定**：这一行是不是一次 dsh web profile 启动（见 `dsh-command.ts`）——
 *   决定「它是不是 dsh」；
 * - **进程树判定**：它是不是 Hub 主进程的子孙（见 `process-table.ts`）——
 *   决定「它是不是 Hub 自己管的」。
 *
 * 两者同形：Hub spawn 的实例与用户手敲的 dsh 命令行完全一致，只能靠进程树区分。
 */
import { redactLine, redactSecret } from '@shared/redact'
import { findDshWebArgs, patchOf, portOf } from './dsh-command'
import type { ProcessEntry } from './process-table'

/** 探测到的一个外部 dsh web 进程 */
export interface ExternalDshWeb {
  pid: number
  /** 父进程 pid;用于判定该进程是否由 Hub 自己拉起 */
  ppid: number
  /** 监听端口;null = 未能确定(无 --port 且 lsof 未给出) */
  port: number | null
  /** `--patch <file>` 的取值(如 ~/.dush/cordis.dush.patch.yml);null = 未使用 patch */
  patch: string | null
  /** 命令行(已折叠空白、截断并脱敏,仅供展示) */
  command: string
}

/**
 * 展示用命令行的最大长度(避免 UI 被超长命令行撑破)。
 *
 * 截断与脱敏都在**构造结果对象**这一步做(见 `selectDshWebProcesses`),让
 * 「已脱敏、已截断」成为结果类型的性质,而不是每个调用点的自觉。
 */
const COMMAND_DISPLAY_MAX = 240

/** 折叠空白、截断并脱敏,得到可展示的命令行 */
function displayCommand(command: string): string {
  const truncated =
    command.length > COMMAND_DISPLAY_MAX ? `${command.slice(0, COMMAND_DISPLAY_MAX)}…` : command
  // 命令行原样出到界面会带出用户自己写在参数里的凭据(dsh 的 token/cookie
  // 形态都在命令行上),这里统一脱敏后再交给界面。
  return redactSecret(redactLine(truncated))
}

/**
 * 从进程表里挑出 dsh web 进程,并排除 Hub 自己拉起的那些。
 *
 * excludePids 由调用方给出(通常是 Hub 主进程的整棵子树);同一 pid 只上报一次。
 */
export function selectDshWebProcesses(
  entries: ProcessEntry[],
  excludePids: ReadonlySet<number> = new Set()
): ExternalDshWeb[] {
  const found: ExternalDshWeb[] = []
  const seen = new Set<number>()
  for (const entry of entries) {
    if (seen.has(entry.pid) || excludePids.has(entry.pid)) continue
    const args = findDshWebArgs(entry.command)
    if (args === null) continue
    seen.add(entry.pid)
    const argsText = args.join(' ')
    found.push({
      pid: entry.pid,
      ppid: entry.ppid,
      port: portOf(argsText),
      patch: patchOf(argsText),
      command: displayCommand(entry.command)
    })
  }
  return found
}
