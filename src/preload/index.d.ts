import type { DshHubBridge } from '@shared/bridge'

declare global {
  interface Window {
    /** 主进程暴露的受控桥接面（src/preload/index.ts 白名单） */
    dshHub: DshHubBridge
  }
}

export {}
