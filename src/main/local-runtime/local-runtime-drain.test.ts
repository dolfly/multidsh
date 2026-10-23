/**
 * 停止语义：「整棵进程树排空」才算停干净（见 docs/adr/0012）。
 *
 * 缺陷背景：hub spawn 出去的是启动器包装器（dush/duush），它自己再 spawn 一个
 * dsh 子进程去提供工作区。停止时只等「直接子进程（包装器）退出」：
 *  - 包装器没有 SIGTERM 处理器，收到信号立刻死；
 *  - dsh 子进程被 reparent 到 init，走一段异步优雅退出（最长 5s），期间仍占端口。
 *
 * 于是 stop() 提前宣布完成：重启撞端口，且旧 dsh 会被外部探测当成
 * 「用户自己起的 dsh」上报 —— 详情页弹出「检测到本机已在运行的 dsh web」。
 *
 * 本文件覆盖两件事：
 *  1. 纯函数层：进程组存活探测与排空等待（transport/process-tree）。
 *  2. 真实进程层：用真的「包装器 → dsh」两级进程树，断言 stop() 返回时
 *     整棵树已排空、旧 dsh 不再被外部探测上报。
 */
import { describe, expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalRuntime } from './local-runtime'
import { createExternalDshScanner } from './external-dsh'
import { isProcessGroupAlive, waitForProcessGroupDrain } from '../transport/process-tree'
import type { LocalInstance } from '@shared/contracts'
import type { SpawnedProcess } from '../transport/spawn'

/** 进程组里仍在的成员（pid 列表）。 */
function groupMembers(pgid: number): number[] {
  const out = execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [pid, group] = line.split(/\s+/)
      return { pid: Number(pid), pgid: Number(group) }
    })
    .filter((entry) => entry.pgid === pgid)
    .map((entry) => entry.pid)
}

describe('进程组存活探测', () => {
  it('已排空的进程组判定为不存活', () => {
    // 任意一个几乎不可能存在的 pgid
    expect(isProcessGroupAlive(0x7ffffffe)).toBe(false)
  })

  it('非法 pgid（0 / 负数）判定为不存活，不发信号', () => {
    expect(isProcessGroupAlive(0)).toBe(false)
    expect(isProcessGroupAlive(-1)).toBe(false)
  })

  // ps 是 POSIX 专属命令；Windows 无进程组语义，停止走 taskkill（见 spawn.test.ts）。
  it.skipIf(process.platform === 'win32')('当前进程所在的进程组判定为存活', () => {
    // 当前进程必定在某个进程组里；组号未必等于 pid（由父进程决定）。
    const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], {
      encoding: 'utf8'
    }).trim()
    expect(pgid).not.toBe('')
    expect(isProcessGroupAlive(Number(pgid))).toBe(true)
  })

  it('排空等待：探测立即报告不存活时直接返回', async () => {
    await expect(
      waitForProcessGroupDrain(1, { timeoutMs: 50, isAlive: () => false })
    ).resolves.toBe(true)
  })

  it('排空等待：超时后返回 false（调用方据此升级强杀）', async () => {
    await expect(
      waitForProcessGroupDrain(1, { timeoutMs: 120, intervalMs: 20, isAlive: () => true })
    ).resolves.toBe(false)
  })

  it('排空等待：组在等待期间排空 → 返回 true', async () => {
    let alive = true
    setTimeout(() => {
      alive = false
    }, 60)
    await expect(
      waitForProcessGroupDrain(1, { timeoutMs: 2000, intervalMs: 20, isAlive: () => alive })
    ).resolves.toBe(true)
  })
})

/**
 * 真实进程树：包装器（无 SIGTERM 处理器）→ 假 dsh（有 SIGTERM 处理器，走异步退出）。
 *
 * 夹具必须落在仓库内（AGENTS.md：E2E/测试数据不写死本机路径），故在临时目录里生成。
 */
interface TreeFixture {
  dir: string
  wrapperPath: string
  dshPath: string
}

