import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { vi } from 'vitest'
import type { InstanceStatusEvent } from '@shared/contracts'
import type { SpawnedProcess } from './spawn'
import type { SshTunnelManager } from './ssh-tunnel'

export interface FakeChild extends SpawnedProcess {
  stdout: PassThrough
  stderr: PassThrough
  emit(event: string, ...args: unknown[]): boolean
  killCall: NodeJS.Signals[]
}

/** 自增递减的假 pid：同一用例里多个子进程需要互相可区分。 */
let pidCounter = 900000

/** 假子进程：带可写 stdout/stderr 与 kill 调用记录，默认 kill 只记录信号并返回 true。 */
export function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as unknown as FakeChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = pidCounter--
  child.killCall = []
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killCall.push(signal ?? 'SIGTERM')
    return true
  }) as never
  return child
}

/**
 * 等隧道到达目标状态。
 *
 * CI 的 Windows runner 负载高时达到 running 偏慢（并发用例曾在 ~3s 擦边超时）；
 * 放宽等待预算消除时序抖动，正常情况仍在到达目标状态时立即返回。
 */
export async function waitForStatus(
  manager: SshTunnelManager,
  id: string,
  status: InstanceStatusEvent['status'],
  timeoutMs = 8000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (manager.statusOf(id)?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待状态 ${status} 超时（当前：${manager.statusOf(id)?.status}）`)
}
