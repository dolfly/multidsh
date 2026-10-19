import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { SshInstance } from '@shared/contracts'
import { parseKnownHosts } from '../ssh/host-trust'
import { createSshTunnels } from './ssh-tunnel'
import { makeFakeChild, waitForStatus, type FakeChild } from './ssh-tunnel.testkit'
import type { SpawnedProcess } from './spawn'

// 进程组回收的平台机制在 spawn.test.ts 单测；这里只关心「何时、以何信号回收」。
vi.mock('./spawn', async (importActual) => ({
  ...(await importActual<typeof import('./spawn')>()),
  killProcessGroup: (child: { kill(signal?: NodeJS.Signals): boolean }, signal: NodeJS.Signals) => {
    child.kill(signal)
  }
}))

function sshInstance(overrides: Partial<SshInstance> = {}): SshInstance {
  const ISO = '2026-09-15T00:00:00.000Z'
  return {
    id: randomUUID(),
    name: '隧道实例',
    transport: 'ssh',
    authMode: 'auto',
    host: 'dsh.internal',
    port: 22,
    username: 'dev',
    remotePort: 3080,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  } as SshInstance
}

/**
 * 主机指纹 TOFU 的防线：指纹变化一律拒绝且不改动旧公钥，只有显式「忘记该主机指纹」
 * 之后下一次连接才重新走首次确认。
 */

describe('主机指纹 TOFU', () => {
  it('指纹变化一律拒绝连接且不改动旧公钥;显式「忘记该主机指纹」后才重新 TOFU', async () => {
    //   变化 → 拒绝(即使渲染层回答 trust,旧公钥也一个字节都不改)
    //   → 显式 forgetHostKey → 下一次连接重新走首次 TOFU,确认后才放行。
    const { mkdtemp, readFile, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dataRoot = await mkdtemp(join(tmpdir(), 'hub-t5-forget-'))
    const knownHostsPath = join(dataRoot, 'ssh', 'known_hosts')
    const OLD_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIL/GqayzeH4ALFQzq7BrQ4lodGaiDICVgULWk7rQZ4iw'
    const NEW_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const hostField = '[dsh.internal]:2222'
    // 预置一条「已被取代」的旧公钥
    await mkdir(join(dataRoot, 'ssh'), { recursive: true })
    await writeFile(knownHostsPath, `${hostField} ssh-ed25519 ${OLD_KEY}\n`, { mode: 0o600 })

    // 即使确认回调返回 trust，已变化的指纹仍必须被拒绝。
    const confirmHostKey = vi.fn(async (request: { verdict: string }) => {
      void request
      return 'trust' as const
    })
    const children: FakeChild[] = []
    const spawnImpl = vi.fn(() => {
      const child = makeFakeChild()
      children.push(child)
      return child as unknown as SpawnedProcess
    })
    const manager = createSshTunnels({
      dataRoot,
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      confirmHostKey,
      portProbe: (async () => true) as never,
      // 服务端现在出示新公钥(与已信任的不同 → changed);已信任集合从磁盘真实读取,
      // 「忘记」才有可观测效果
      hostTrustProbe: () => ({
        scan: async () => [{ type: 'ssh-ed25519', blob: NEW_KEY }],
        readTrusted: async () => {
          const content = await readFile(knownHostsPath, 'utf8').catch(() => '')
          return parseKnownHosts(content, hostField)
        }
      })
    })
    const instance = sshInstance({ host: 'dsh.internal', port: 2222 })

    // ① 指纹变化 → 拒绝连接:不 spawn、不 running、旧公钥不被覆盖
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('拒绝连接')
    expect(confirmHostKey).toHaveBeenCalledTimes(1)
    expect(confirmHostKey.mock.calls[0]?.[0]).toMatchObject({ verdict: 'changed' })
    expect(spawnImpl).not.toHaveBeenCalled()
    expect(manager.runningIds()).toEqual([])
    const afterRefusal = await readFile(knownHostsPath, 'utf8')
    expect(afterRefusal).toContain(OLD_KEY) // 旧公钥仍在
    expect(afterRefusal).not.toContain(NEW_KEY) // 新公钥未被写入

    // ② 显式恢复动作(不属于连接确认流程):忘记该主机指纹
    await manager.forgetHostKey(instance)
    const afterForget = await readFile(knownHostsPath, 'utf8')
    expect(afterForget).not.toContain(OLD_KEY)
    expect(afterForget).not.toContain(NEW_KEY)

    // ③ 忘记之后重新连接 = 首次 TOFU:必须再确认一次,确认后才放行
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    expect(confirmHostKey).toHaveBeenCalledTimes(2)
    expect(confirmHostKey.mock.calls[1]?.[0]).toMatchObject({ verdict: 'unknown' })
    expect(spawnImpl).toHaveBeenCalledTimes(1)
    const afterTrust = await readFile(knownHostsPath, 'utf8')
    expect(afterTrust).toContain(NEW_KEY)
    expect(children[0]?.pid).toBeDefined()
  })

  it('首次连接确认后追加写入(unaffected 行保留)', async () => {
    const { mkdtemp, readFile, mkdir, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dataRoot = await mkdtemp(join(tmpdir(), 'hub-t5-append-'))
    const knownHostsPath = join(dataRoot, 'ssh', 'known_hosts')
    const OTHER_HOST_LINE = 'other.host ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHER'
    await mkdir(join(dataRoot, 'ssh'), { recursive: true })
    await writeFile(knownHostsPath, `${OTHER_HOST_LINE}\n`, { mode: 0o600 })

    const NEW_KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    const child = makeFakeChild()
    const manager = createSshTunnels({
      dataRoot,
      spawnImpl: (() => child) as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      confirmHostKey: async () => 'trust' as const,
      portProbe: (async () => true) as never,
      hostTrustProbe: () => ({
        scan: async () => [{ type: 'ssh-ed25519', blob: NEW_KEY }],
        readTrusted: async () => []
      })
    })
    const instance = sshInstance({ host: 'dsh.internal', port: 2222 })
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'running')
    const content = await readFile(knownHostsPath, 'utf8')
    expect(content).toContain(NEW_KEY)
    expect(content).toContain(OTHER_HOST_LINE) // 其他主机条目不受影响
  })

  it('用户拒绝确认 → 隧道不建立且不写 known_hosts', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dataRoot = await mkdtemp(join(tmpdir(), 'hub-t5-reject-'))
    const knownHostsPath = join(dataRoot, 'ssh', 'known_hosts')
    const spawnImpl = vi.fn(() => makeFakeChild() as unknown as SpawnedProcess)
    const manager = createSshTunnels({
      dataRoot,
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      readyTimeoutMs: 2000,
      confirmHostKey: async () => 'reject' as const,
      portProbe: (async () => true) as never,
      hostTrustProbe: () => ({
        scan: async () => [{ type: 'ssh-ed25519', blob: 'AAAAC3NzaC1lZDI1NTE5AAAAINEWNEWNEW' }],
        readTrusted: async () => []
      })
    })
    const instance = sshInstance({ host: 'dsh.internal', port: 2222 })
    await manager.start(instance)
    await waitForStatus(manager, instance.id, 'error')
    expect(manager.statusOf(instance.id)?.detail).toContain('指纹')
    expect(spawnImpl).not.toHaveBeenCalled() // 未确认身份则不 spawn
    await expect(readFile(knownHostsPath, 'utf8')).rejects.toThrow() // 未写入
  })
})
