import { spawn } from 'node:child_process'

export interface SpawnedProcess {
  pid?: number | undefined
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface SpawnInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  detached: boolean
}

export type SpawnLike = (invocation: SpawnInvocation) => SpawnedProcess

export const detachedSpawn: SpawnLike = ({ command, args, env, cwd, detached }) =>
  spawn(command, args, {
    env,
    cwd,
    detached,
    stdio: ['ignore', 'pipe', 'pipe'],
    // windowsHide：Windows 下不弹出控制台窗口（node.exe/ssh.exe 属控制台程序，默认会闪窗）。
    windowsHide: true
  })

/** killProcessGroup 的可注入依赖（默认真实实现）；测试借此在非 win32 宿主上覆盖 win32 分支。 */
export interface KillDeps {
  platform: NodeJS.Platform
  /** 递归终止进程树（win32 走 taskkill）；返回一个可挂 error 处理器的对象。 */
  spawnKiller: (pid: number) => { on(event: 'error', listener: () => void): unknown }
}

const defaultKillDeps: KillDeps = {
  platform: process.platform,
  // windowsHide：taskkill 不弹出控制台窗口。
  spawnKiller: (pid) =>
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

/**
 * 杀整棵进程组。
 * - POSIX：detached 启动使子进程自成进程组，`process.kill(-pid)` 一次带走整组；失败退化为杀直接子进程。
 * - Windows：不支持负 pid 进程组信号，`process.kill` 只终止直接子进程，dsh/ssh 自身 spawn 的子进程会成孤儿。
 *   改用 `taskkill /PID <pid> /T /F` 递归终止整棵进程树（fire-and-forget，失败再退化为 child.kill）。
 */
export function killProcessGroup(
  child: SpawnedProcess,
  signal: NodeJS.Signals,
  deps: KillDeps = defaultKillDeps
): void {
  const pid = child.pid
  if (pid === undefined) return
  const killDirect = (): void => {
    try {
      child.kill(signal)
    } catch {
      /* 已退出 */
    }
  }
  if (deps.platform === 'win32') {
    try {
      // /T 连子进程一并终止；/F 强制。taskkill 不区分信号语义，一律强杀整棵树。
      deps.spawnKiller(pid).on('error', killDirect)
    } catch {
      killDirect()
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    killDirect()
  }
}

/** 等待子进程退出；返回是否在超时内退出 */
export function waitForProcessExit(child: SpawnedProcess, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (exited: boolean): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve(exited)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    child.on('exit', () => finish(true))
  })
}
