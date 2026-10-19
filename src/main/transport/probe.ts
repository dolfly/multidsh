/**
 * 通用健康探测 —— 不 import Electron。
 *
 * 任何传输解析出的端点统一用同一套 HealthyProbe：
 * `GET <endpoint>/`，任意 HTTP 响应（200/302/401）即「传输就绪」；
 * ECONNREFUSED/超时 = 未就绪；进程退出 = 传输死亡（由各传输层自己判定）。
 * 认证层随后再区分 302→/login（网关）与 200（无认证）；探测频率：连接期 500ms。
 */

export type HealthProbe = (url: string, timeoutMs: number) => Promise<boolean>

export const httpHealthProbe: HealthProbe = async (url, timeoutMs) => {
  try {
    // 若跟随重定向,302 到探测面不可达的外部 IdP 会被判「未就绪」→ 隧道被误杀并进入重连死循环
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    })
    return response.status >= 100 && response.status < 600
  } catch {
    return false
  }
}

/** 短暂等待（unref 不挂住进程；探测重试间隔用） */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 反复探测直到成功、次数用尽或 `shouldAbort` 返回 true。
 * 返回 null 表示已中止（调用方自行收尾），否则返回最后一次探测结论。
 *
 * `retries` 由各 transport 注入，默认值统一为 5（本机实例与 HTTP 端点一致）。
 */
export async function retryProbe(options: {
  url: string
  probe: HealthProbe
  /** 总尝试次数，含首次。 */
  retries: number
  /** 相邻两次探测的间隔；用 `sleep`，定时器 unref 不挂住进程。 */
  retryMs: number
  timeoutMs: number
  /** 循环内每次探测前、以及循环结束后各判一次：返回 true 即中止。 */
  shouldAbort: () => boolean
}): Promise<boolean | null> {
  let healthy = false
  for (let attempt = 1; attempt <= options.retries; attempt++) {
    if (options.shouldAbort()) return null
    healthy = await options.probe(options.url, options.timeoutMs)
    if (healthy) break
    if (attempt < options.retries) await sleep(options.retryMs)
  }
  if (options.shouldAbort()) return null
  return healthy
}
