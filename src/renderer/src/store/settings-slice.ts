/** 偏好 / 主题 / i18n 分片。 */
import { DEFAULT_SETTINGS } from '@shared/settings'
import { createTranslator } from '@shared/i18n'
import type { SettingsSlice, SliceCreator } from './types'
import {
  applyTheme,
  derivedSettingsState,
  initialLanguage,
  initialRail,
  initialTheme,
  resolveTheme
} from './theme'

const INITIAL_LANGUAGE = initialLanguage()

/** 系统主题监听的取消函数，避免重复订阅（模块级：与单例 store 同生命周期）。 */
let systemThemeUnsubscribe: (() => void) | null = null

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set, get) => ({
  rail: initialRail(),
  theme: initialTheme(),
  settings: DEFAULT_SETTINGS,
  language: INITIAL_LANGUAGE,
  t: createTranslator(INITIAL_LANGUAGE),
  /** 主进程提供的系统区域设置;hydrate 前用 navigator.language 兜底 */
  systemLocale: navigator.language,

  /**
   * 在 theme='system' 时随系统外观更新实际主题，不改变用户偏好。
   */
  subscribeSystemTheme: () => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return () => undefined
    const onChange = (): void => {
      const state = get()
      if (state.settings.theme !== 'system') return
      const resolved = resolveTheme('system')
      applyTheme(resolved)
      set({ theme: resolved })
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  },

  hydrateSettings: async () => {
    const result = await window.dshHub?.settings.get()
    if (!result?.ok) return
    set(derivedSettingsState(result.value, get().systemLocale))
  },

  updateSettings: async (patch) => {
    const result = await window.dshHub?.settings.update(patch)
    // 让调用方在保存失败时显示错误提示；store 不保留硬编码文案。
    if (!result) throw new Error('settings-unavailable')
    if (!result.ok) throw new Error(result.message)
    set(derivedSettingsState(result.value, get().systemLocale))
  },

  toggleRail: () =>
    set((state) => {
      const rail = !state.rail
      localStorage.setItem('dshhub-rail', rail ? '1' : '0')
      return { rail }
    }),

  toggleTheme: () => {
    // 只改本地状态会让灯箱(设置页高亮)与偏好分叉:重启后 hydrateSettings 会把选择覆盖回去。
    // 因此走 updateSettings(落盘 + 立即生效),本地 applyTheme 由它统一负责。
    // 偏好是 system 时 get().theme 是**已解析**的值;直接持久化会把用户的
    // 「跟随系统」无声改成显式明/暗。这里显式保留 system 语义:先落盘为显式值
    // 是期望行为(用户点了切换),但失败必须可见。
    const next = get().theme === 'light' ? 'dark' : 'light'
    void get()
      .updateSettings({ theme: next })
      .catch(() => {
        get().toast('err', get().t('settings.saveFailed'))
      })
  }
})

/**
 * 应用启动时的偏好水合与系统主题订阅：由 instance slice 的 load() 调用。
 * 重新订阅前先取消旧订阅，避免重复监听。
 */
export async function hydrateAndSubscribeTheme(
  get: () => import('./types').AppState
): Promise<void> {
  await get().hydrateSettings()
  systemThemeUnsubscribe?.()
  systemThemeUnsubscribe = get().subscribeSystemTheme()
  applyTheme(resolveTheme(get().settings.theme))
}
