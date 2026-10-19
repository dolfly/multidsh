/**
 *
 * 把主进程侧的「需要用户决策」请求（主机指纹确认、SSH 口令、运行时二次确认）转成
 * 渲染层对话框，并等待回答：
 * - 指纹确认：超时/无人应答 → 默认 **拒绝**（安全优先，绝不默认信任）；
 * - 口令：超时/无人应答 → 默认 **取消**（ssh 鉴权失败并由归因分类）；
 * - 运行时确认（dsh 下载 / 系统默认 dsh 全局升级）：超时/无人应答 → 默认 **拒绝**
 *   （绝不静默下载或改写全局安装）；待答项保留快照供渲染层挂载时补拉。
 *
 * 口令只在内存中流转：不写盘、不写日志、不进审计。
 */
import { randomUUID } from 'node:crypto'
import { DSH_VERSION_IPC, SSH_IPC } from '@shared/contracts'
import type {
  AskpassPromptPayload,
  HostKeyDecision,
  HostKeyPromptPayload,
  RuntimeConfirmPromptPayload,
  RuntimeConfirmRequest
} from '@shared/contracts'

export interface PromptBrokerOptions {
  /** 把请求投递给 hub 渲染窗口（多个窗口都要能收到，先到先答） */
  send: (channel: string, payload: unknown) => void
  hostKeyTimeoutMs?: number
  askpassTimeoutMs?: number
  confirmTimeoutMs?: number
}

export interface PromptBroker {
  /** TOFU 指纹确认（tunnel manager 注入用） */
  requestHostKey(request: Omit<HostKeyPromptPayload, 'requestId'>): Promise<HostKeyDecision>
  /** SSH 口令输入（tunnel manager 注入用）；null = 取消 */
  requestAskpass(request: Omit<AskpassPromptPayload, 'requestId'>): Promise<string | null>
  /** 运行时二次确认（装配层的 confirmDownload / confirmSystemUpgrade 注入用）；false = 拒绝 */
  requestConfirm(request: RuntimeConfirmRequest): Promise<boolean>
  /** 渲染层回复（IPC 通道） */
  replyHostKey(requestId: string, decision: HostKeyDecision): boolean
  replyAskpass(requestId: string, secret: string | null): boolean
  replyConfirm(requestId: string, accepted: boolean): boolean
  /** 待答确认快照；渲染层挂载时补拉，避免「事件早于订阅」丢请求 */
  listConfirms(): RuntimeConfirmPromptPayload[]
  /** 关闭窗口/退出时清空所有待答请求 */
  cancelAll(): void
}

interface Pending<T> {
  resolve: (value: T) => void
  timer: NodeJS.Timeout
}

interface PendingConfirm {
  resolve: (value: boolean) => void
  timer: NodeJS.Timeout
  payload: RuntimeConfirmPromptPayload
}

export function createPromptBroker(options: PromptBrokerOptions): PromptBroker {
  const hostKeyTimeoutMs = options.hostKeyTimeoutMs ?? 5 * 60 * 1000
  const askpassTimeoutMs = options.askpassTimeoutMs ?? 10 * 60 * 1000
  const confirmTimeoutMs = options.confirmTimeoutMs ?? 5 * 60 * 1000
  const pendingHostKeys = new Map<string, Pending<HostKeyDecision>>()
  const pendingAskpass = new Map<string, Pending<string | null>>()
  const pendingConfirms = new Map<string, PendingConfirm>()

  return {
    requestHostKey(request) {
      const requestId = randomUUID()
      return new Promise<HostKeyDecision>((resolve) => {
        const timer = setTimeout(() => {
          pendingHostKeys.delete(requestId)
          resolve('reject') // 无人确认 = 不信任
        }, hostKeyTimeoutMs)
        timer.unref?.()
        pendingHostKeys.set(requestId, { resolve, timer })
        options.send(SSH_IPC.hostKeyDecision, { ...request, requestId })
      })
    },

    requestAskpass(request) {
      const requestId = randomUUID()
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          pendingAskpass.delete(requestId)
          resolve(null) // 超时 = 取消
        }, askpassTimeoutMs)
        timer.unref?.()
        pendingAskpass.set(requestId, { resolve, timer })
        options.send(SSH_IPC.askpassRequest, { ...request, requestId })
      })
    },

    requestConfirm(request) {
      const requestId = randomUUID()
      const payload = { ...request, requestId } as RuntimeConfirmPromptPayload
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          pendingConfirms.delete(requestId)
          resolve(false) // 超时/无人应答 = 拒绝，绝不静默下载或全局升级
        }, confirmTimeoutMs)
        timer.unref?.()
        pendingConfirms.set(requestId, { resolve, timer, payload })
        options.send(DSH_VERSION_IPC.confirmRequest, payload)
      })
    },

    replyHostKey(requestId, decision) {
      const entry = pendingHostKeys.get(requestId)
      if (!entry) return false
      pendingHostKeys.delete(requestId)
      clearTimeout(entry.timer)
      entry.resolve(decision === 'trust' ? 'trust' : 'reject')
      return true
    },

    replyAskpass(requestId, secret) {
      const entry = pendingAskpass.get(requestId)
      if (!entry) return false
      pendingAskpass.delete(requestId)
      clearTimeout(entry.timer)
      entry.resolve(typeof secret === 'string' ? secret : null)
      return true
    },

    replyConfirm(requestId, accepted) {
      const entry = pendingConfirms.get(requestId)
      if (!entry) return false
      pendingConfirms.delete(requestId)
      clearTimeout(entry.timer)
      entry.resolve(accepted === true)
      return true
    },

    listConfirms() {
      return [...pendingConfirms.values()].map((entry) => entry.payload)
    },

    cancelAll() {
      for (const [requestId, entry] of pendingHostKeys) {
        clearTimeout(entry.timer)
        entry.resolve('reject')
        pendingHostKeys.delete(requestId)
      }
      for (const [requestId, entry] of pendingAskpass) {
        clearTimeout(entry.timer)
        entry.resolve(null)
        pendingAskpass.delete(requestId)
      }
      for (const [requestId, entry] of pendingConfirms) {
        clearTimeout(entry.timer)
        entry.resolve(false)
        pendingConfirms.delete(requestId)
      }
    }
  }
}
