/**
 * 应用设置 —— 纯 schema，不 import electron。
 *
 * 只放**非敏感**偏好，敏感项一律走 vault，两者刻意不混。
 * 落盘在 `<userData>/settings.json`,损坏自愈为默认值(与注册表同一套纪律)。
 */
import { z } from 'zod'

export const LANGUAGES = ['system', 'zh', 'en'] as const
export const THEMES = ['system', 'light', 'dark'] as const

export type LanguagePreference = (typeof LANGUAGES)[number]
export type Language = Exclude<LanguagePreference, 'system'>
export type Theme = (typeof THEMES)[number]

/** npm 镜像预设；labelKey 供渲染层经 i18n 取显示文案。 */
export const REGISTRY_PRESETS = [
  { value: 'https://registry.npmmirror.com', labelKey: 'wizard.registryNpmmirror' },
  { value: 'https://registry.npmjs.org', labelKey: 'wizard.registryNpmjs' }
] as const

/**
 * 插件安装源档位。以**枚举**而非 URL 传递：渲染层无法借 IPC 指定任意源，
 * URL 只在主进程映射（两档与向导预设同值，便于用户对照）。
 */
export const PLUGIN_REGISTRY_OPTIONS = ['npmmirror', 'npmjs'] as const
export type PluginRegistryOption = (typeof PLUGIN_REGISTRY_OPTIONS)[number]

/** 插件安装源默认档位（国内镜像：解析与安装都更快）。 */
export const DEFAULT_PLUGIN_REGISTRY: PluginRegistryOption = 'npmmirror'

/** 档位 → registry URL（唯一映射处；返回值必然是 https，可直接过 isAllowedNpmRegistry）。 */
export function pluginRegistryUrl(option: PluginRegistryOption | null | undefined): string {
  const labelKey = option === 'npmjs' ? 'wizard.registryNpmjs' : 'wizard.registryNpmmirror'
  const match = REGISTRY_PRESETS.find((preset) => preset.labelKey === labelKey)
  return match?.value ?? REGISTRY_PRESETS[0].value
}

/**
 * 设置里的镜像地址 → 预设下拉的取值键：留空为跟随系统，命中预设取预设 URL，其余归自定义。
 * 向导与编辑实例对话框共用（下拉按此键选中对应项）。
 */
export function registryPresetKey(url: string): string {
  if (url === '') return 'system'
  return REGISTRY_PRESETS.some((preset) => preset.value === url) ? url : 'custom'
}

/**
 * 设置里的镜像地址 → 插件命令的默认安装源档位：命中两档预设按对应档位，自定义或留空回落默认档。
 * 插件命令只接受枚举档位（URL 由主进程映射），自定义内网 registry 不参与插件默认源；
 * 单次安装/升级仍可在确认对话框改选预设档位。
 */
export function pluginRegistryFromUrl(url: string): PluginRegistryOption {
  const normalized = url.trim().replace(/\/+$/, '')
  if (normalized === pluginRegistryUrl('npmjs')) return 'npmjs'
  if (normalized === pluginRegistryUrl('npmmirror')) return 'npmmirror'
  return DEFAULT_PLUGIN_REGISTRY
}

/**
 * npm 镜像信任根：registry 自证完整性且执行生命周期脚本，只接受 https；
 * 本地镜像（回环 http）放行。其余协议（file:/ftp:/javascript: 等）一律拒绝。
 */
export function isAllowedNpmRegistry(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol !== 'http:') return false
  return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
}

/**
 * 收敛环境变量提供的 npm 镜像地址：与设置项走同一信任根校验。
 * registry 自证完整性且执行生命周期脚本，明文远程源会重开 MITM → 任意代码路径，
 * 因此非 https（本地回环 http 除外）一律丢弃，返回 undefined 让调用方回落系统 npm 配置。
 */
export function sanitizeEnvRegistry(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  return isAllowedNpmRegistry(trimmed) ? trimmed : undefined
}

export const SettingsSchema = z.object({
  /** 界面语言偏好；system 时解析为 OS locale 对应的 zh|en。 */
  language: z.enum(LANGUAGES).default('system'),
  theme: z.enum(THEMES).default('system'),
  /** 关闭窗口后最小化到托盘而非退出 */
  tray: z.boolean().default(false),
  /** 开机自启 */
  autoStart: z.boolean().default(false),
  /** 实例状态变化弹系统通知 */
  notifications: z.boolean().default(true),
  /** 有本机实例运行时阻止系统空闲休眠（合盖仍休眠，不接管锁屏/熄屏） */
  preventSleepWhenRunning: z.boolean().default(false),
  /** 内嵌工作区 WebContentsView 的 LRU 缓存上限(默认 3,防内存膨胀)。 */
  workspaceCacheSize: z.number().int().min(1).max(10).default(3),
  /** 本机实例继承用户登录 shell 的完整环境（含 .zshrc/.bashrc）；关闭时仅继承 PATH。 */
  inheritShellEnv: z.boolean().default(true),
  /** npm 安装镜像地址；留空跟随系统 npm 配置。只接受 https（本地镜像放行回环 http）。 */
  npmRegistry: z
    .string()
    .trim()
    .refine((value) => value === '' || isAllowedNpmRegistry(value), '镜像地址必须是 https URL')
    .default('')
})

export type Settings = z.infer<typeof SettingsSchema>

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({})

/**
 * 解析实际生效的语言。
 *
 * 偏好是显式 `zh`/`en` 时直接用它;偏好为 `system`、缺失或无法判定时按系统语言推断
 * (中文环境 → zh,其余 → en)。单独抽出来是为了让「系统语言推断」可被穷举单测,
 * 而不是散落在渲染层的三元表达式里。
 */
export function resolveLanguage(preference: LanguagePreference | null | undefined, systemLocale?: string | null): Language {
  if (preference === 'zh' || preference === 'en') return preference
  const locale = (systemLocale ?? '').toLowerCase()
  return locale.startsWith('zh') ? 'zh' : 'en'
}

/**
 * 把未知输入收敛为合法设置:逐字段校验,非法字段回落默认值。
 *
 * 逐字段而非整体失败:设置文件里一个坏字段不该让整份偏好重置
 * (与注册表的「损坏自愈」同精神,但粒度更细)。
 */
export function normalizeSettings(value: unknown): Settings {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_SETTINGS }
  const parsed = SettingsSchema.safeParse(value)
  if (parsed.success) return parsed.data
  const raw = value as Record<string, unknown>
  const pick = <K extends keyof Settings>(key: K): Settings[K] => {
    const single = SettingsSchema.safeParse({ [key]: raw[key] })
    return single.success ? single.data[key] : DEFAULT_SETTINGS[key]
  }
  return {
    language: pick('language'),
    theme: pick('theme'),
    tray: pick('tray'),
    autoStart: pick('autoStart'),
    notifications: pick('notifications'),
    preventSleepWhenRunning: pick('preventSleepWhenRunning'),
    workspaceCacheSize: pick('workspaceCacheSize'),
    inheritShellEnv: pick('inheritShellEnv'),
    npmRegistry: pick('npmRegistry')
  }
}
