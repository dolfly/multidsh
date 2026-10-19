/** 主题 / 语言的本地持久化与解析原语（分片间共用）。 */
import { resolveLanguage } from '@shared/settings'
import type { Language, Settings, Theme } from '@shared/settings'
import { createTranslator } from '@shared/i18n'

/** 偏好主题(system/light/dark)解析为实际明暗 */
export function resolveTheme(preference: Theme): 'light' | 'dark' {
  if (preference === 'light' || preference === 'dark') return preference
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function initialTheme(): 'light' | 'dark' {
  const saved = localStorage.getItem('dshhub-theme')
  if (saved === 'light' || saved === 'dark') return saved
  return resolveTheme('system')
}

export function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem('dshhub-theme', theme)
}

/** 侧栏收起态按视图偏好持久化：刷新与 HMR 重置后保留，避免布局在用户没操作时跳变。 */
export function initialRail(): boolean {
  return localStorage.getItem('dshhub-rail') === '1'
}

/** 初始语言:偏好未知时先按系统语言推断,hydrate 后再以主进程为准 */
export function initialLanguage(): Language {
  return resolveLanguage(null, navigator.language)
}

/**
 * 落盘后的设置统一在此应用：解析语言与主题、写入 DOM 主题并派生新的分片状态。
 * `hydrateSettings` 与 `updateSettings` 共用，保证首屏与保存后的状态一致。
 * 返回要合入 store 的片段，DOM 副作用（applyTheme）在此内联执行。
 */
export function derivedSettingsState(
  settings: Settings,
  systemLocale: string
): {
  settings: Settings
  language: Language
  theme: 'light' | 'dark'
  t: ReturnType<typeof createTranslator>
} {
  const theme = resolveTheme(settings.theme)
  const language = resolveLanguage(settings.language, systemLocale)
  applyTheme(theme)
  return { settings, language, theme, t: createTranslator(language) }
}
