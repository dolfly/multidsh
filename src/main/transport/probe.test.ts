import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { httpHealthProbe, retryProbe } from './probe'

const servers: Array<ReturnType<typeof createServer>> = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
})

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  servers.push(server)
  return new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port)
    })
  })
}

describe('httpHealthProbe（）', () => {
  it('200 = 就绪', async () => {
    const port = await listen(
      createServer((_req, res) => {
        res.writeHead(200)
        res.end('ok')
      })
    )
    expect(await httpHealthProbe(`http://127.0.0.1:${port}/`, 1000)).toBe(true)
  })

  it('401 = 就绪（认证层随后再区分）', async () => {
    const port = await listen(
      createServer((_req, res) => {
        res.writeHead(401)
        res.end('unauthorized')
      })
    )
    expect(await httpHealthProbe(`http://127.0.0.1:${port}/`, 1000)).toBe(true)
  })

  it('302 重定向到不可达地址仍算就绪（redirect: manual）', async () => {
    const port = await listen(
      createServer((_req, res) => {
        res.writeHead(302, { Location: 'http://127.0.0.1:1/nowhere' })
        res.end()
      })
    )
    expect(await httpHealthProbe(`http://127.0.0.1:${port}/`, 1000)).toBe(true)
  })

  it('连接被拒 = 未就绪', async () => {
    expect(await httpHealthProbe('http://127.0.0.1:1/', 500)).toBe(false)
  })
})

describe('retryProbe', () => {
  const base = { url: 'http://127.0.0.1:1/', timeoutMs: 10, retryMs: 1 }

  it('首次即就绪：只探测一次', async () => {
    const probe = vi.fn(async () => true)
    await expect(
      retryProbe({ ...base, probe, retries: 5, shouldAbort: () => false })
    ).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('前几次失败后就绪：按次数重试，成功即停', async () => {
    let calls = 0
    const probe = async (): Promise<boolean> => {
      calls += 1
      return calls >= 3
    }
    await expect(
      retryProbe({ ...base, probe, retries: 5, shouldAbort: () => false })
    ).resolves.toBe(true)
    expect(calls).toBe(3)
  })

  it('次数用尽：返回 false 且不多探测', async () => {
    let calls = 0
    const probe = async (): Promise<boolean> => {
      calls += 1
      return false
    }
    await expect(
      retryProbe({ ...base, probe, retries: 3, shouldAbort: () => false })
    ).resolves.toBe(false)
    expect(calls).toBe(3)
  })

  it('循环前已中止：返回 null 且不探测', async () => {
    const probe = vi.fn(async () => true)
    await expect(
      retryProbe({ ...base, probe, retries: 3, shouldAbort: () => true })
    ).resolves.toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('循环结束后才中止：即便已就绪也返回 null', async () => {
    let aborted = false
    const probe = async (): Promise<boolean> => {
      aborted = true
      return true
    }
    await expect(
      retryProbe({ ...base, probe, retries: 3, shouldAbort: () => aborted })
    ).resolves.toBeNull()
  })

  it('末次探测后不再等待（retries=1 不触发重试间隔）', async () => {
    const started = Date.now()
    await retryProbe({
      ...base,
      probe: async () => false,
      retries: 1,
      retryMs: 60_000,
      shouldAbort: () => false
    })
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})
