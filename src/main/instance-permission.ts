/**
 * 实例分区（`persist:inst-<id>`）的 Chromium 权限策略。
 *
 * 工作区视图（workspace-host）与独立实例窗口（window-host）共享同一分区 session，
 * 而权限 handler 是 session 级的、后安装者覆盖先安装者：两处必须安装同一策略，
 * 否则页面能力是否可用会随打开顺序变化。
 */
import type { Session } from 'electron'

/**
 * 判断实例页面的某项权限是否放行。
 *
 * - 剪贴板写入：dsh web 的复制按钮依赖 navigator.clipboard 写入；读取始终拒绝，
 *   网页无法读取本机剪贴板内容。
 * - media：仅当请求的媒体类型全部为 audio 时放行（dsh web 语音输入的
 *   getUserMedia）；摄像头与音视频混合请求拒绝。
 */
export function isAllowedInstancePermission(
  permission: string,
  mediaTypes: readonly string[] = []
): boolean {
  if (permission === 'clipboard-write' || permission === 'clipboard-sanitized-write') return true
  if (permission === 'media')
    return mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio')
  return false
}

/** 提取 media 权限请求中的媒体类型列表；非 media 请求无此字段。 */
function mediaTypesOf(details: unknown): string[] | undefined {
  const mediaTypes = (details as { mediaTypes?: string[] } | null | undefined)?.mediaTypes
  return Array.isArray(mediaTypes) ? mediaTypes : undefined
}

/** 提取 media 权限检查中的单一媒体类型，归一为列表以便与请求共用判定。 */
function mediaTypeOf(details: unknown): string[] | undefined {
  const mediaType = (details as { mediaType?: string } | null | undefined)?.mediaType
  return mediaType === undefined ? undefined : [mediaType]
}

/** 在实例分区 session 上安装请求与检查两个权限 handler（两者必须成对生效）。 */
export function installInstancePermissionPolicy(session: Session): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(isAllowedInstancePermission(permission, mediaTypesOf(details)))
  )
  session.setPermissionCheckHandler((_contents, permission, _requestingOrigin, details) =>
    isAllowedInstancePermission(permission, mediaTypeOf(details))
  )
}