async function writeTreeFixture(): Promise<TreeFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'hub-drain-'))
  const dshDir = join(dir, 'fake-dsh')
  await mkdir(dshDir, { recursive: true })
  const dshPath = join(dshDir, 'dsh')
  const wrapperPath = join(dir, 'wrapper.mjs')
  // 假 dsh：入口名以 /dsh 结尾（外部探测按 token 结尾识别 dsh 入口），
  // 收到 SIGTERM 后延迟退出，期间继续占着端口 —— 与真实 dsh 的优雅退出同形。
  await writeFile(
    dshPath,
    `import { createServer } from 'node:http'
const server = createServer((_req, res) => { res.writeHead(200); res.end('ok') })
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  console.log('dsh web: http://127.0.0.1:' + port + '/?token=test-token')
})
process.on('SIGTERM', () => {
  setTimeout(() => { server.close(() => process.exit(0)) }, 1500)
})
`,
    'utf8'
  )
  await chmod(dshPath, 0o755)
  // 包装器：spawn 假 dsh 并等它退出；**不注册 SIGTERM 处理器** —— 真实 duush 同形。
  await writeFile(
    wrapperPath,
    `import { spawn } from 'node:child_process'
const child = spawn(process.execPath, [${JSON.stringify(dshPath)}, '--profile', 'web', '--no-open'], { stdio: 'inherit' })
child.on('close', (code) => process.exit(code ?? 0))
`,
    'utf8'
  )
  return { dir, wrapperPath, dshPath }
}

// Windows 无进程组语义：停止走 taskkill /T 同步杀树（spawn.test.ts 覆盖），
// waitForTreeDrain 在 win32 上直接返回 true；本夹具的 ps / 负 pid 断言均不可移植。
// skip 而非删掉：POSIX 下这是「包装器先死、dsh 还活着」缺陷的唯一回归防线。
describe.skipIf(process.platform === 'win32')('停止语义：整棵进程树排空', () => {
  it('stop() 返回时包装器与 dsh 都已退出，旧 dsh 不再被外部探测上报', async () => {
    const fixture = await writeTreeFixture()
    const dataRoot = await mkdtemp(join(tmpdir(), 'hub-drain-data-'))
    const instance: LocalInstance = {
      id: 'drain-1',
      name: '本机',
      transport: 'local',
      authMode: 'auto',
      dshVersion: null,
      port: null,
      profile: null,
      launcher: null,
      useDefaultSpace: true,
      runCommand: null,
      autoStart: false,
      createdAt: '2026-10-21T00:00:00.000Z',
      updatedAt: '2026-10-21T00:00:00.000Z'
    }
    let wrapperPid = 0
    const spawnImpl = (): SpawnedProcess => {
      // detached：包装器自成进程组（组号 = 包装器 pid），与真实 launch 一致。
      const child = spawn(process.execPath, [fixture.wrapperPath], {
        stdio: ['ignore', 'pipe', 'inherit'],
        detached: true
      })
      wrapperPid = child.pid ?? 0
      return child as unknown as SpawnedProcess
    }
    const manager = createLocalRuntime({
      store: { update: async () => instance },
      installer: {
        listAvailableVersions: async () => [],
        resolveDefaultVersion: async () => '0.0.0',
        resolveLatestVersion: async () => '0.0.0',
        listInstalled: async () => [],
        isInstalled: async () => false,
        install: async () => {
          throw new Error('not used')
        },
        ensureInstalled: async () => {
          throw new Error('not used')
        },
        resolveEntry: () => '/x/dsh',
        hasIncompleteInstall: async () => false,
        resolveGlobalPrefix: async () => null,
        installGlobal: async () => undefined,
        dispose: () => undefined
      },
      dataRoot,
      spawnImpl: spawnImpl as never,
      probe: async () => true,
      pathProbe: { probe: async () => ({ command: process.execPath, version: '0.0.0' }) },
      // 不起交互式登录 shell，保持 hermetic。
      loginPath: async () => null,
      shellEnv: async () => null,
      resolveNode: () => process.execPath,
      stopGraceMs: 500
    })

    try {
      const starting = manager.start(instance)
      await starting
      // 就绪后包装器与 dsh 都在跑，dsh 持有工作区端口。
      expect(groupMembers(wrapperPid).length).toBeGreaterThanOrEqual(2)

      await manager.stop(instance.id)

      // 核心断言：stop() 返回时整棵进程树已排空 —— 包装器与 dsh 都没了。
      expect(groupMembers(wrapperPid)).toEqual([])

      // 旧 dsh 不再被外部探测当成「用户自己起的 dsh」上报。
      const scanner = createExternalDshScanner({
        hubPid: process.pid,
        managedPorts: () => manager.managedPorts()
      })
      const found = await scanner.scan()
      expect(found.find((item) => item.pid === wrapperPid)).toBeUndefined()
    } finally {
      try {
        process.kill(-wrapperPid, 'SIGKILL')
      } catch {
        /* 组已排空 */
      }
      await rm(fixture.dir, { recursive: true, force: true })
      await rm(dataRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
