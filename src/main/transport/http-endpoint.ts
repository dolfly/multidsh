/**
 * HTTP 直连传输 —— 不 import Electron。
 *
 * 远程实例没有本地进程可管：`start` = 校验端点 → 健康探测 → 认证模式探测
 * → 发布 running（携带探测结论）；`stop` = 发布 stopped（无进程回收）。
 */
import type { HttpInstance, InstanceStatusEvent } from '@shared/contracts'
import { parseEndpointUrl } from '@shared/endpoint'
import { detectAuthMode, type AuthDetection } from '../auth/detect'
import { httpDirectEndpoint } from './endpoint-resolver'
import { httpHealthProbe, retryProbe, type HealthProbe } from './probe'
import { createStatusBus } from './status-bus'

export interface HttpEndpointOptions {
  probe?: HealthProbe
  detect?: (url: string) => Promise<AuthDetection>
  healthTimeoutMs?: number
  healthProbeRetries?: number
  healthProbeRetryMs?: number
  now?: () => number
}

export interface HttpEndpointManager {
  onStatus(listener: (event: InstanceStatusEvent) => void): () => void
  statusOf(id: string): InstanceStatusEvent | null
  runningIds(): string[]
  start(instance: HttpInstance): Promise<void>
  stop(id: string): Promise<void>
  stopAll(): Promise<void>
}

interface Entry {
  id: string
  url: string
  detection: AuthDetection | null
  stopping: boolean
  current: () => boolean
}

export function createHttpEndpoints(options: HttpEndpointOptions = {}): HttpEndpointManager {
  const probe = options.probe ?? httpHealthProbe
  const detect = options.detect ?? ((url: string) => detectAuthMode(url))
  const healthTimeoutMs = options.healthTimeoutMs ?? 5_000
  // 就绪探测重试次数默认 5 次，与本机实例一致；见 probe.ts 的 retryProbe。
  const healthProbeRetries = options.healthProbeRetries ?? 5
  const healthProbeRetryMs = options.healthProbeRetryMs ?? 500
  const now = options.now ?? (() => Date.now())

  const entries = new Map<string, Entry>()
  /** 同 id 启动串行链:并发 start 依次执行,保证 stop→start 的「重启」语义生效 */
  const startChains = new Map<string, Promise<void>>()
  /** 取消代号:stop() 递增;启动任务记录自己发起时的代号,若期间被 stop 则作废 */
  const cancelGen = new Map<string, number>()

  const bus = createStatusBus(now, 'http-endpoint')
  const { emit, onStatus, statusOf } = bus

  /** 探测结论 → 面向用户的一句话（不含凭据） */
  function detectionDetail(detection: AuthDetection): string {
    switch (detection.mode) {
      case 'gateway':
        return `检测到登录认证（${detection.evidence}）`
      case 'browser-auth':
        return '检测到 dsh 内置浏览器认证（页面内自认证）'
      case 'none':
        return '无需登录认证，可直接访问'
      default:
        return detection.evidence
    }
  }

  async function runStart(instance: HttpInstance, myGen: number): Promise<void> {
    const id = instance.id
    let entry: Entry | null = null
    const cancelled = (): boolean => (cancelGen.get(id) ?? 0) !== myGen
    try {
      const url = httpDirectEndpoint(instance)
      const created: Entry = {
        id,
        url,
        detection: null,
        stopping: false,
        current: () => entries.get(id) === created
      }
      entry = created
      entries.set(id, created)
      emit(id, 'starting', { detail: `校验端点 ${url}` })

      const healthy = await retryProbe({
        url,
        probe,
        retries: healthProbeRetries,
        retryMs: healthProbeRetryMs,
        timeoutMs: healthTimeoutMs,
        shouldAbort: () => cancelled() || created.stopping || !created.current()
      })
      if (healthy === null) return
      if (!healthy) {
        entries.delete(id)
        emit(id, 'error', { detail: `端点不可达：${url}（连接被拒或超时）`, url })
        return
      }

      let detection: AuthDetection | null = null
      if (instance.authMode === 'auto') {
        emit(id, 'starting', { url, detail: '探测认证模式' })
        detection = await detect(url)
        if (cancelled() || created.stopping || !created.current()) return
        created.detection = detection
      }
      if (cancelled() || created.stopping || !created.current()) return
      emit(id, 'running', {
        url,
        detail:
          instance.authMode === 'auto' && detection
            ? detectionDetail(detection)
            : instance.authMode === 'none'
              ? '按配置跳过登录认证'
              : '按配置使用网关登录'
      })
    } catch (error) {
      // 校验/探测失败:未被取消、且没有更新的条目时才报错(避免陈旧 start 误报)
      if (cancelled()) return
      if (entry === null) {
        // 端点校验在创建条目前抛错(非法 URL):仍应让用户看到原因
        emit(id, 'error', {
          detail: error instanceof Error ? error.message : String(error)
        })
        return
      }
      if (entry.current()) {
        entries.delete(id)
        emit(id, 'error', {
          detail: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  /** stop 的具名实现(避免 stopAll 依赖 this 绑定) */
  async function stopById(id: string): Promise<void> {
    cancelGen.set(id, (cancelGen.get(id) ?? 0) + 1)
    const entry = entries.get(id)
    if (!entry) {
      emit(id, 'stopped', { detail: '实例未在运行' })
      return
    }
    entry.stopping = true
    entries.delete(id)
    emit(id, 'stopped', { detail: '已停止' })
  }

  return {
    onStatus,
    statusOf,

    runningIds() {
      return [...entries.keys()]
    },

    async start(instance) {
      const id = instance.id
      const existing = entries.get(id)
      if (existing) {
        const current = statusOf(id)
        const running = current?.status === 'running'
        emit(id, running ? 'running' : 'starting', {
          url: existing.url,
          detail: running ? '实例已在运行，忽略重复启动' : (current?.detail ?? '正在校验端点')
        })
        return
      }
      // 串行化同 id 启动:排队期间若被 stop,则本次排队作废(重启意图由后续 start 承担)
      const myGen = cancelGen.get(id) ?? 0
      const previous = startChains.get(id) ?? Promise.resolve()
      const next = previous.then(async () => {
        // 期间发生过 stop → 本次启动作废(stop 之后的 start 有自己的代号,不受影响)
        if ((cancelGen.get(id) ?? 0) !== myGen || entries.get(id)?.stopping === true) return
        if (entries.has(id)) {
          const current = entries.get(id)
          const status = statusOf(id)
          const running = status?.status === 'running'
          emit(id, running ? 'running' : 'starting', {
            ...(current ? { url: current.url } : {}),
            detail: running ? '实例已在运行，忽略重复启动' : (status?.detail ?? '正在校验端点')
          })
          return
        }
        await runStart(instance, myGen)
      })
      const chained = next
        .catch(() => undefined)
        .finally(() => {
          if (startChains.get(id) === chained) startChains.delete(id)
        })
      startChains.set(id, chained)
      return next
    },

    stop: stopById,

    async stopAll() {
      // 除在跑条目外,也要作废「已排队但尚未建立条目」的启动(before-quit 不留窗口)
      const ids = new Set([...entries.keys(), ...startChains.keys()])
      await Promise.all([...ids].map((id) => stopById(id)))
    }
  }
}

/** 供向导 Step3 urlDetect 复用的只读探测（不建立实例、不写注册表） */
export async function detectDraftEndpoint(rawUrl: string): Promise<AuthDetection> {
  const normalized = parseEndpointUrl(rawUrl) // 非法输入在此抛出,由 IPC 边界转 invalid-input
  return detectAuthMode(`${normalized.baseUrl}/`)
}
