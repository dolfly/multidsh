import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Root } from 'mdast'

/**
 * 发布说明的 Markdown 解析与链接安全判定。
 *
 * 解析用 dsh 同款 micromark/mdast 生态（`mdast-util-from-markdown` + GFM 扩展），
 * 产物是 **mdast 树**；渲染层把节点映射成 React 元素，全程不生成 HTML 字符串、
 * 不走 dangerouslySetInnerHTML，因此正文里的原始 HTML 一律不执行（按文本处理）。
 *
 * 链接策略与 dsh 一致：只有 http(s)/mailto 能成为可点击的 href，其余
 * （`javascript:`、`data:`、`file:`、相对路径）降级为纯文本，不进 DOM 的 href 属性。
 */

/** 可点击链接的协议白名单（与 dsh 渲染层一致）。 */
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

/**
 * 判定链接是否可点击；不可点击时调用方按纯文本渲染。
 * 带凭据的 URL（`https://user:pass@host/`）一并拒绝。
 */
export function safeLinkHref(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!LINK_PROTOCOLS.has(url.protocol)) return null
  if (url.username !== '' || url.password !== '') return null
  return url.toString()
}

/** 解析 Markdown 为 mdast 树。GFM 扩展（表格、删除线、任务列表、自动链接）随附。 */
export function parseReleaseNotes(source: string): Root {
  return fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()]
  })
}
