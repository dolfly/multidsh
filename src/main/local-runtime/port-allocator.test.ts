import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { findFreePort, isPortFree } from './port-allocator'

describe('findFreePort', () => {
  it('从起点起递增返回第一个空闲端口', async () => {
    const busy = new Set([30000, 30001])
    const result = await findFreePort({
      start: 30000,
      end: 30010,
      probe: async (port) => !busy.has(port)
    })
    expect(result).toBe(30002)
  })

  it('段内全部繁忙时抛错', async () => {
    await expect(
      findFreePort({ start: 30000, end: 30002, probe: async () => false })
    ).rejects.toThrow(/没有可用端口/)
  })

  it('探针被逐端口调用,无越界调用', async () => {
    const probe = vi.fn(async () => true)
    const result = await findFreePort({ start: 30000, end: 30002, probe })
    expect(result).toBe(30000)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('isPortFree（真实 TCP 探测）', () => {
  it('刚释放的端口返回 true（连不上=空闲）', async () => {
    // 让 OS 挑一个空闲端口,释放后再探测 —— 不依赖特权端口(<1024 会被 EACCES 拒绑)
    const freedPort = await new Promise<number>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen({ port: 0, host: '127.0.0.1' }, () => {
        const address = server.address()
        server.close(() => {
          if (address && typeof address === 'object') resolve(address.port)
          else reject(new Error('未拿到端口'))
        })
      })
    })
    expect(await isPortFree(freedPort)).toBe(true)
  })
})
