/** `publish.mjs` 的类型声明（发布脚本用 .mjs，供单测导入）。 */

export class PublishError extends Error {}

/** 按分发方式给出「必须出现在 Release 上」的精确资产集合。 */
export function expectedAssets(distribution: string, version: string): string[]

/** 解析 `sha256␠␠文件名` 清单为 Map；形态错误、重复或为空时抛 PublishError。 */
export function parseSums(text: string): Map<string, string>

/**
 * 本地资产校验：windows-unsigned 要求安装包与 SHA256SUMS.txt 齐全且哈希一致，
 * source-only 不需要文件。返回待上传的绝对路径列表。
 */
export function verifyLocalAssets(input: {
  root?: string
  version: string
  distribution: 'source-only' | 'windows-unsigned'
}): Promise<string[]>

/** 本地 tag 决策：缺失创建；存在须正指 HEAD，否则抛 PublishError。 */
export function decideLocalTag(input: {
  hasLocalTag: boolean
  tagSha: string | null
  headSha: string
}): 'create' | 'keep'

/** 远端 tag 推送决策：缺失推送、一致跳过、不一致抛 PublishError。 */
export function decideRemotePush(input: {
  remoteSha: string | null
  localSha: string | null
}): 'push' | 'skip'

/** Release 状态决策：不存在建 draft、draft 更新、已发布抛 PublishError。 */
export function decideDraft(
  release: { id: number; draft: boolean; assets: string[] } | null,
  tag: string
): 'create' | 'update'

/** 远端资产与分发方式声明必须完全一致（多传少传都抛 PublishError）；返回排序后的资产名。 */
export function verifyRemoteAssets(distribution: string, version: string, names: string[]): string[]
