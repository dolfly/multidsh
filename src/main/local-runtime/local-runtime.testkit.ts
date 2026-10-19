import { vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { InstanceStatusEvent, LocalInstance } from '@shared/contracts'
import type { RuntimeInstaller } from './runtime-installer'
import type { LocalRuntimeManager } from './local-runtime'
import type { SpawnedProcess } from '../transport/spawn'

export const ISO = '2026-09-15T00:00:00.000Z'

export function localInstance(overrides: Partial<LocalInstance> = {}): LocalInstance {
  return {
    id: randomUUID(),
    name: '测试实例',
    transport: 'local',
    authMode: 'auto',
    dshVersion: null,
    port: null,
    profile: null,
    launcher: null,
    useDefaultSpace: false,
    runCommand: null,
    autoStart: false,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides
  }
}

/** 不关心回写的注册表替身；升级用例会先 mockClear 再断言。 */
export const storeStub = { update: vi.fn(async () => localInstance()) }

export interface FakeChild extends SpawnedProcess {
  stdout: PassThrough
  stderr: PassThrough
  emit(event: string, ...args: unknown[]): boolean
  listeners(event: string): unknown[]
  killCall: NodeJS.Signals[]
}

export function makeFakeInstaller(overrides: Partial<RuntimeInstaller> = {}): RuntimeInstaller & {
  install: ReturnType<typeof vi.fn>
  ensureInstalled: ReturnType<typeof vi.fn>
  installGlobal: ReturnType<typeof vi.fn>
} {
  const installed = (): {
    version: string
    dir: string
    entry: string
    installedAt: string
  } => ({
    version: '0.1.5-rc.1',
    dir: '/tmp/runtimes/dsh-0.1.5-rc.1',
    entry: '/tmp/runtimes/dsh-0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js',
    installedAt: ISO
  })
  const base: RuntimeInstaller = {
    listAvailableVersions: async () => ['0.1.5-rc.1'],
    resolveDefaultVersion: async () => '0.1.5-rc.1',
    resolveLatestVersion: async () => '0.1.5-rc.1',
    listInstalled: async () => [],
    isInstalled: async (version) => version === '0.1.5-rc.1',
    install: vi.fn(async () => installed()),
    ensureInstalled: vi.fn(async () => installed()),
    resolveEntry: (version) => `/tmp/runtimes/dsh-${version}/lib/bin.js`,
    hasIncompleteInstall: async () => false,
    resolveGlobalPrefix: async () => null,
    installGlobal: vi.fn(async () => undefined),
    dispose: () => undefined,
    ...overrides
  }
  return base as RuntimeInstaller & {
    install: ReturnType<typeof vi.fn>
    ensureInstalled: ReturnType<typeof vi.fn>
    installGlobal: ReturnType<typeof vi.fn>
  }
}

/** 等待某状态出现(轮询,默认 2s 上限) */
export async function waitForStatus(
  manager: LocalRuntimeManager,
  id: string,
  status: InstanceStatusEvent['status'],
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (manager.statusOf(id)?.status === status) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待状态 ${status} 超时（当前：${manager.statusOf(id)?.status}）`)
}

export function readyLine(port = 31234): string {
  return `dsh web: http://127.0.0.1:${port}/?token=test-token\n`
}
