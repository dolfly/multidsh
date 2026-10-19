import type { InstanceStatusEvent, PatchInstanceInput, Transport } from '@shared/contracts'
import { isExternalRuntime, isHubOwnedRuntime } from '../local-runtime/dsh-source-policy'

/** 回写所需的字段子集(便于测试直接构造,不必凑齐整个事件) */
export interface RuntimeWritebackInput {
  port?: number | undefined
  version?: number | string | undefined
  command?: string | undefined
  runtimeSource?: InstanceStatusEvent['runtimeSource']
}

/**
 * 计算需要持久化的补丁;返回空对象表示**无需回写**(调用方必须据此跳过 update ——
 * store 会拒绝空补丁)。来源判定经 dsh-source-policy,与启动/升级同一词汇。
 */
export function runtimeWritebackPatch(
  event: RuntimeWritebackInput,
  transport: Transport | undefined
): PatchInstanceInput {
  const patch: PatchInstanceInput = {}
  const source = event.runtimeSource

  // 端口:外部接管的端口属于用户进程,不回写(见文件头注释)
  if (event.port !== undefined && !isExternalRuntime(source)) {
    if (transport === 'ssh') patch.localPort = event.port
    else patch.port = event.port
  }

  // 版本:只认 hub 自己安装的运行时;空串视为「未知」同样不回写
  if (typeof event.version === 'string' && event.version !== '' && isHubOwnedRuntime(source)) {
    patch.dshVersion = event.version
  }

  // 启动命令:仅本机实例、hub 自己 spawn 的进程才有;外部接管的命令行不归 hub 决定。
  if (
    typeof event.command === 'string' &&
    event.command !== '' &&
    transport === 'local' &&
    !isExternalRuntime(source)
  ) {
    patch.runCommand = event.command
  }

  return patch
}

/** 补丁是否为空(调用方守卫:空则跳过 store.update,否则 store 抛 invalid-input) */
export function isEmptyPatch(patch: PatchInstanceInput): boolean {
  return Object.keys(patch).length === 0
}
