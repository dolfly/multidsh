/**
 * 本机实例的就绪续体：stdout 打印出就绪 URL 之后，校验它、探测健康、发布 running。
 *
 * 这段必须防两类陈旧续体问题（注释见函数内）：探测期间进程已退出时不得再发布状态；
 * 失败终局必须与超时路径对齐——杀进程、清条目、放行队列，缺任一项都会造成
 * head-of-line 阻塞与无人回收的存活进程。
 *
 * 状态只经注入的 `emit` 向外发布，本模块可脱离 Electron 单独测试。
 */
import { isLoopbackHost } from '@shared/endpoint'
import { redactLine } from '@shared/redact'
import type { InstanceStatusEvent } from '@shared/contracts'
import { retryProbe } from '../transport/probe'
import type { HealthProbe } from '../transport/probe'
import type { Entry } from './entry'

export interface ReadyMonitorDeps {
  /** 条目注册表：续体用它判断自己是否仍代表当前实例（身份守卫）。 */
  entries: Map<string, Entry>
  /** 状态发布。 */
  emit(id: string, status: InstanceStatusEvent['status'], payload: object): void
  /** 健康探测实现。 */
  probe: HealthProbe
  /** 健康探测重试次数与间隔。 */
  healthProbeRetries: number
  healthProbeRetryMs: number
  /** 单次探测超时。 */
  healthTimeoutMs: number
  /** 杀掉条目的整个进程树（外部接管条目无子进程时为空操作）。 */
  killTree(entry: Entry, signal: NodeJS.Signals): void
}

export function createReadyMonitor(deps: ReadyMonitorDeps) {
  return async function handleReady(id: string, entry: Entry, url: string): Promise<void> {
    /** 终局：杀进程、清条目、放行队列。三条路径（解析失败 / 探测失败 / 捕获）共用。 */
    const failReady = (error: unknown): void => {
      if (entry.stopping || deps.entries.get(id) !== entry) return
      deps.emit(id, 'error', {
        detail: error instanceof Error ? `解析就绪地址失败：${error.message}` : '解析就绪地址失败'
      })
      entry.stopping = true
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      deps.killTree(entry, 'SIGKILL')
      deps.entries.delete(id)
      entry.settleSpawn?.()
    }
    try {
      // dsh 打印的就绪 URL 直接喂给内嵌工作区视图：host 必须钉在回环，否则被篡改的
      // stdout 行（`dsh web: http://attacker/…`）会让 hub 在工作区加载远端 origin。
      let readyUrl: URL
      try {
        readyUrl = new URL(url)
      } catch {
        failReady(new Error('就绪 URL 无法解析'))
        return
      }
      if (!isLoopbackHost(readyUrl.hostname)) {
        failReady(new Error(`就绪 URL 主机非回环地址（${readyUrl.hostname}），已拒绝`))
        return
      }
      // 在途续体身份守卫:探测/重试期间本条目的进程可能已退出(退出处理器会删条目并立即
      // 放行队列,同 id 的第二次 start 随即拉起新进程)。陈旧续体不得再发布 running、
      // 也不得在失败终局里 `entries.delete(id)` 误删新条目 —— 否则活进程沦为无主,
      // 下次 start 又 spawn 一个,两个 dsh 共享同一 DSH_HOME。
      const stale = (): boolean => entry.stopping || deps.entries.get(id) !== entry
      const healthy = await retryProbe({
        url,
        probe: deps.probe,
        retries: deps.healthProbeRetries,
        retryMs: deps.healthProbeRetryMs,
        timeoutMs: deps.healthTimeoutMs,
        shouldAbort: stale
      })
      if (healthy === null) return
      if (!healthy) {
        // 终局路径必须与超时路径对齐:杀进程、清条目、放行队列。
        // 缺失任一项都会造成 head-of-line 阻塞(下一个实例等到 readyTimer 触发)
        // 与无人回收的存活进程。
        deps.emit(id, 'error', {
          detail: redactLine(
            `就绪 URL 无法访问（健康探测 ${deps.healthProbeRetries} 次失败）：${url}`
          )
        })
        entry.stopping = true
        if (entry.timer) {
          clearTimeout(entry.timer)
          entry.timer = null
        }
        deps.killTree(entry, 'SIGKILL')
        deps.entries.delete(id)
        entry.settleSpawn?.()
        return
      }
      if (entry.timer) {
        clearTimeout(entry.timer)
        entry.timer = null
      }
      entry.ready = true
      entry.url = url
      const port = Number(readyUrl.port)
      entry.port = Number.isInteger(port) && port > 0 ? port : null
      if (stale()) return
      deps.emit(id, 'running', {
        version: entry.version,
        runtimeSource: entry.runtimeSource,
        ...(entry.port !== null ? { port: entry.port } : {}),
        ...(entry.command !== undefined ? { command: entry.command } : {}),
        detail: `已在 ${entry.home} 启动（dsh web）`
      })
      entry.settleSpawn?.() // 排他地放行下一个实例的启动
    } catch (error) {
      failReady(error)
    }
  }
}
