/**
 * 进程组存活探测：判断「一组进程是否已全部退出」。
 *
 * 背景（见 docs/adr/0012）：Hub 停止本机实例时，spawn 出去的启动器包装器
 * （dush/duush）会先死，它 spawn 的 dsh 子进程被 reparent 到 init。
 * dsh 收到 SIGTERM 后并不立刻退出 —— 它要走一段异步优雅退出
 * （dispose profile 树），最长 5 秒（dsh 的 PROCESS_SHUTDOWN_TIMEOUT_MS）。
 * 这段时间里 dsh 仍占着工作区端口。
 *
 * 只等「包装器死了」就宣布停止完成，会让 hub 在旧 dsh 还活着时就
 * 重新拉起实例：端口冲突、旧 dsh 被外部探测当成「用户自己的 dsh」。
 * 因此停止语义必须是「整棵进程树排空」。
 *
 * POSIX 下 `detached` spawn 的子进程自成进程组，组号 = 子进程 pid；
 * `kill(-pgid, 0)` 在组内还有成员时返回成功（EPERM 也算存活）。
 */

export interface ProcessGroupProbe {
  /** 进程组是否仍有存活成员。 */
  isAlive(pgid: number): boolean
}

/**
 * POSIX 进程组存活探测。
 *
 * `process.kill(-pgid, 0)` 的语义：向进程组发信号 0（只做存在性与权限检查，
 * 不真的发信号）。组内至少有一个成员存在且可发信号时返回成功。
 * - ESRCH：组内已无成员 → 已排空
 * - EPERM：组内还有成员，只是当前用户无权向其发信号 → 仍算存活
 */
export function isProcessGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // 无权限发信号 ≠ 没有进程：成员还在，只是别人家的。
    if (code === 'EPERM') return true
    return false
  }
}

/**
 * 等待进程组排空。
 *
 * @param pgid 进程组号（POSIX：detached 子进程的 pid）
 * @param options.timeoutMs 等待上限；超时后返回 false（调用方决定是否升级强杀）
 * @param options.intervalMs 轮询间隔
 * @param options.isAlive 存活探测（注入以便测试）；缺省用 POSIX 语义
 */
export async function waitForProcessGroupDrain(
  pgid: number,
  options: {
    timeoutMs: number
    intervalMs?: number
    isAlive?: (pgid: number) => boolean
  }
): Promise<boolean> {
  const probe = options.isAlive ?? isProcessGroupAlive
  const interval = options.intervalMs ?? 50
  const deadline = Date.now() + options.timeoutMs
  // 先查一次：组已排空时不必等一个轮询周期。
  if (!probe(pgid)) return true
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval))
    if (!probe(pgid)) return true
  }
  return !probe(pgid)
}
