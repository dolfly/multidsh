/**
 * 版本下拉选项构造（纯函数，便于穷举测试）。
 *
 * registry 列表已按版本从新到旧排序：取前 `limit` 个即「最近 N 个、最新在上」。
 * 本地探测版本与当前选中值若不在其中，追加到末尾 —— 否则默认选中或切回时
 * select 找不到对应 option 会显示空白。
 */
export function buildVersionOptions(
  versions: readonly string[],
  localVersion: string | undefined,
  selected: string,
  limit = 10
): string[] {
  const base = versions.slice(0, limit)
  const extras = [localVersion, selected].filter(
    (value): value is string => value !== undefined && value !== '' && !base.includes(value)
  )
  return [...new Set([...base, ...extras])]
}
