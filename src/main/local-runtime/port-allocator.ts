/**
 * 本地端口分配原语。
 *
 * 从 start（默认 30000）起递增探测可绑定端口，持久化在实例记录里。
 * 这里只负责「找出一个当前可绑定的端口」；真实监听端口以 dsh 打印的就绪 URL 为准
 * （探测与绑定之间存在 TOCTOU 窗口，故启动后必须回读实际端口）。
 */
import { createServer } from 'node:net'

export const DEFAULT_PORT_RANGE_START = 30000
export const DEFAULT_PORT_RANGE_END = 30999

export type PortProbe = (port: number) => Promise<boolean>

/** 端口是否可绑定（连不上=空闲）。probe 可注入以便测试 */
export const isPortFree: PortProbe = (port) =>
  new Promise<boolean>((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen({ port, host: '127.0.0.1' })
  })

/**
 * 从 start 起递增寻找空闲端口；越界抛错（调用方决定是回退 `--port 0` 还是报错）。
 */
export async function findFreePort(
  options: {
    start?: number
    end?: number
    probe?: PortProbe
  } = {}
): Promise<number> {
  const start = options.start ?? DEFAULT_PORT_RANGE_START
  const end = options.end ?? DEFAULT_PORT_RANGE_END
  const probe = options.probe ?? isPortFree

  for (let port = start; port <= end; port++) {
    if (await probe(port)) return port
  }
  throw new Error(`端口段 ${start}-${end} 内没有可用端口`)
}
