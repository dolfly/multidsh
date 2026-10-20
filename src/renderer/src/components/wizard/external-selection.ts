import type { ExternalWorkspace } from './types'

/**
 * 注册表里已有的本机实例（只需传输类型与地址）。
 *
 * 传输类型用联合而不是 string：过滤 `transport === 'local'` 时才有类型收窄。
 */
export interface KnownLocalInstance {
  transport: 'local' | 'ssh' | 'http'
  address: string
}

/**
 * 从探测到的外部 dsh 里选出向导要接管的那一个（纯函数）。
 *
 * 探测可能同时返回多个 dsh（用户自己起了几个、别的工具拉起的），而向导一次
 * 只能接管一个，选谁必须确定 —— 不能依赖扫描返回顺序，那随进程启动顺序漂移。
 *
 * 规则：
 * 1. 注册表里已有本机实例、地址与它一致的那个优先（用户此前就在用它）；
 * 2. 其余按端口从小到大取第一个。
 */
export function selectExternalWorkspaces(
  candidates: ExternalWorkspace[],
  knownInstances: KnownLocalInstance[]
): ExternalWorkspace[] {
  const known = new Set(
    knownInstances
      .filter((instance) => instance.transport === 'local')
      .map((instance) => instance.address)
  )
  // 先拷贝再排：sort 原地改数组，会把 React state 里的顺序悄悄改掉
  return [...candidates].sort((a, b) => {
    const aKnown = known.has(`127.0.0.1:${a.port}`) ? 0 : 1
    const bKnown = known.has(`127.0.0.1:${b.port}`) ? 0 : 1
    if (aKnown !== bKnown) return aKnown - bKnown
    return a.port - b.port
  })
}
