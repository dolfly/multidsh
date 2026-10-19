/**
 * 用户层 patch 是否显式关闭了 HMR（用于判断「改动能否热生效」）。
 *
 * dsh 的层叠顺序是「各 bundle 的 patch（按 bundles 顺序）→ profile 的 cordis.patch.yml →
 * $DSH_HOME/cordis.patch.yml → --patch overlay」，按行 id 后者覆盖前者。bundle 层的 patch 里
 * 大量使用 `!!js` 表达式（如 base 的 `disabled: !!js "!ctx.get('profileContext')"`），
 * 求值需要 dsh 的运行时上下文，hub 不复制这套引擎。
 *
 * 这里只做**窄而保守**的一步：在 profile 与 home 这两个「用户自己写的」层里查找
 * `id: hmr` 行的字面量 `disabled: true`——命中即判定该 profile 没有 HMR。
 * 其它情况（含 `!!js` 表达式、找不到该行）一律返回「未判定」，由调用方按 profile 名与
 * bundles 的启发式决定。方向只可能是「把 HMR 判为关」，绝不会反向谎称「已生效」。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** patch 里的行 id 声明：`- id: hmr` 或 `id: hmr`。 */
const ID_HMR = /^(\s*)(-\s*)?id:\s*hmr\s*(?:#.*)?$/
/** 行内的 disabled 赋值。 */
const DISABLED = /^\s*disabled:\s*(\S+)/

/**
 * 在一份 patch 文本里求 `id: hmr` 行的 disabled 字面值。
 * 同一文件内多次声明时取最后一次（与 dsh 的「后者覆盖前者」一致）。
 * @returns true = 显式关闭；false = 显式开启；undefined = 未声明或值不可判定（如 `!!js` 表达式）。
 */
export function hmrDisabledInPatchText(text: string): boolean | undefined {
  const lines = text.split(/\r?\n/)
  let verdict: boolean | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = ID_HMR.exec(line)
    if (match === null) continue
    const leading = match[1] ?? ''
    const isList = match[2] !== undefined
    // 列表项 `- id: hmr` 的键与 id 对齐（缩进 +2），映射键的子键更深一层。
    const keyIndent = leading.length + (isList ? 2 : 0)
    const minIndent = isList ? keyIndent : keyIndent + 1
    let declared: boolean | undefined
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const child = lines[cursor] ?? ''
      const trimmed = child.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const indent = child.length - child.trimStart().length
      if (indent < minIndent) break
      const disabled = DISABLED.exec(child)
      if (disabled === null) continue
      const value = (disabled[1] ?? '')
        .replace(/[#,].*$/, '')
        .trim()
        .toLowerCase()
      if (value === 'true') declared = true
      else if (value === 'false') declared = false
      // 其它值（`!!js ...` 等表达式）无法在不复制 dsh 运行时的前提下求值 → 不判定。
    }
    if (declared !== undefined) verdict = declared
  }
  return verdict
}

async function verdictOf(file: string): Promise<boolean | undefined> {
  try {
    return hmrDisabledInPatchText(await readFile(file, 'utf8'))
  } catch {
    // 文件不存在 / 不可读：该层没有声明。
    return undefined
  }
}

/**
 * profile 层与 home 层是否显式关闭了 HMR（home 层优先，与 dsh 的层叠顺序一致）。
 * 两层都没有可判定的声明时返回 false（未判定，交回启发式）。
 */
export async function userLayerDisablesHmr(profileDir: string, dshHome: string): Promise<boolean> {
  const profileVerdict = await verdictOf(join(profileDir, 'cordis.patch.yml'))
  const homeVerdict = await verdictOf(join(dshHome, 'cordis.patch.yml'))
  return (homeVerdict ?? profileVerdict) === true
}
