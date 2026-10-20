/**
 * SSH 隧道的本地端口保留与分配。
 *
 * 一个管理器内多条隧道并发 start 时，`findFreePort` 与「标记已占用」之间存在窗口：
 * 两个实例可能同时把同一端口观察为空闲而双双保留，导致后起的 ssh `-L` 绑定失败。
 * 因此分配全程走同一条串行链（check-then-add 原子），释放只需调用 `release`。
 *
 * 端口可用性 = 未被本管理器保留 + 可绑定（`portProbe` 可注入以替换成测试桩）。
 */
import {
  DEFAULT_PORT_RANGE_END,
  DEFAULT_PORT_RANGE_START,
  findFreePort,
  isPortFree
} from '../local-runtime/port-allocator'
import type { PortProbe } from '../local-runtime/port-allocator'

export interface ReservedPorts {
  /** 该端口当前是否可被本管理器占用。 */
  isAvailable(port: number): Promise<boolean>
  /**
   * 分配并保留一个本地端口：优先沿用调用方给的已持久化端口（被占则从它开始递增），
   * 未给定时从默认区间起始端口开始；越过区间上限则继续向 65535 递进。
   */
  alloc(preferred: number | null): Promise<number>
  /**
   * 换一个本地端口（forward 失败重连用）：先释放旧端口再在区间内找新端口。
   * 必须与 `alloc` 走同一条串行链——否则探测与标记占用之间的窗口里，
   * 另一实例的并发分配会把同一端口观察为空闲而双双保留（重复 `-L` 绑定）。
   */
  realloc(previous: number): Promise<number>
  /** 归还一个端口（条目释放、启动被取消、指纹未确认等路径）。 */
  release(port: number): void
}

export function createReservedPorts(options: { portProbe?: PortProbe } = {}): ReservedPorts {
  const portProbe = options.portProbe
  const reserved = new Set<number>()

  /** 端口可用性 = 未被本管理器保留 + 可绑定（portProbe 可注入）。 */
  async function isAvailable(port: number): Promise<boolean> {
    if (reserved.has(port)) return false
    if (portProbe) return portProbe(port)
    return isPortFree(port)
  }

  async function findAndReserve(start: number, end: number): Promise<number> {
    const port = await findFreePort({ start, end, probe: isAvailable })
    reserved.add(port)
    return port
  }

  /** 分配串行链：保留集的 check-then-add 必须原子，并发分配不得抢到同一端口。 */
  let chain: Promise<unknown> = Promise.resolve()

  /** 把一次分配排进串行链；失败不阻断后续分配。 */
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = chain.then(task)
    chain = next.catch(() => undefined)
    return next
  }

  return {
    isAvailable,

    alloc(preferred) {
      return serialize(async () => {
        if (preferred !== null && (await isAvailable(preferred))) {
          reserved.add(preferred)
          return preferred
        }
        const start = preferred ?? DEFAULT_PORT_RANGE_START
        const end = start > DEFAULT_PORT_RANGE_END ? 65_535 : DEFAULT_PORT_RANGE_END
        return findAndReserve(start, end)
      })
    },

    realloc(previous) {
      return serialize(async () => {
        reserved.delete(previous)
        return findAndReserve(DEFAULT_PORT_RANGE_START, DEFAULT_PORT_RANGE_END)
      })
    },

    release(port) {
      reserved.delete(port)
    }
  }
}
