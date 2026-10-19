/**
 * `dsh plugin view … --json` 输出的解析与 registry 未收录判定（纯函数）。
 *
 * view 是安装前版本解析（resolveInstall）与升级检查（check）共用的取数通道：
 * 输出形状随查询字段而变——多字段查询嵌套在 `time` 键下，仅查 time 时是裸映射。
 * 解析失败抛 internal（给不出计划时不静默降级）；registry 未收录按 404 识别。
 */
import { InstanceStoreError } from '../registry/instance-store'

/** registry 未收录（与 check 同判据）：pnpm view 对未发布的包/不存在的版本返回 404。 */
export function isRegistryNotFound(error: unknown): boolean {
  return (
    error instanceof InstanceStoreError && /404|Not Found|ERR_PNPM_FETCH_404/i.test(error.message)
  )
}

/** 解析 view 的 JSON 输出；输出不可解析时给不出计划，按内部错误报错。 */
export function parseViewMeta(stdout: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || '{}')
  } catch {
    throw new InstanceStoreError('internal', '无法解析插件版本信息输出')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InstanceStoreError('internal', '无法解析插件版本信息输出')
  }
  return parsed as Record<string, unknown>
}

/** 取 peerDependencies；字段缺失或形态异常按空处理（无约束）。 */
export function peerMapOf(meta: Record<string, unknown>): Record<string, string> {
  const peers = meta.peerDependencies
  return typeof peers === 'object' && peers !== null && !Array.isArray(peers)
    ? (peers as Record<string, string>)
    : {}
}

/** 取字符串数组字段（versions）；空串与非字符串项忽略。 */
export function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : []
}

/** 取对象字段（dist-tags / repository 等）；形态不符按空对象。 */
export function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 发布时间映射里该版本的时刻；缺失或非字符串按 null。 */
export function publishedAtOf(
  timeMap: Record<string, string> | null,
  version: string
): string | null {
  const at = timeMap?.[version]
  return typeof at === 'string' && at !== '' ? at : null
}

/**
 * 解析 `dsh plugin view … time --json` 的输出为「版本 → 发布时刻」映射；解析失败或不是对象返回 null。
 * 输出形状随查询字段而变：多字段查询（check）嵌套在 `time` 键下，仅查 time 时是裸映射
 * （额外含 created/modified 两项，按键取版本值时天然跳过）。
 */
export function publishedTimeMap(stdout: string): Record<string, string> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout || '{}')
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const nested = (parsed as { time?: unknown }).time
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    return nested as Record<string, string>
  }
  return parsed as Record<string, string>
}
