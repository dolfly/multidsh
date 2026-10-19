/**
 * npm 安装 spec 的形态分类、拆解与目标版本挑选（纯函数）。
 *
 * 安装源以枚举档位传入，URL 由主进程映射；此处只认 spec 字符串的形态：
 * github/file 交给 pnpm 原样安装，npm 走 registry 解析。版本挑选必须用
 * `compareDshVersions`（数字感知）求最大——versions 数组不保证按版本序排列。
 */
import type { PluginInfo, PluginInstallKind } from '@shared/contracts'
import { compareDshVersions } from './version-compare'

/** spec 形态分类：github/file 交给 pnpm 按原样安装，不做 registry 版本解析。 */
export function classifyPluginSpec(spec: string): PluginInstallKind {
  if (/^(github:|git\+https:\/\/|git@)/.test(spec)) return 'github'
  if (/^file:/.test(spec)) return 'file'
  return 'npm'
}

/** 拆 npm spec 为包名与可选的版本/标签段；scoped 包名的首个 `@` 属于包名。 */
export function splitNpmSpec(spec: string): { name: string; requested: string | null } {
  const at = spec.startsWith('@') ? spec.indexOf('@', 1) : spec.indexOf('@')
  if (at < 0) return { name: spec, requested: null }
  const requested = spec.slice(at + 1)
  return { name: spec.slice(0, at), requested: requested === '' ? null : requested }
}

/** 版本段形态：数字开头或含点 = 精确版本；其余（latest/next/beta…）按 dist-tag 处理。 */
export function isVersionLiteral(requested: string): boolean {
  return /^\d/.test(requested) || requested.includes('.')
}

/** 候选版本里的最大者（数字感知）；空集合返回 null。 */
function maxVersion(versions: readonly string[]): string | null {
  return [...versions].sort(compareDshVersions).at(-1) ?? null
}

/**
 * 选出不带版本段的 npm spec 要安装的版本：dist-tags.latest 与最大稳定版取较大者
 * （dist-tag 滞后时不装旧版），全为预发布时取最大预发布；候选为空回落 dist-tag latest 字段。
 * versions 数组不保证按版本序排列，因此必须用 compareDshVersions 求最大而不是取末位。
 */
export function pickTargetVersion(
  versions: readonly string[],
  latest: string | null,
  fallback: string | null
): string | null {
  const stable = versions.filter((version) => !version.includes('-'))
  const candidates = stable.length > 0 ? [latest, maxVersion(stable)] : [...versions]
  const best = maxVersion(
    candidates.filter((item): item is string => typeof item === 'string' && item !== '')
  )
  return best ?? fallback
}

/** 已装插件列表里同名插件的版本（列表用 '—' 表示版本未知）。 */
export function installedVersionOf(plugins: readonly PluginInfo[], name: string): string | null {
  const version = plugins.find((plugin) => plugin.name === name)?.version
  return version === undefined || version === '—' ? null : version
}

/** spec 是否指向给定包名（近似：spec 前缀去掉 @version / 协议后与包名相等或以其结尾）。 */
export function specMatchesName(spec: string, name: string): boolean {
  const trimmed = spec.trim()
  if (trimmed === name) return true
  // name@version：剥掉版本段（保留 scoped 前缀的 @）。
  const at = trimmed.lastIndexOf('@')
  if (at > 0 && trimmed.slice(0, at) === name) return true
  // github:owner/repo 或 file:path：无法从 spec 精确得包名，宽松匹配结尾。
  return trimmed.endsWith(name)
}
