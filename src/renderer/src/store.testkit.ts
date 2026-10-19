import { vi } from 'vitest'
import type { Settings } from '@shared/settings'
import type { VaultStatusSnapshot } from '@shared/contracts'

/**
 * store 测试的浏览器环境桩与动态 import 入口。
 *
 * store.ts 在模块求值时读 window/document/localStorage，Node 下必须先装桩再 import，
 * 故每个用例都经 freshStore() 重置模块与全局后重新导入。
 */

export const DEFAULTS: Settings = {
  language: 'system',
  theme: 'system',
  tray: false,
  autoStart: false,
  notifications: true,
  preventSleepWhenRunning: false,
  workspaceCacheSize: 3,
  inheritShellEnv: true,
  npmRegistry: ''
}

type SettingsResult = { ok: true; value: Settings } | { ok: false; message: string }

let settingsValue: Settings
let updateResult: SettingsResult | null
let updateCalls: Array<Partial<Settings>>
let updateImpl: ((patch: Partial<Settings>) => SettingsResult | Promise<SettingsResult>) | null
let themeListeners: Array<() => void>
/** 订阅/退订**调用次数**(只看存活监听器数量抓不到「读了取消函数却没调用」的泄漏) */
let themeAdds: number
let themeRemoves: number
let matchDark: boolean
let storedTheme: string | null
/** sessionStorage 的内存内容(刷新后恢复视图用)：installGlobals 每次清空，用例可预置。 */
let sessionValues: Record<string, string>
/** vault.status 的返回值；登录成功后就地刷新「凭证存储」依赖它 */
let vaultResult: { ok: true; value: VaultStatusSnapshot } | { ok: false; message: string }

function installGlobals(): void {
  settingsValue = { ...DEFAULTS }
  updateResult = null
  updateCalls = []
  updateImpl = null
  themeListeners = []
  themeAdds = 0
  themeRemoves = 0
  matchDark = false
  storedTheme = null
  sessionValues = {}
  vaultResult = {
    ok: true,
    value: { available: true, degraded: false, rememberedInstances: [], policies: {} }
  }

  const media = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => {
      themeAdds += 1
      themeListeners.push(listener)
    },
    removeEventListener: (_: string, listener: () => void) => {
      themeRemoves += 1
      themeListeners = themeListeners.filter((entry) => entry !== listener)
    }
  }
  Object.defineProperty(media, 'matches', { get: () => matchDark })

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key === 'dshhub-theme' ? storedTheme : null),
    setItem: (key: string, value: string) => {
      if (key === 'dshhub-theme') storedTheme = value
    }
  })
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => sessionValues[key] ?? null,
    setItem: (key: string, value: string) => {
      sessionValues[key] = value
    }
  })
  vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string> } })
  vi.stubGlobal('navigator', { language: 'zh-CN' })
  vi.stubGlobal('window', {
    // window-mode 模块顶层读 location.search 判定「关于」窗口,桩必须提供。
    location: { search: '' },
    matchMedia: () => media,
    dshHub: {
      settings: {
        get: async () => ({ ok: true, value: settingsValue }),
        update: async (patch: Partial<Settings>) => {
          updateCalls.push(patch)
          if (updateImpl) return await updateImpl(patch)
          if (updateResult) return updateResult
          settingsValue = { ...settingsValue, ...patch }
          return { ok: true, value: settingsValue }
        }
      },
      getInfo: async () => ({ ok: false }),
      instances: { list: async () => ({ ok: true, value: [] }) },
      vault: { status: async () => vaultResult }
    }
  })
}

export async function freshStore(): Promise<typeof import('./store').useAppStore> {
  vi.resetModules()
  installGlobals()
  const module = await import('./store')
  return module.useAppStore
}

/**
 * 用例可读写的外部状态。
 *
 * ES 模块的 let 绑定跨模块只读，故以访问器暴露；set 时直接改 testkit 内的变量，
 * 桩闭包读到的就是同一个值。
 */
export const harness = {
  get settingsValue(): Settings {
    return settingsValue
  },
  set settingsValue(next: Settings) {
    settingsValue = next
  },
  get sessionValues(): Record<string, string> {
    return sessionValues
  },
  get vaultResult() {
    return vaultResult
  },
  set vaultResult(next: typeof vaultResult) {
    vaultResult = next
  },
  /** 订阅/退订调用次数：用来抓「读了取消函数却没调用」的监听器泄漏。 */
  get themeAdds(): number {
    return themeAdds
  },
  get themeRemoves(): number {
    return themeRemoves
  },
  get updateCalls(): Array<Partial<Settings>> {
    return updateCalls
  },
  get updateResult(): SettingsResult | null {
    return updateResult
  },
  set updateResult(next: SettingsResult | null) {
    updateResult = next
  },
  get updateImpl() {
    return updateImpl
  },
  set updateImpl(next: typeof updateImpl) {
    updateImpl = next
  },
  get themeListeners(): Array<() => void> {
    return themeListeners
  },
  get matchDark(): boolean {
    return matchDark
  },
  set matchDark(next: boolean) {
    matchDark = next
  },
  get storedTheme(): string | null {
    return storedTheme
  },
  set storedTheme(next: string | null) {
    storedTheme = next
  }
}
