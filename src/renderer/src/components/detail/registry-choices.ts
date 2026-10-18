import type { PluginRegistryOption } from '@shared/contracts'
import type { Translator } from '@shared/i18n'
import type { MessageKey } from '@shared/i18n/messages'
import { REGISTRY_PRESETS } from '@shared/settings'

/**
 * 安装源两档与向导的 registry 预设一一对应（labelKey 是稳定契约）：
 * 档位以枚举传递，URL 只在主进程映射，这里只负责显示向导同款文案。
 */
export const REGISTRY_CHOICES = [
  { value: 'npmmirror', labelKey: REGISTRY_PRESETS[0].labelKey },
  { value: 'npmjs', labelKey: REGISTRY_PRESETS[1].labelKey }
] as const satisfies readonly { value: PluginRegistryOption; labelKey: MessageKey }[]

/** 档位显示文案：确认区徽标与选择器共用；未知档位回落第一档（与选择器兜底一致）。 */
export function registryLabel(t: Translator, option: PluginRegistryOption): string {
  return t(
    REGISTRY_CHOICES.find((choice) => choice.value === option)?.labelKey ?? REGISTRY_CHOICES[0].labelKey
  )
}
