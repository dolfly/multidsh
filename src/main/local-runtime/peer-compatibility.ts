/**
 * dsh 插件 peer 兼容判定与元数据派生的纯原语。
 *
 * 插件用 `peerDependencies["@deepseek-ai/dsh"]` 声明主包要求（dsh-0.1.7-rc.2 起加载器按此做闸），
 * hub 检查升级时需把候选版本的该范围与实例当前 dsh 版本比对。此处只覆盖插件实际用到的范围子集：
 * `>=x`、`>x`、`<=x`、`<x`、`^x`、`~x`、`=x`、裸版本、空格分隔的交集、`||` 分隔的并集。
 * prerelease（`-rc.2` 等）参与比较，比较底层复用 `compareDshVersions`（数字感知）。
 *
 * 刻意不引入 `semver` 运行时依赖（zod 仍是唯一新增运行时依赖）：范围形态有限且可穷举测试。
 */
import { compareDshVersions } from './version-compare'

/** 剥掉版本前缀里的 `v`（`v1.2.3` → `1.2.3`）。 */
function stripV(version: string): string {
  return version.startsWith('v') || version.startsWith('V') ? version.slice(1) : version
}

/** 拆版本为数字段与 prerelease 后缀（`^` / `~` 扩展用）。 */
function splitCore(version: string): { major: number; minor: number; patch: number } {
  const core = version.split('-')[0] ?? version
  const parts = core.split('.')
  return {
    major: Number(parts[0] ?? 0) || 0,
    minor: Number(parts[1] ?? 0) || 0,
    patch: Number(parts[2] ?? 0) || 0
  }
}

/** 把 `^x` / `~x` 展开为等价的 `>=lower <upper` 边界对。 */
function caretTildeBounds(operator: '^' | '~', version: string): { lower: string; upper: string } {
  const { major, minor, patch } = splitCore(version)
  // 显式给出的版本段数与通配段（x/*）决定上界升到哪一段（npm semver 规则）。
  const segments = version.split('-')[0]?.split('.') ?? []
  const partCount = segments.length
  const isWildcard = (part: string | undefined): boolean =>
    part === 'x' || part === 'X' || part === '*'
  if (operator === '~') {
    // ~1.2.3 := >=1.2.3 <1.3.0；~1.2 := >=1.2.0 <1.3.0；~1 := >=1.0.0 <2.0.0
    // patch 不参与上界：~0.0.3 := >=0.0.3 <0.1.0；minor 通配/缺省退到 major 级：~1.x := <2.0.0、~0.x := <1.0.0
    const upper =
      partCount >= 2 && !isWildcard(segments[1]) ? `${major}.${minor + 1}.0` : `${major + 1}.0.0`
    return { lower: version, upper }
  }
  // ^1.2.3 := >=1.2.3 <2.0.0；^0.2.3 := >=0.2.3 <0.3.0；^0.0.3 := >=0.0.3 <0.0.4；
  // ^0.0 / ^0.0.x := >=0.0.0 <0.1.0；^0 / ^0.x := >=0.0.0 <1.0.0
  let upper: string
  if (major > 0) {
    upper = `${major + 1}.0.0`
  } else if (partCount >= 2 && !isWildcard(segments[1])) {
    if (minor > 0) upper = `0.${minor + 1}.0`
    else if (partCount >= 3 && !isWildcard(segments[2])) upper = `0.0.${patch + 1}`
    else upper = '0.1.0'
  } else {
    upper = '1.0.0'
  }
  return { lower: version, upper }
}

/** 单个比较子句（`>=x` / `^x` / 裸版本…）对目标版本是否成立。 */
function satisfiesComparator(comparator: string, target: string): boolean {
  const token = comparator.trim()
  if (token === '' || token === '*' || token === 'x' || token === 'X') return true

  const opMatch = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(token)
  const operator = opMatch?.[1] ?? ''
  const rawVersion = stripV((opMatch?.[2] ?? token).trim())

  if (rawVersion.startsWith('^') || rawVersion.startsWith('~')) {
    const { lower, upper } = caretTildeBounds(
      rawVersion[0] as '^' | '~',
      stripV(rawVersion.slice(1))
    )
    return compareDshVersions(target, lower) >= 0 && compareDshVersions(target, upper) < 0
  }

  const cmp = compareDshVersions(target, rawVersion)
  switch (operator) {
    case '>=':
      return cmp >= 0
    case '<=':
      return cmp <= 0
    case '>':
      return cmp > 0
    case '<':
      return cmp < 0
    case '=':
    case '':
      return cmp === 0
    default:
      return false
  }
}

/**
 * 判定 dsh 版本是否满足 peer 范围。空/缺省范围视为「无约束（满足）」。
 * `||` 分隔的任一子范围成立即成立；子范围内空格分隔的比较子句需全部成立（交集）。
 * 解析异常一律按「不满足」返回 false（宁可提示不兼容，也不误放行升级）。
 */
