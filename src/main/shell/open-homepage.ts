import { HOMEPAGE_URL } from '@shared/contracts'

/**
 * 「打开项目主页」的副作用端口 + 装配。
 *
 * 安全要点(与 open-data-dir 同构):通道**不接受任何 URL 参数** —— 目标地址由主进程
 * 从 `HOMEPAGE_URL` 固定,渲染层只能触发「打开」动作本身,结构上不可能被用作
 * 任意协议 / 任意站点打开原语。绝不要给 `open()` 加 URL 参数。
 */

export class HomepageOpenError extends Error {
  constructor(
    readonly code: 'io-error' | 'internal',
    message: string
  ) {
    super(message)
    this.name = 'HomepageOpenError'
  }
}

/** 交给系统默认浏览器打开(生产由 electron `shell.openExternal` 实现,测试用 spy) */
export interface HomepageOpenPorts {
  openExternal(url: string): Promise<void>
}

export interface HomepageOpener {
  /** 打开固定项目主页;无参数(见文件头安全说明) */
  open(): Promise<void>
}

export function createHomepageOpener(ports: HomepageOpenPorts): HomepageOpener {
  return {
    async open(): Promise<void> {
      try {
        await ports.openExternal(HOMEPAGE_URL)
      } catch (error) {
        throw new HomepageOpenError(
          'io-error',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }
}