export function satisfiesDshPeer(
  range: string | null | undefined,
  dshVersion: string | null | undefined
): boolean {
  if (range === null || range === undefined || range.trim() === '') return true
  if (dshVersion === null || dshVersion === undefined || dshVersion.trim() === '') return false
  const target = stripV(dshVersion.trim())
  try {
    return range
      .split('||')
      .map((sub) => sub.trim())
      .some((sub) => {
        if (sub === '') return true
        // 展开 `>=x <y` 里 caret/tilde 与运算符间可能无空格的情形：按空白切子句。
        const comparators = sub.split(/\s+/).filter((token) => token !== '')
        if (comparators.length === 0) return true
        return comparators.every((comparator) => satisfiesComparator(comparator, target))
      })
  } catch {
    return false
  }
}

/** dsh 主包名。 */
const DSH_MAIN_PEER = '@deepseek-ai/dsh'

/** dsh 主包及其子包 peer 名（`@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*`）；dsh 加载器按整套版本闸判定。 */
export function isDshPeerName(name: string): boolean {
  return name === DSH_MAIN_PEER || name.startsWith('@deepseek-ai/dsh-')
}

/**
 * 从 peerDependencies 派生用于展示的 dsh 兼容范围（「兼容版本」字段与不兼容提示共用）。
 * 插件的 dsh 兼容性由主包 `@deepseek-ai/dsh` 与各 `@deepseek-ai/dsh-*` 子包 peer 共同声明；
 * 现代插件常只声明若干锁步一致的子包而不声明主包，只读主包会把范围显示成空（「dsh —」）。
 * 规则：主包已声明则取主包；否则取各 dsh 子包范围——锁步下彼此一致时取该公共范围，
 * 万一不一致则按 peer 名排序去重后以 ` | ` 连接。无任何非空 dsh peer 时返回 null。
 */
export function dshPeerRange(peers: Record<string, string> | null | undefined): string | null {
  if (!peers) return null
  const main = peers[DSH_MAIN_PEER]
  if (typeof main === 'string' && main.trim() !== '') return main.trim()
  const subRanges = Object.entries(peers)
    .filter(
      ([name, range]) => isDshPeerName(name) && typeof range === 'string' && range.trim() !== ''
    )
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, range]) => range.trim())
  if (subRanges.length === 0) return null
  // 锁步下各子包范围一致 → 去重后恰好一项；join 对单项即返回该项本身。
  return [...new Set(subRanges)].join(' | ')
}

/** 不满足运行时版本的 dsh peer 明细（名 → 声明范围）。 */
export type IncompatibleDshPeers = Record<string, string>

/**
 * 评估一份 peerDependencies 里所有 `@deepseek-ai/dsh(-*)` peer 对运行时 dsh 版本的兼容性，
 * 与 dsh 加载器（evaluatePluginCompatibility）同口径：子包版本与 dsh 版本锁步，任一不满足即不兼容。
 * dshVersion 未知时返回全部 dsh peer 为不兼容（无法判定，宁可拦下）。
 * @returns 不满足的 peer 明细；全部满足时返回空对象。
 */
export function evaluateDshPeers(
  peers: Record<string, string> | null | undefined,
  dshVersion: string | null | undefined
): IncompatibleDshPeers {
  const incompatible: IncompatibleDshPeers = {}
  if (!peers) return incompatible
  for (const [name, range] of Object.entries(peers)) {
    if (!isDshPeerName(name)) continue
    if (typeof range !== 'string') continue
    if (!satisfiesDshPeer(range, dshVersion)) incompatible[name] = range
  }
  return incompatible
}

/** 全部 dsh peer 都满足运行时版本才算兼容（检查、安装规划与启用豁免共用同一判据）。 */
export function peersCompatible(peers: Record<string, string>, dshVersion: string): boolean {
  return Object.keys(evaluateDshPeers(peers, dshVersion)).length === 0
}

/** 从 npm `repository` 字段派生 GitHub 网页地址；非 github 或无法解析返回 null。 */
export function githubUrlFrom(repository: unknown): string | null {
  const raw =
    typeof repository === 'string'
      ? repository
      : repository && typeof repository === 'object' && 'url' in repository
        ? String((repository as { url: unknown }).url ?? '')
        : ''
  if (raw === '') return null
  // 归一化：git+https://github.com/a/b.git / git@github.com:a/b.git / github:a/b
  const shorthand = /^github:([^/]+\/[^/#]+)/.exec(raw)
  if (shorthand?.[1]) return `https://github.com/${shorthand[1].replace(/\.git$/, '')}`
  const match = /github\.com[/:]([^/]+\/[^/#?]+?)(?:\.git)?(?:[#?].*)?$/i.exec(raw)
  if (!match?.[1]) return null
  return `https://github.com/${match[1]}`
}

/** npm 包名派生 npm 网页地址；仅接受合法 npm 包名（scoped / unscoped）。 */
export function npmUrlFrom(name: string): string | null {
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return null
  return `https://www.npmjs.com/package/${name}`
}
